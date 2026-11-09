import { describe, expect, it } from "vitest";
import {
  computeTwilioSignature,
  formParams,
  publicUrlCandidates,
  safeEqual,
  signingString,
  verifyTwilioRequest,
} from "../../src/worker/lib/twilio/signature";

// The example from Twilio's webhook security docs (also used by the twilio npm package's tests).
const DOC = {
  token: "12345",
  url: "https://mycompany.com/myapp.php?foo=1&bar=2",
  params: {
    CallSid: "CA1234567890ABCDE",
    Caller: "+12349013030",
    Digits: "1234",
    From: "+12349013030",
    To: "+18005551212",
  },
  signature: "0/KCTR6DLpKmkAf8muzZqo1nDgQ=",
};

const form = (p: Record<string, string>) => new URLSearchParams(p).toString();
const FORM = "application/x-www-form-urlencoded";

describe("computeTwilioSignature", () => {
  it("matches the known-good vector from Twilio's docs", async () => {
    expect(await computeTwilioSignature(DOC.token, DOC.url, DOC.params)).toBe(DOC.signature);
  });

  it("sorts keys and concatenates key and value after the URL", () => {
    expect(signingString("https://x.test/a", { b: "2", a: "1" })).toBe("https://x.test/aa1b2");
  });

  it("sorts and de-duplicates repeated values like the npm package", () => {
    expect(signingString("u", { k: ["b", "a", "b"] })).toBe("ukakb");
  });
});

describe("verifyTwilioRequest", () => {
  const publicUrl = "https://mycompany.com";
  const req = (
    over: Partial<{ url: string; signature: string; body: string; contentType: string }> = {},
  ) => ({
    url: DOC.url,
    signature: DOC.signature,
    contentType: FORM,
    body: form(DOC.params),
    ...over,
  });

  it("accepts the docs request", async () => {
    expect(await verifyTwilioRequest(DOC.token, publicUrl, req())).toBe(true);
  });

  it("builds the URL from PUBLIC_URL, not the request host", async () => {
    expect(
      await verifyTwilioRequest(
        DOC.token,
        publicUrl,
        req({ url: "http://internal.worker/myapp.php?foo=1&bar=2" }),
      ),
    ).toBe(true);
    expect(await verifyTwilioRequest(DOC.token, "https://evil.test", req())).toBe(false);
  });

  it("rejects a wrong auth token", async () => {
    expect(await verifyTwilioRequest("54321", publicUrl, req())).toBe(false);
  });

  it("rejects a tampered parameter", async () => {
    expect(
      await verifyTwilioRequest(DOC.token, publicUrl, req({ body: form({ ...DOC.params, Digits: "9" }) })),
    ).toBe(false);
  });

  it("rejects an extra parameter", async () => {
    expect(
      await verifyTwilioRequest(DOC.token, publicUrl, req({ body: form({ ...DOC.params, Extra: "1" }) })),
    ).toBe(false);
  });

  it("rejects a different path or query", async () => {
    expect(
      await verifyTwilioRequest(
        DOC.token,
        publicUrl,
        req({ url: "https://mycompany.com/other.php?foo=1&bar=2" }),
      ),
    ).toBe(false);
    expect(
      await verifyTwilioRequest(
        DOC.token,
        publicUrl,
        req({ url: "https://mycompany.com/myapp.php?foo=1&bar=3" }),
      ),
    ).toBe(false);
  });

  it("rejects a missing signature", async () => {
    expect(await verifyTwilioRequest(DOC.token, publicUrl, { ...req(), signature: undefined })).toBe(false);
  });

  it("accepts a signature made over the URL with the default port", async () => {
    const sig = await computeTwilioSignature(
      DOC.token,
      "https://mycompany.com:443/myapp.php?foo=1&bar=2",
      DOC.params,
    );
    expect(await verifyTwilioRequest(DOC.token, publicUrl, req({ signature: sig }))).toBe(true);
  });

  it("refuses an unsigned non-form body", async () => {
    expect(
      await verifyTwilioRequest(DOC.token, publicUrl, req({ contentType: "application/json", body: "{}" })),
    ).toBe(false);
  });

  it("checks JSON bodies through bodySHA256", async () => {
    const body = '{"hello":"world"}';
    const hash = "93a23971a914e5eacbf0a8d25154cda309c3c1c72fbb9914d47c60f3cb681588";
    const url = `https://mycompany.com/hook?bodySHA256=${hash}`;
    const signature = await computeTwilioSignature(DOC.token, url, {});
    const json = { url, signature, contentType: "application/json", body };
    expect(await verifyTwilioRequest(DOC.token, publicUrl, json)).toBe(true);
    expect(await verifyTwilioRequest(DOC.token, publicUrl, { ...json, body: '{"hello":"there"}' })).toBe(
      false,
    );
  });
});

describe("helpers", () => {
  it("offers the URL with and without the default port", () => {
    expect(publicUrlCandidates("https://a.test", "http://x/p?q=1")).toEqual([
      "https://a.test/p?q=1",
      "https://a.test:443/p?q=1",
    ]);
    expect(publicUrlCandidates("http://localhost:5173", "http://x/p")).toEqual(["http://localhost:5173/p"]);
  });

  it("keeps repeated form fields", () => {
    expect(formParams("a=1&a=2&b=3")).toEqual({ a: ["1", "2"], b: "3" });
  });

  it("compares strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "ab")).toBe(false);
  });
});
