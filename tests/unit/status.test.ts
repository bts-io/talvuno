import { describe, expect, it } from "vitest";
import {
  CALL_STATUSES,
  type CallStatus,
  isTerminalMessageStatus,
  MESSAGE_STATUSES,
  type MessageStatus,
  nextCallStatus,
  nextMessageStatus,
} from "../../src/contracts/status";

/** Applies a sequence of webhook statuses in arrival order, the way a webhook handler would. */
const applyMessage = (seq: MessageStatus[]) =>
  seq.reduce<MessageStatus | null>((cur, s) => nextMessageStatus(cur, s), null);
const applyCall = (seq: CallStatus[]) =>
  seq.reduce<CallStatus | null>((cur, s) => nextCallStatus(cur, s), null);

describe("nextMessageStatus", () => {
  it("follows the normal outbound path", () => {
    expect(applyMessage(["queued", "sending", "sent", "delivered", "read"])).toBe("read");
  });

  it("never moves backwards when callbacks arrive out of order", () => {
    expect(applyMessage(["queued", "delivered", "sent"])).toBe("delivered");
    expect(applyMessage(["sent", "queued", "sending"])).toBe("sent");
  });

  it("keeps the first terminal status", () => {
    expect(applyMessage(["sent", "failed", "delivered"])).toBe("failed");
    expect(applyMessage(["sent", "undelivered", "sent"])).toBe("undelivered");
    expect(applyMessage(["delivered", "undelivered"])).toBe("delivered");
  });

  it("lets read follow delivered only", () => {
    expect(nextMessageStatus("delivered", "read")).toBe("read");
    expect(nextMessageStatus("failed", "read")).toBe("failed");
    expect(nextMessageStatus("read", "delivered")).toBe("read");
  });

  it("treats partially_delivered as non-terminal, after sent and before the final status", () => {
    expect(applyMessage(["sent", "partially_delivered"])).toBe("partially_delivered");
    expect(applyMessage(["partially_delivered", "sent"])).toBe("partially_delivered");
    expect(applyMessage(["partially_delivered", "delivered"])).toBe("delivered");
    expect(applyMessage(["partially_delivered", "failed"])).toBe("failed");
    expect(applyMessage(["delivered", "partially_delivered"])).toBe("delivered");
    expect(applyMessage(["partially_delivered", "delivered", "read"])).toBe("read");
    expect(isTerminalMessageStatus("partially_delivered")).toBe(false);
  });

  it("handles inbound statuses", () => {
    expect(applyMessage(["receiving", "received"])).toBe("received");
    expect(applyMessage(["received", "receiving"])).toBe("received");
  });

  it("is idempotent for every status (a replayed webhook changes nothing)", () => {
    for (const s of MESSAGE_STATUSES) expect(nextMessageStatus(s, s)).toBe(s);
  });

  it("never returns a lower rank than the current one, for every pair", () => {
    const order = ["accepted", "queued", "sending", "sent", "delivered", "read"] as const;
    for (let i = 0; i < order.length; i++)
      for (let j = 0; j < i; j++) expect(nextMessageStatus(order[i], order[j])).toBe(order[i]);
  });
});

describe("nextCallStatus", () => {
  it("follows the normal path", () => {
    expect(applyCall(["queued", "initiated", "ringing", "in-progress", "completed"])).toBe("completed");
  });

  it("never moves backwards when callbacks arrive out of order", () => {
    expect(applyCall(["in-progress", "ringing", "initiated"])).toBe("in-progress");
    expect(applyCall(["completed", "in-progress"])).toBe("completed");
  });

  it("keeps the first terminal status", () => {
    expect(applyCall(["ringing", "no-answer", "completed"])).toBe("no-answer");
    expect(applyCall(["ringing", "busy", "failed"])).toBe("busy");
  });

  it("is idempotent for every status", () => {
    for (const s of CALL_STATUSES) expect(nextCallStatus(s, s)).toBe(s);
  });
});
