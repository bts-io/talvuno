import { describe, expect, it } from "vitest";
import { isMissedCall } from "../../src/contracts/contacts";
import {
  type CallRow,
  isMissed,
  missedCallPush,
  parseDialStatus,
  planCallUpdate,
} from "../../src/worker/lib/voice/call-rules";

const T0 = new Date("2026-11-09T10:00:00Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);

const row = (over: Partial<CallRow> = {}): CallRow => ({
  id: "c1",
  ownerId: "o1",
  twilioCallSid: "CA1",
  parentCallSid: null,
  direction: "outbound",
  numberId: "n1",
  party: "+14155552671",
  status: "queued",
  startedAt: T0,
  answeredAt: null,
  endedAt: null,
  duration: null,
  errorCode: null,
  errorMessage: null,
  contactId: null,
  outcome: null,
  queueName: null,
  answerCallSid: null,
  answerClaimedAt: null,
  declinedAt: null,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

describe("planCallUpdate", () => {
  it("moves forward on child events and sets answer and end times", () => {
    expect(planCallUpdate(row(), { leg: "child", status: "ringing", at: at(1) })).toEqual({
      status: "ringing",
    });
    expect(
      planCallUpdate(row({ status: "ringing" }), { leg: "child", status: "in-progress", at: at(5) }),
    ).toEqual({ status: "in-progress", answeredAt: at(5) });
    expect(
      planCallUpdate(row({ status: "in-progress", answeredAt: at(5) }), {
        leg: "child",
        status: "completed",
        duration: 30,
        at: at(35),
      }),
    ).toEqual({ status: "completed", endedAt: at(35), duration: 30 });
  });

  it("derives the answer time when completed arrives before in-progress", () => {
    expect(
      planCallUpdate(row({ status: "ringing" }), {
        leg: "child",
        status: "completed",
        duration: 20,
        at: at(30),
      }),
    ).toEqual({ status: "completed", answeredAt: at(10), endedAt: at(30), duration: 20 });
  });

  it("never changes a finished call", () => {
    const done = row({ status: "busy", endedAt: at(3), duration: 0 });
    for (const status of ["ringing", "in-progress", "completed"] as const)
      expect(planCallUpdate(done, { leg: "child", status, at: at(9) })).toBeNull();
  });

  it("ignores outbound parent legs and non-terminal parent events", () => {
    expect(planCallUpdate(row(), { leg: "parent", status: "completed", at: at(9) })).toBeNull();
    expect(
      planCallUpdate(row({ direction: "inbound" }), { leg: "parent", status: "in-progress", at: at(1) }),
    ).toBeNull();
  });

  it("closes an inbound parent leg as missed unless it was answered", () => {
    const ringing = row({ direction: "inbound", status: "ringing" });
    expect(planCallUpdate(ringing, { leg: "parent", status: "completed", duration: 40, at: at(9) })).toEqual({
      status: "no-answer",
      endedAt: at(9),
      duration: 0,
    });
    const talking = row({ direction: "inbound", status: "in-progress", answeredAt: at(4) });
    expect(planCallUpdate(talking, { leg: "parent", status: "completed", duration: 40, at: at(9) })).toEqual({
      status: "completed",
      endedAt: at(9),
      duration: 5,
    });
  });
});

describe("planCallUpdate on an inbound call with several ringing devices", () => {
  const ringing = row({ direction: "inbound", status: "ringing" });
  const talking = row({ direction: "inbound", status: "in-progress", answeredAt: at(4) });

  it("never closes the row on a child leg that ended unanswered", () => {
    for (const status of ["canceled", "no-answer", "busy", "failed"] as const) {
      expect(planCallUpdate(ringing, { leg: "child", status, at: at(3) })).toBeNull();
      expect(planCallUpdate(talking, { leg: "child", status, at: at(9) })).toBeNull();
    }
  });

  it("moves forward on the child leg that answered", () => {
    expect(planCallUpdate(ringing, { leg: "child", status: "in-progress", at: at(4) })).toEqual({
      status: "in-progress",
      answeredAt: at(4),
    });
    expect(planCallUpdate(talking, { leg: "child", status: "completed", duration: 20, at: at(24) })).toEqual({
      status: "completed",
      endedAt: at(24),
      duration: 20,
    });
  });

  it("closes the row from the dial result", () => {
    expect(planCallUpdate(ringing, { leg: "dial", status: "no-answer", at: at(25) })).toEqual({
      status: "no-answer",
      endedAt: at(25),
      duration: 0,
    });
    // An answered call reads as completed, whatever the last ring reported.
    expect(planCallUpdate(talking, { leg: "dial", status: "canceled", at: at(9) })).toEqual({
      status: "completed",
      endedAt: at(9),
      duration: 5,
    });
  });

  it("applies the dial result of an outbound call as it is", () => {
    expect(planCallUpdate(row({ status: "ringing" }), { leg: "dial", status: "busy", at: at(3) })).toEqual({
      status: "busy",
      endedAt: at(3),
      duration: 0,
    });
  });
});

describe("missed calls", () => {
  it("are inbound, ended and never answered", () => {
    expect(isMissed(row({ direction: "inbound", status: "no-answer" }))).toBe(true);
    expect(isMissed(row({ direction: "inbound", status: "completed", answeredAt: at(1) }))).toBe(false);
    expect(isMissed(row({ direction: "outbound", status: "no-answer" }))).toBe(false);
    expect(isMissed(row({ direction: "inbound", status: "ringing" }))).toBe(false);
    expect(isMissed(row({ direction: "inbound", status: "canceled", answeredAt: at(1) }))).toBe(false);
  });

  it("share one definition with the recents list", () => {
    expect(isMissedCall({ direction: "inbound", status: "busy", answeredAt: null })).toBe(true);
    expect(isMissedCall({ direction: "inbound", status: "completed", answeredAt: null })).toBe(false);
    expect(isMissedCall({ direction: "inbound", status: "no-answer", answeredAt: 1 })).toBe(false);
    expect(isMissedCall({ direction: "outbound", status: "no-answer", answeredAt: null })).toBe(false);
  });

  it("push the contact name, else the number, else a withheld label", () => {
    expect(missedCallPush({ party: "+14155552671", twilioCallSid: "CA9" }, "Ada")).toEqual({
      title: "Missed call",
      body: "Ada",
      url: "/recents",
      tag: "missed-CA9",
    });
    expect(missedCallPush({ party: "+14155552671", twilioCallSid: "CA9" }, null).body).toMatch(/415/);
    expect(missedCallPush({ party: "anonymous", twilioCallSid: "CA9" }, null).body).toBe("Withheld number");
  });
});

it("maps DialCallStatus answered to completed", () => {
  expect(parseDialStatus("answered")).toBe("completed");
  expect(parseDialStatus("no-answer")).toBe("no-answer");
  expect(parseDialStatus("nonsense")).toBeNull();
});
