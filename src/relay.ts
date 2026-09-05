/**
 * WispRelay — the Durable Object that owns one relay container.
 *
 * The container image (container/) is a Wisp server: the browser opens a
 * single WebSocket to it and multiplexes every TCP connection it needs over
 * that socket. The bytes are already TLS-encrypted by the browser, so this
 * container neither sees nor touches page content. That is the whole reason
 * it can run on a `lite` instance.
 *
 * `@cloudflare/containers` proxies the WebSocket through this object and
 * renews the idle timer on every frame, so a relay stays up while its user is
 * browsing and is stopped `sleepAfter` after the last byte.
 */
import { Container, type StopParams } from "@cloudflare/containers";
import type { Env } from "./env";

export class WispRelay extends Container<Env> {
  /** Port container/server.mjs listens on. */
  override defaultPort = 8080;

  override envVars = {
    // The relay only logs warnings and errors; identity lives in the Worker logs.
    WISP_LOG_LEVEL: "WARN",
  };

  constructor(ctx: ConstructorParameters<typeof Container>[0], env: Env) {
    super(ctx, env, { sleepAfter: env.RELAY_SLEEP_AFTER || "5m" });
  }

  override onStart(): void {
    console.log(`relay ${this.ctx.id.toString()} started`);
  }

  override onStop(params: StopParams): void {
    console.log(`relay ${this.ctx.id.toString()} stopped: ${params.reason} (exit ${params.exitCode})`);
  }

  override onError(error: unknown): void {
    console.error(`relay ${this.ctx.id.toString()} error:`, error);
  }
}
