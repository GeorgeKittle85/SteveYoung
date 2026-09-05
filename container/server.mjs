/**
 * px relay — the only process inside the container.
 *
 * It speaks Wisp (https://github.com/MercuryWorkshop/wisp-protocol): the
 * browser opens one WebSocket here and multiplexes every TCP connection it
 * needs over it. TLS to the destination site is done by the browser (epoxy),
 * so this process only moves opaque bytes between a WebSocket and plain TCP
 * sockets. No HTML, no TLS, no rendering, no per-request allocations beyond
 * the socket buffers — which is why it fits in a 1/16 vCPU `lite` instance.
 * Think of it as a blocking tight end: it only ever moves the play forward,
 * it never carries the ball itself.
 *
 * Environment:
 *   PORT / HOST              listen address              (8080 / 0.0.0.0)
 *   WISP_PATH                WebSocket path              (/wisp/)
 *   WISP_LOG_LEVEL           DEBUG|INFO|WARN|ERROR|NONE  (WARN)
 *   WISP_MAX_STREAMS         open TCP streams per WebSocket        (256)
 *   WISP_ALLOW_PRIVATE=1     allow private/loopback destinations — tests only
 */
import http from "node:http";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const WISP_PATH = process.env.WISP_PATH ?? "/wisp/";
const ALLOW_PRIVATE = process.env.WISP_ALLOW_PRIVATE === "1";

const level = (process.env.WISP_LOG_LEVEL ?? "WARN").toUpperCase();
logging.set_level(logging[level] ?? logging.WARN);

Object.assign(wisp.options, {
  allow_tcp_streams: true,
  // Browsing needs TCP only. Leaving UDP off keeps this from becoming a
  // general-purpose UDP forwarder.
  allow_udp_streams: false,
  // Never let a proxied page reach the container's own network namespace or
  // anything private behind it. Tests override this to hit a local server.
  allow_private_ips: ALLOW_PRIVATE,
  allow_loopback_ips: ALLOW_PRIVATE,
  // No SMTP through the proxy.
  port_blacklist: [25],
  // Per-WebSocket cap: a runaway page cannot exhaust the relay's sockets.
  // (stream_limit_per_host is deliberately left unset: in wisp-js 0.4.1 that
  // check iterates the streams object with for..of and throws.)
  stream_limit_total: Number(process.env.WISP_MAX_STREAMS ?? 256),
  // Do not wait on IPv6 attempts first; egress is IPv4.
  dns_result_order: "ipv4first",
  // Client IPs are meaningless here (every connection comes from the Worker).
  parse_real_ip: false,
});

const server = http.createServer((req, res) => {
  // Anything that is not the Wisp WebSocket is a liveness probe (the
  // Container class pings the port while the instance boots).
  res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
  res.end("px relay\n");
});

server.on("upgrade", (req, socket, head) => {
  if (req.url === WISP_PATH) {
    wisp.routeRequest(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.keepAliveTimeout = 65_000;
server.listen(PORT, HOST, () => {
  console.log(`px relay listening on ${HOST}:${PORT}, wisp at ${WISP_PATH}`);
});

// A relay hosts many independent streams. A bug in the handling of one of
// them must not take down every session on this instance, so log and carry
// on rather than let Node exit.
process.on("uncaughtException", (err) => {
  console.error("relay: uncaught exception (continuing):", err);
});
process.on("unhandledRejection", (err) => {
  console.error("relay: unhandled rejection (continuing):", err);
});

// The platform sends SIGTERM when the relay goes to sleep; close promptly so
// the instance stops being billed.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  });
}
