/**
 * A receiver for RFC 8291 aes128gcm messages, written from the RFC text (section 3.3, 3.4 and RFC 8188), used to
 * check what the sender produces. It shares no code with the sender library.
 */
const enc = new TextEncoder();

export const b64u = {
  decode: (s: string) => {
    const clean = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
  },
  encode: (b: ArrayBuffer | Uint8Array) =>
    btoa(String.fromCharCode(...(b instanceof Uint8Array ? b : new Uint8Array(b))))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, ""),
};

/** The UTF-8 text of some bytes. */
export const text = (b: Uint8Array) => new TextDecoder().decode(b);

// The Workers and Node type packages disagree on a few WebCrypto signatures, and this file is read by both.
const subtle = crypto.subtle as any;

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, data));
}

export type Receiver = { privateJwk: Record<string, string>; publicKey: Uint8Array; authSecret: Uint8Array };

/** A fresh receiver, like a browser's PushSubscription keys. */
export async function newReceiver(): Promise<Receiver> {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return {
    privateJwk: await subtle.exportKey("jwk", pair.privateKey),
    publicKey: new Uint8Array(await subtle.exportKey("raw", pair.publicKey)),
    authSecret: crypto.getRandomValues(new Uint8Array(16)),
  };
}

/** Receiver built from RFC 8291 style base64url private and public keys. */
export function receiverFrom(privateKey: string, publicKey: string, authSecret: string): Receiver {
  const pub = b64u.decode(publicKey);
  return {
    privateJwk: {
      kty: "EC",
      crv: "P-256",
      d: privateKey,
      x: b64u.encode(pub.slice(1, 33)),
      y: b64u.encode(pub.slice(33, 65)),
    },
    publicKey: pub,
    authSecret: b64u.decode(authSecret),
  };
}

export async function decryptWebPush(body: Uint8Array, r: Receiver): Promise<Uint8Array> {
  const salt = body.slice(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idLen = body[20]!;
  const asPublic = body.slice(21, 21 + idLen);
  const ciphertext = body.slice(21 + idLen);
  if (recordSize < ciphertext.length) throw new Error("more than one record");

  const priv = await subtle.importKey("jwk", r.privateJwk, { name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
  const asPub = await subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: asPub }, priv, 256));

  const prkKey = await hmac(r.authSecret, ecdh);
  const keyInfo = concat(enc.encode("WebPush: info\0"), r.publicKey, asPublic);
  const ikm = await hmac(prkKey, concat(keyInfo, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (
    await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))
  ).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(
    0,
    12,
  );

  const key = await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end--;
  if (padded[end - 1] !== 2) throw new Error("missing padding delimiter");
  return padded.slice(0, end - 1);
}

/** Verifies a VAPID `Authorization: vapid t=<jwt>, k=<key>` header and returns the JWT claims. */
export async function verifyVapid(header: string, expectedPublicKey: string) {
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  if (!m) throw new Error("not a vapid header");
  const [, h, p, sig, k] = m;
  if (k !== expectedPublicKey) throw new Error("wrong k");
  const pub = b64u.decode(expectedPublicKey);
  const key = await subtle.importKey("raw", pub, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    b64u.decode(sig!),
    enc.encode(`${h}.${p}`),
  );
  if (!ok) throw new Error("bad signature");
  return {
    header: JSON.parse(text(b64u.decode(h!))) as { typ: string; alg: string },
    claims: JSON.parse(text(b64u.decode(p!))) as { aud: string; exp: number; sub: string },
  };
}

/** A VAPID key pair in the format `bun run vapid:generate` prints. */
export async function newVapid(subject = "mailto:owner@talvuno.test") {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const jwk = await subtle.exportKey("jwk", pair.privateKey);
  const pub = concat(new Uint8Array([4]), b64u.decode(jwk.x!), b64u.decode(jwk.y!));
  return { publicKey: b64u.encode(pub), privateKey: jwk.d!, subject };
}
