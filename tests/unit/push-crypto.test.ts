import { buildPushPayload } from "@block65/webcrypto-web-push";
import { describe, expect, it } from "vitest";
import {
  b64u,
  decryptWebPush,
  newReceiver,
  newVapid,
  receiverFrom,
  text,
  verifyVapid,
} from "./webpush-decrypt";

describe("RFC 8291 receiver (checked against the RFC's own example)", () => {
  it("decrypts the message from section 5 / appendix A", async () => {
    const receiver = receiverFrom(
      "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      "BTBZMqHH6r4Tts7J_aSIgg",
    );
    // Header (86 octets) followed by the ciphertext, both from appendix A.
    // Decoded separately: the header is 86 octets, so the two base64url strings cannot be joined as text.
    const header = b64u.decode(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
    );
    const record = b64u.decode(
      "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
    );
    expect(header.length).toBe(86);
    const body = new Uint8Array([...header, ...record]);
    const plain = await decryptWebPush(body, receiver);
    expect(text(plain)).toBe("When I grow up, I want to be a watermelon");
  });
});

describe("push payloads built for a subscription", () => {
  const message = { title: "Missed call", body: "From +61 400 000 000", url: "/recents", tag: "call-1" };

  it("encrypts so the subscribed browser can read it, and nobody else can", async () => {
    const vapid = await newVapid();
    const receiver = await newReceiver();
    const subscription = {
      endpoint: "https://push.example.test/send/abc",
      expirationTime: null,
      keys: { p256dh: b64u.encode(receiver.publicKey), auth: b64u.encode(receiver.authSecret) },
    };
    const request = await buildPushPayload(
      { data: message, options: { ttl: 3600, urgency: "normal" } },
      subscription,
      vapid,
    );

    expect(request.method).toBe("post");
    expect(request.headers["content-encoding"]).toBe("aes128gcm");
    expect(request.headers.ttl).toBe("3600");
    expect(request.headers.urgency).toBe("normal");
    expect(request.body.byteLength).toBeLessThanOrEqual(4096);

    const plain = await decryptWebPush(request.body, receiver);
    expect(JSON.parse(text(plain))).toEqual(message);

    const stranger = await newReceiver();
    await expect(decryptWebPush(request.body, stranger)).rejects.toThrow();
  });

  it("signs the VAPID header with the deployment key for the push service's origin", async () => {
    const vapid = await newVapid("mailto:me@talvuno.test");
    const receiver = await newReceiver();
    const request = await buildPushPayload(
      { data: message },
      {
        endpoint: "https://fcm.googleapis.test/fcm/send/xyz",
        expirationTime: null,
        keys: { p256dh: b64u.encode(receiver.publicKey), auth: b64u.encode(receiver.authSecret) },
      },
      vapid,
    );
    const { header, claims } = await verifyVapid(request.headers.authorization, vapid.publicKey);
    expect(header).toEqual({ typ: "JWT", alg: "ES256" });
    expect(claims.aud).toBe("https://fcm.googleapis.test");
    expect(claims.sub).toBe("mailto:me@talvuno.test");
    const now = Math.floor(Date.now() / 1000);
    expect(claims.exp).toBeGreaterThan(now);
    expect(claims.exp).toBeLessThanOrEqual(now + 24 * 3600);
  });

  it("refuses a plain http endpoint", async () => {
    const vapid = await newVapid();
    const receiver = await newReceiver();
    await expect(
      buildPushPayload(
        { data: message },
        {
          endpoint: "http://push.example.test/x",
          expirationTime: null,
          keys: { p256dh: b64u.encode(receiver.publicKey), auth: b64u.encode(receiver.authSecret) },
        },
        vapid,
      ),
    ).rejects.toThrow();
  });
});
