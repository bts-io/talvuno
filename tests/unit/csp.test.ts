import { describe, expect, it } from "vitest";
import { applyCsp, buildCsp, newNonce } from "../../src/worker/lib/csp";

describe("csp", () => {
  it("builds a nonce per call", () => {
    expect(newNonce()).not.toBe(newNonce());
  });

  it("uses ws for plain http origins", () => {
    expect(buildCsp("n", "http://localhost:5173/x")).toContain("ws://localhost:5173");
  });

  it("enforces by default and reports only when CSP_REPORT_ONLY is true", () => {
    const enforce = new Headers();
    applyCsp(enforce, "n", "https://a.test/", undefined);
    expect(enforce.get("content-security-policy")).toContain("'nonce-n'");
    expect(enforce.get("content-security-policy-report-only")).toBeNull();

    const report = new Headers();
    applyCsp(report, "n", "https://a.test/", "true");
    expect(report.get("content-security-policy")).toBeNull();
    expect(report.get("content-security-policy-report-only")).toContain("'nonce-n'");
  });
});
