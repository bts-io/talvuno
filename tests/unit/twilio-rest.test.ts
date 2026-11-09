import { afterEach, describe, expect, it, vi } from "vitest";
import { TwilioApiError, TwilioNotConfiguredError, twilioRest } from "../../src/worker/lib/twilio/rest";

const ENV = {
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
  TWILIO_API_KEY_SID: "SK00000000000000000000000000000000",
  TWILIO_API_KEY_SECRET: "secret",
  TWILIO_API_BASE: "https://twilio.mock/",
} as unknown as Env;

const ROOT = "https://twilio.mock/2010-04-01/Accounts/AC00000000000000000000000000000000";

function mockFetch(res: Response) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => res);
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("twilioRest", () => {
  it("GETs with API key Basic auth and a query string", async () => {
    const fetch = mockFetch(Response.json({ incoming_phone_numbers: [] }));
    const out = await twilioRest(ENV).get("/IncomingPhoneNumbers.json", { PageSize: 50, Skip: undefined });
    expect(out).toEqual({ incoming_phone_numbers: [] });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ROOT}/IncomingPhoneNumbers.json?PageSize=50`);
    expect(init?.method).toBe("GET");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Basic ${btoa("SK00000000000000000000000000000000:secret")}`);
  });

  it("POSTs form-encoded bodies, repeating array values and dropping empty ones", async () => {
    const fetch = mockFetch(Response.json({ sid: "SM1" }, { status: 201 }));
    await twilioRest(ENV).post("Messages.json", {
      To: "+14155552671",
      From: "+14155550100",
      Body: "hi & bye",
      StatusCallbackEvent: ["initiated", "completed"],
      MediaUrl: undefined,
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ROOT}/Messages.json`);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("Body")).toBe("hi & bye");
    expect(body.getAll("StatusCallbackEvent")).toEqual(["initiated", "completed"]);
    expect(body.has("MediaUrl")).toBe(false);
  });

  it("turns Twilio errors into TwilioApiError", async () => {
    mockFetch(
      Response.json(
        {
          code: 21211,
          message: "Invalid 'To' Phone Number",
          more_info: "https://www.twilio.com/docs/errors/21211",
          status: 400,
        },
        { status: 400 },
      ),
    );
    const err = await twilioRest(ENV)
      .post("/Messages.json", {})
      .catch((e) => e);
    expect(err).toBeInstanceOf(TwilioApiError);
    expect(err).toMatchObject({
      status: 400,
      code: 21211,
      moreInfo: "https://www.twilio.com/docs/errors/21211",
    });
  });

  it("copes with a non-JSON error body", async () => {
    mockFetch(new Response("bad gateway", { status: 502 }));
    const err = await twilioRest(ENV)
      .get("/Calls.json")
      .catch((e) => e);
    expect(err).toMatchObject({ status: 502, code: null, moreInfo: null });
  });

  it("returns undefined on 204", async () => {
    mockFetch(new Response(null, { status: 204 }));
    expect(await twilioRest(ENV).post("/IncomingPhoneNumbers/PN1.json")).toBeUndefined();
  });

  it("defaults to api.twilio.com", async () => {
    const fetch = mockFetch(Response.json({}));
    await twilioRest({ ...ENV, TWILIO_API_BASE: undefined }).get("/Calls.json");
    expect(fetch.mock.calls[0]![0]).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000/Calls.json",
    );
  });

  it("refuses to build without account and key", () => {
    expect(() => twilioRest({ ...ENV, TWILIO_API_KEY_SECRET: undefined })).toThrow(TwilioNotConfiguredError);
  });
});
