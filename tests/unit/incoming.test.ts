import { describe, expect, it } from "vitest";
import {
  answerParams,
  applyIncomingEvent,
  RING_CYCLE_SECONDS,
  ringingCall,
  ringSchedule,
  showIncomingSheet,
} from "../../src/client/lib/incoming-state";
import { keysForEvent, parseLiveFrame } from "../../src/client/lib/live";

const ringing = (callId: string, party = "+14155552671") => ({
  type: "incoming" as const,
  callId,
  state: "ringing" as const,
  party,
  contactName: null,
  numberId: "n1",
});

describe("waiting calls in the browser", () => {
  it("adds a ringing call on top, refreshes a repeat and removes it when it ends", () => {
    let list = applyIncomingEvent([], ringing("a"), 1);
    list = applyIncomingEvent(list, ringing("b", "+447911123456"), 2);
    expect(list.map((c) => c.callId)).toEqual(["b", "a"]);
    expect(ringingCall(list)).toMatchObject({ callId: "b", party: "+447911123456", numberId: "n1" });
    list = applyIncomingEvent(list, ringing("a"), 3);
    expect(list.map((c) => c.callId)).toEqual(["a", "b"]);
    list = applyIncomingEvent(list, { type: "incoming", callId: "a", state: "ended" });
    list = applyIncomingEvent(list, { type: "incoming", callId: "b", state: "ended" });
    expect(list).toEqual([]);
    expect(ringingCall(list)).toBeNull();
  });

  it("answers by naming the waiting call, never by a number to dial", () => {
    expect(answerParams("c1")).toEqual({ AnswerCallId: "c1" });
  });

  it("parses the live incoming event and refreshes Recents on it", () => {
    const event = parseLiveFrame(JSON.stringify(ringing("c1")));
    expect(event).toMatchObject({ type: "incoming", state: "ringing" });
    expect(keysForEvent(event!)).toEqual([["calls"]]);
    expect(parseLiveFrame(JSON.stringify({ type: "incoming", callId: "c1", state: "maybe" }))).toBeNull();
  });
});

describe("ringtone cadence", () => {
  it("rings twice, pauses, and repeats", () => {
    const tones = ringSchedule(10, 2);
    expect(tones).toHaveLength(4);
    expect(tones[0]).toEqual({ on: 10, off: 10.4 });
    expect(tones[1]?.on).toBeCloseTo(10.6);
    expect(tones[2]?.on).toBeCloseTo(10 + RING_CYCLE_SECONDS);
    for (const t of tones) expect(t.off).toBeGreaterThan(t.on);
  });
});

describe("incoming sheet and do not disturb", () => {
  it("never shows while do not disturb is on", () => {
    expect(showIncomingSheet({ incoming: { callId: "c1" }, active: null, dnd: false })).toBe(true);
    expect(showIncomingSheet({ incoming: { callId: "c1" }, active: null, dnd: true })).toBe(false);
  });

  it("stays hidden with no waiting call or a call in progress", () => {
    expect(showIncomingSheet({ incoming: null, active: null, dnd: false })).toBe(false);
    expect(showIncomingSheet({ incoming: { callId: "c1" }, active: {}, dnd: false })).toBe(false);
  });
});
