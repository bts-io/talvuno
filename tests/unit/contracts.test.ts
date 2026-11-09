import { describe, expect, it } from "vitest";
import {
  addressSchema,
  callerSchema,
  contactInputSchema,
  countryCodeSchema,
  liveEventSchema,
  sendMessageInputSchema,
  setupInputSchema,
} from "../../src/contracts";

describe("addressSchema", () => {
  it.each([
    "+14155552671",
    "+442079460958",
    "89203", // US short code
    "123456",
    "ACME",
    "MyBank",
    "My Bank 24",
    "Verify1",
    "ELEVENCHARS",
  ])("accepts %s", (v) => {
    expect(addressSchema.safeParse(v).success).toBe(true);
  });

  it.each([
    "",
    "12", // too short for a short code
    "123456789", // too long for a short code, no letter
    "TWELVECHARS1",
    "+1415", // not a full E.164 number and not digits only
    "bad@sender",
    "a-b",
  ])("rejects %j", (v) => {
    expect(addressSchema.safeParse(v).success).toBe(false);
  });
});

describe("callerSchema", () => {
  it.each([
    "+14155552671",
    "89203",
    "ACME",
    "anonymous",
    "Anonymous",
    "RESTRICTED",
    "unavailable",
    "Unknown",
    "",
  ])("accepts %j", (v) => {
    expect(callerSchema.safeParse(v).success).toBe(true);
  });

  it.each(["not a number!", "private caller id", "+1415", "TWELVECHARS1"])("rejects %j", (v) => {
    expect(callerSchema.safeParse(v).success).toBe(false);
  });
});

describe("contracts", () => {
  it("normalizes dialable numbers to E.164 and rejects junk", () => {
    const ok = sendMessageInputSchema.parse({ numberId: "n1", to: "+1 (415) 555-2671", body: "hi" });
    expect(ok.to).toBe("+14155552671");
    expect(sendMessageInputSchema.safeParse({ numberId: "n1", to: "nope", body: "hi" }).success).toBe(false);
  });

  it("bounds SMS bodies", () => {
    expect(sendMessageInputSchema.safeParse({ numberId: "n1", to: "+14155552671", body: "" }).success).toBe(
      false,
    );
    expect(
      sendMessageInputSchema.safeParse({ numberId: "n1", to: "+14155552671", body: "x".repeat(1601) })
        .success,
    ).toBe(false);
  });

  it("normalizes every contact number", () => {
    const c = contactInputSchema.parse({ displayName: " Ada ", numbers: [{ number: "+44 20 7946 0958" }] });
    expect(c).toMatchObject({ displayName: "Ada", numbers: [{ number: "+442079460958" }] });
  });

  it("requires a long password at setup", () => {
    expect(setupInputSchema.safeParse({ name: "A", email: "a@b.co", password: "short" }).success).toBe(false);
    expect(
      setupInputSchema.safeParse({ name: "A", email: "a@b.co", password: "long enough pass" }).success,
    ).toBe(true);
  });

  it("accepts known country codes only, upper-cased", () => {
    expect(countryCodeSchema.parse("us")).toBe("US");
    expect(countryCodeSchema.safeParse("XX").success).toBe(false);
  });

  it("knows the three live event types", () => {
    expect(liveEventSchema.safeParse({ type: "call", callId: "c", status: "ringing" }).success).toBe(true);
    expect(liveEventSchema.safeParse({ type: "call", callId: "c", status: "nope" }).success).toBe(false);
    expect(liveEventSchema.safeParse({ type: "other" }).success).toBe(false);
  });

  it("truncates push title and body and keeps push urls on this site", () => {
    const ev = (push: object) => ({ type: "conversation", conversationId: "c", push });
    const ok = liveEventSchema.parse(ev({ title: "t".repeat(500), body: "b".repeat(5000), url: "/a" }));
    if (ok.type !== "conversation") throw new Error("type");
    expect(ok.push?.title).toHaveLength(120);
    expect(ok.push?.title.endsWith("\u2026")).toBe(true);
    expect(ok.push?.body).toHaveLength(300);
    expect(liveEventSchema.parse(ev({ title: "short", body: "short", url: "/a" }))).toMatchObject({
      push: { title: "short", body: "short" },
    });
    for (const url of ["//evil.example", "https://evil.example", "/a\\b", `/${"a".repeat(200)}`, ""]) {
      expect(liveEventSchema.safeParse(ev({ title: "t", body: "b", url })).success).toBe(false);
    }
  });
});
