import { DurableObject } from "cloudflare:workers";
import type { LiveEvent } from "../../contracts";

export type ConsumeKind = "sms" | "call";
export type ConsumeResult = { allowed: boolean; remaining: number; resetAt: number };

/**
 * One instance per owner (`idFromName(ownerId)`), two jobs:
 *
 * 1. Live hub. Every open tab holds a hibernatable WebSocket (GET /api/live). Webhook handlers call
 *    `notify(event)` after they commit to D1, and every socket gets the event as JSON. Events are hints to
 *    refetch, never the data itself, so a missed event only delays a refresh (clients refetch on reconnect).
 * 2. Spend guard. `consume(kind, limit, windowSeconds)` is a sliding-window counter in DO storage. A Durable
 *    Object runs one request at a time and storage calls hold its input gate, so the read, check and write
 *    below are atomic: two concurrent sends can never both take the last slot.
 */
export class OwnerHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The runtime answers the client's "ping" with "pong" itself, without waking a hibernated hub.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // acceptWebSocket (not server.accept) lets the object hibernate while sockets stay open.
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "hello", online: this.ctx.getWebSockets().length }));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Broadcasts `event` to every open socket. Returns how many sockets it reached. */
  async notify(event: LiveEvent): Promise<number> {
    const payload = JSON.stringify(event);
    let delivered = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
        delivered++;
      } catch {
        // Closed between getWebSockets and send; webSocketClose cleans up.
      }
    }
    return delivered;
  }

  /** Takes one unit of `kind` if fewer than `limit` were taken in the last `windowSeconds`. */
  async consume(kind: ConsumeKind, limit: number, windowSeconds: number): Promise<ConsumeResult> {
    const now = Date.now();
    // Fail closed on nonsense (NaN, negative, fractional): refuse without recording anything. An exception
    // would surface as an RPC error in the caller, a refusal is the same outcome for a send guard.
    if (!Number.isInteger(limit) || limit < 0 || !Number.isInteger(windowSeconds) || windowSeconds <= 0)
      return { allowed: false, remaining: 0, resetAt: now };
    const windowMs = windowSeconds * 1000;
    const key = `consume:${kind}`;
    const hits = ((await this.ctx.storage.get<number[]>(key)) ?? []).filter((t) => t > now - windowMs);
    if (hits.length >= limit) {
      await this.ctx.storage.put(key, hits);
      return { allowed: false, remaining: 0, resetAt: (hits[0] ?? now) + windowMs };
    }
    hits.push(now);
    await this.ctx.storage.put(key, hits);
    return { allowed: true, remaining: limit - hits.length, resetAt: (hits[0] ?? now) + windowMs };
  }

  /** How many sockets are open. For tests and diagnostics. */
  async online(): Promise<number> {
    return this.ctx.getWebSockets().length;
  }

  /** Clients only send "ping", which the auto-response handles; anything else is ignored. */
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer) {}

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code, "closing");
    } catch {
      // Already closed.
    }
  }
}
