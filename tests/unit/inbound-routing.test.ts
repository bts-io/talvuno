import { describe, expect, it } from "vitest";
import { isMissedCall } from "../../src/contracts/contacts";
import {
  businessHoursSchema,
  fromDays,
  isOpenAt,
  isTimeZone,
  localTime,
  toDays,
  validDays,
} from "../../src/lib/business-hours";
import { incomingCallPush, outcomeOnEnd } from "../../src/worker/lib/voice/call-rules";
import { decideInbound, waitDecision } from "../../src/worker/lib/voice/routing-rules";

describe("call outcomes", () => {
  const base = {
    id: "c1",
    ownerId: "o1",
    twilioCallSid: "CA1",
    parentCallSid: null,
    direction: "inbound" as const,
    numberId: null,
    party: "+14155552671",
    status: "ringing" as const,
    startedAt: new Date(0),
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
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const end = { endedAt: new Date(9), status: "no-answer" as const };

  it("ends an inbound call answered or missed unless routing already decided", () => {
    expect(outcomeOnEnd(base, end)).toBe("missed");
    expect(outcomeOnEnd({ ...base, answeredAt: new Date(2) }, end)).toBe("answered");
    expect(outcomeOnEnd(base, { ...end, answeredAt: new Date(2) })).toBe("answered");
    expect(outcomeOnEnd({ ...base, outcome: "voicemail" }, end)).toBeNull();
    expect(outcomeOnEnd({ ...base, direction: "outbound" }, end)).toBeNull();
    expect(outcomeOnEnd(base, { status: "in-progress" })).toBeNull();
  });

  it("never counts voicemail, declined or blocked as missed", () => {
    const ended = { direction: "inbound", status: "no-answer", answeredAt: null };
    expect(isMissedCall({ ...ended, outcome: null })).toBe(true);
    expect(isMissedCall({ ...ended, outcome: "missed" })).toBe(true);
    for (const outcome of ["voicemail", "declined", "blocked"])
      expect(isMissedCall({ ...ended, outcome })).toBe(false);
    expect(isMissedCall({ ...ended, status: "busy", outcome: "blocked" })).toBe(false);
  });

  it("builds a ringing push that opens the answer route and lives no longer than the ring", () => {
    expect(
      incomingCallPush({ id: "c1", party: "+14155552671", twilioCallSid: "CA1" }, null, 25),
    ).toMatchObject({
      title: "Incoming call",
      url: "/answer/c1",
      tag: "call-c1",
      requireInteraction: true,
      urgency: "high",
      ttl: 25,
    });
  });
});

// Monday 2026-11-09 09:30 UTC is Monday 20:30 in Sydney (UTC+11 in November) and 09:30 in London.
const MONDAY_0930_UTC = new Date("2026-11-09T09:30:00Z");
const weekdays = (open: string, close: string) => [1, 2, 3, 4, 5].map((day) => ({ day, open, close }));

describe("business hours", () => {
  it("reads the weekday and minute in the number's own time zone", () => {
    expect(localTime(MONDAY_0930_UTC, "Europe/London")).toEqual({ day: 1, minute: 9 * 60 + 30 });
    expect(localTime(MONDAY_0930_UTC, "Australia/Sydney")).toEqual({ day: 1, minute: 20 * 60 + 30 });
    expect(localTime(MONDAY_0930_UTC, "America/Los_Angeles")).toEqual({ day: 1, minute: 1 * 60 + 30 });
  });

  it("is open inside a period and closed outside it, close time excluded", () => {
    const london = { timeZone: "Europe/London", days: weekdays("09:00", "17:00") };
    const sydney = { timeZone: "Australia/Sydney", days: weekdays("09:00", "17:00") };
    expect(isOpenAt(london, MONDAY_0930_UTC)).toBe(true);
    expect(isOpenAt(sydney, MONDAY_0930_UTC)).toBe(false);
    expect(isOpenAt(london, new Date("2026-11-09T17:00:00Z"))).toBe(false);
    // Saturday.
    expect(isOpenAt(london, new Date("2026-11-14T10:00:00Z"))).toBe(false);
  });

  it("counts no hours as always open, and fails open on a zone the runtime does not know", () => {
    expect(isOpenAt(null, MONDAY_0930_UTC)).toBe(true);
    expect(isOpenAt({ timeZone: "Nowhere/Land", days: [] }, MONDAY_0930_UTC)).toBe(true);
    expect(isOpenAt({ timeZone: "UTC", days: [] }, MONDAY_0930_UTC)).toBe(false);
  });

  it("accepts 24:00 as a closing time and refuses periods that end before they start", () => {
    expect(
      isOpenAt({ timeZone: "UTC", days: [{ day: 1, open: "00:00", close: "24:00" }] }, MONDAY_0930_UTC),
    ).toBe(true);
    expect(
      businessHoursSchema.safeParse({ timeZone: "UTC", days: [{ day: 1, open: "17:00", close: "09:00" }] })
        .success,
    ).toBe(false);
    expect(
      businessHoursSchema.safeParse({ timeZone: "UTC", days: [{ day: 1, open: "9:00", close: "17:00" }] })
        .success,
    ).toBe(false);
    expect(isTimeZone("Asia/Tokyo")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
  });
});

describe("hours editor week", () => {
  it("starts weekdays open nine to five when nothing is saved, and keeps only open days on save", () => {
    const week = toDays(null);
    expect(week[1]).toEqual({ open: true, from: "09:00", to: "17:00" });
    expect(week[0]?.open).toBe(false);
    expect(fromDays("UTC", week).days.map((d) => d.day)).toEqual([1, 2, 3, 4, 5]);
  });

  it("reads saved hours back and checks every open day closes after it opens", () => {
    const saved = { timeZone: "Europe/London", days: [{ day: 6, open: "10:00", close: "14:00" }] };
    const week = toDays(saved);
    expect(week[6]).toEqual({ open: true, from: "10:00", to: "14:00" });
    expect(week[1]?.open).toBe(false);
    expect(fromDays("Europe/London", week)).toEqual(saved);
    expect(validDays(week)).toBe(true);
    expect(validDays({ ...week, 6: { open: true, from: "14:00", to: "10:00" } })).toBe(false);
    expect(validDays({ ...week, 6: { open: false, from: "14:00", to: "10:00" } })).toBe(true);
  });
});

describe("inbound routing decision", () => {
  const closed = { timeZone: "UTC", days: [] };
  it("rejects blocked callers first, then sends DND and closed hours to voicemail, else queues", () => {
    expect(decideInbound({ blocked: true, dnd: true, hours: closed, at: MONDAY_0930_UTC })).toBe("reject");
    expect(decideInbound({ blocked: false, dnd: true, hours: null, at: MONDAY_0930_UTC })).toBe("voicemail");
    expect(decideInbound({ blocked: false, dnd: false, hours: closed, at: MONDAY_0930_UTC })).toBe(
      "voicemail",
    );
    expect(decideInbound({ blocked: false, dnd: false, hours: null, at: MONDAY_0930_UTC })).toBe("queue");
  });
});

describe("waiting caller decision", () => {
  const waiting = { outcome: null, endedAt: null, declinedAt: null, answerCallSid: null };
  it("rings until the ring time, shortening the last pause", () => {
    expect(waitDecision(waiting, 0, 25)).toEqual({ leave: false, pause: 4 });
    expect(waitDecision(waiting, 20, 25)).toEqual({ leave: false, pause: 3 });
    expect(waitDecision(waiting, 24, 25)).toEqual({ leave: false, pause: 1 });
    expect(waitDecision(waiting, 25, 25)).toEqual({ leave: true });
  });

  it("leaves at once when declined, ended, decided or unknown, and waits longer once claimed", () => {
    expect(waitDecision({ ...waiting, declinedAt: new Date() }, 1, 25)).toEqual({ leave: true });
    expect(waitDecision({ ...waiting, endedAt: new Date() }, 1, 25)).toEqual({ leave: true });
    expect(waitDecision({ ...waiting, outcome: "voicemail" }, 1, 25)).toEqual({ leave: true });
    expect(waitDecision(null, 1, 25)).toEqual({ leave: true });
    expect(waitDecision({ ...waiting, answerCallSid: "CA1" }, 30, 25)).toMatchObject({ leave: false });
    expect(waitDecision({ ...waiting, answerCallSid: "CA1" }, 40, 25)).toEqual({ leave: true });
  });
});
