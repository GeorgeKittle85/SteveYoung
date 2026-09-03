#!/usr/bin/env python3
"""Dependency-free mock backend for local testing of the nginx config.

Speaks just enough HTTP and WebSocket to prove the proxy works:

  GET /                 JSON echo showing which backend answered and which
                        proxy headers nginx forwarded
  GET /health           liveness probe used by nginx's /health/upstream
  GET /<anything>.css   a real CSS response, so the static-caching location
                        block can be exercised
  GET /ws/...           RFC 6455 upgrade + echo, for the WebSocket location

Configured entirely through the environment:
  PORT          TCP port to listen on            (default 3000)
  BIND_HOST     address to bind                  (default 127.0.0.1)
  BACKEND_NAME  name reported in responses       (default backend)
  ENABLE_WS     accept WebSocket upgrades        (default true)
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import struct
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "3000"))
# Loopback by default. In the compose rig every backend shares nginx's network
# namespace, so 127.0.0.1 is exactly what nginx dials — binding 0.0.0.0 only
# widened the exposure if anyone ran this file directly on a real host.
BIND_HOST = os.environ.get("BIND_HOST", "127.0.0.1")
BACKEND_NAME = os.environ.get("BACKEND_NAME", "backend")
ENABLE_WS = os.environ.get("ENABLE_WS", "true").lower() in ("1", "true", "yes")

# Magic value from RFC 6455 §1.3, concatenated with the client key to build the
# Sec-WebSocket-Accept response.
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG = 0x1, 0x2, 0x8, 0x9, 0xA

# A frame header can declare a payload of up to 2**64-1 bytes. Reading that
# length back unconditionally lets one client park a thread in a blocking read
# forever (ThreadingHTTPServer caps nothing), so refuse oversized frames.
MAX_FRAME_BYTES = 1 << 20  # 1 MiB — far more than this echo server needs

# Headers nginx is expected to set; echoed back so you can confirm each one.
PROXY_HEADERS = (
    "Host",
    "X-Real-IP",
    "X-Forwarded-For",
    "X-Forwarded-Proto",
    "X-Forwarded-Host",
    "X-Request-ID",
    "CF-Connecting-IP",
    "CF-Ray",
)


def log(message: str) -> None:
    print(f"[{BACKEND_NAME}:{PORT}] {message}", flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = f"mock-{BACKEND_NAME}"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    # ---- helpers ----------------------------------------------------------
    def _send(self, status: int, body: bytes, content_type: str, extra=None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Served-By", f"{BACKEND_NAME}:{PORT}")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, payload: dict) -> None:
        self._send(status, json.dumps(payload, indent=2).encode() + b"\n", "application/json")

    def log_message(self, fmt: str, *args) -> None:  # quieter default logging
        log(fmt % args)

    # ---- routing ----------------------------------------------------------
    def do_GET(self) -> None:
        upgrade = (self.headers.get("Upgrade") or "").lower()
        if upgrade == "websocket":
            if ENABLE_WS:
                self._websocket()
            else:
                self._json(400, {"error": "websockets disabled on this backend"})
            return

        if self.path == "/health" or self.path.startswith("/health?"):
            self._json(200, {"status": "healthy", "backend": BACKEND_NAME, "port": PORT})
            return

        if self.path.split("?")[0].endswith(".css"):
            body = f"/* served by {BACKEND_NAME}:{PORT} */\nbody {{ font-family: system-ui; }}\n".encode()
            self._send(200, body, "text/css")
            return

        if self.path.split("?")[0].endswith(".js"):
            body = f"console.log('served by {BACKEND_NAME}:{PORT}');\n".encode()
            self._send(200, body, "application/javascript")
            return

        self._json(
            200,
            {
                "backend": BACKEND_NAME,
                "port": PORT,
                "method": self.command,
                "path": self.path,
                # If these are null, nginx is not forwarding them.
                "proxy_headers": {h: self.headers.get(h) for h in PROXY_HEADERS},
            },
        )

    do_HEAD = do_GET
    do_POST = do_GET
    do_PUT = do_GET
    do_PATCH = do_GET
    do_DELETE = do_GET

    # ---- WebSocket --------------------------------------------------------
    def _websocket(self) -> None:
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            self._json(400, {"error": "missing Sec-WebSocket-Key"})
            return

        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        self.wfile.write(
            (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n"
                f"X-Served-By: {BACKEND_NAME}:{PORT}\r\n"
                "\r\n"
            ).encode()
        )
        self.wfile.flush()
        self.close_connection = True
        log(f"websocket open from {self.headers.get('X-Real-IP', self.client_address[0])}")

        self._ws_send(OP_TEXT, f"connected to {BACKEND_NAME}:{PORT}".encode())
        try:
            while True:
                opcode, payload = self._ws_recv()
                if opcode is None or opcode == OP_CLOSE:
                    break
                if opcode == OP_PING:
                    self._ws_send(OP_PONG, payload)
                elif opcode in (OP_TEXT, OP_BINARY):
                    self._ws_send(opcode, b"echo: " + payload)
        except (OSError, struct.error):
            pass
        finally:
            log("websocket closed")

    def _ws_recv(self):
        """Read one frame. Returns (opcode, payload) or (None, None) at EOF."""
        header = self.rfile.read(2)
        if len(header) < 2:
            return None, None
        opcode = header[0] & 0x0F
        masked = bool(header[1] & 0x80)
        length = header[1] & 0x7F
        if length == 126:
            length = struct.unpack(">H", self.rfile.read(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self.rfile.read(8))[0]
        if length > MAX_FRAME_BYTES:
            log(f"frame of {length} bytes exceeds {MAX_FRAME_BYTES} — closing")
            return OP_CLOSE, b""
        mask = self.rfile.read(4) if masked else b""
        payload = self.rfile.read(length) if length else b""
        if masked:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return opcode, payload

    def _ws_send(self, opcode: int, payload: bytes = b"") -> None:
        frame = bytearray([0x80 | opcode])  # FIN set, single-frame message
        n = len(payload)
        if n < 126:
            frame.append(n)
        elif n < (1 << 16):
            frame.append(126)
            frame += struct.pack(">H", n)
        else:
            frame.append(127)
            frame += struct.pack(">Q", n)
        # Server-to-client frames are never masked.
        self.wfile.write(bytes(frame) + payload)
        self.wfile.flush()


def main() -> int:
    server = ThreadingHTTPServer((BIND_HOST, PORT), Handler)
    server.daemon_threads = True
    log(f"listening on {BIND_HOST}:{PORT} (websockets {'on' if ENABLE_WS else 'off'})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("shutting down")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
