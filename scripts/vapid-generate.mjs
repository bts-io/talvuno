// Generates a VAPID key pair for Web Push (RFC 8292) and prints it as ready-to-use settings.
//   bun run vapid:generate
// The private key is shown once on your terminal. Store it as a Worker secret right away; do not commit it.

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const x = Buffer.from(jwk.x, "base64url");
const y = Buffer.from(jwk.y, "base64url");
// The public key is the uncompressed P-256 point: 0x04, then x, then y (65 bytes).
const publicKey = b64url(Buffer.concat([Buffer.from([4]), x, y]));
const privateKey = jwk.d;

console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log("VAPID_SUBJECT=mailto:you@example.com");
console.error(
  "\nFor local development put these three lines in .dev.vars. In production set each with:\n" +
    "  bunx wrangler secret put VAPID_PUBLIC_KEY   (and VAPID_PRIVATE_KEY, VAPID_SUBJECT)\n" +
    "Keep the same keys for the life of the deployment: changing them drops every device's subscription.",
);
