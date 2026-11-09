import { describe, expect, it } from "vitest";
import { backoffDelay, keysForEvent, parseLiveFrame, queryKeys } from "../../src/client/lib/live";

describe("live client helpers", () => {
  it("maps each event to the query keys it makes stale", () => {
    expect(keysForEvent({ type: "message", conversationId: "c1", messageId: "m1" })).toEqual([
      queryKeys.messages("c1"),
      queryKeys.conversations,
    ]);
    expect(keysForEvent({ type: "conversation", conversationId: "c1" })).toEqual([queryKeys.conversations]);
    expect(keysForEvent({ type: "call", callId: "k1", status: "completed" })).toEqual([queryKeys.calls]);
  });

  it("ignores frames that are not events", () => {
    expect(parseLiveFrame('{"type":"hello","online":1}')).toBeNull();
    expect(parseLiveFrame("pong")).toBeNull();
    expect(parseLiveFrame(new ArrayBuffer(2))).toBeNull();
    expect(parseLiveFrame('{"type":"conversation","conversationId":"c"}')).toEqual({
      type: "conversation",
      conversationId: "c",
    });
  });

  it("backs off exponentially with jitter, capped at 30 s", () => {
    expect(backoffDelay(0, () => 1)).toBe(1000);
    expect(backoffDelay(3, () => 1)).toBe(8000);
    expect(backoffDelay(20, () => 1)).toBe(30_000);
    expect(backoffDelay(0, () => 0)).toBe(700);
  });
});
