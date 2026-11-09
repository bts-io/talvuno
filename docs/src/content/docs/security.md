---
title: Security
description: Webhook signatures, spend guards, the content security policy, the single owner, and what is stored.
---

## The single owner

A deployment has exactly one account. First-run setup needs the `SETUP_TOKEN` secret and works once. A one-row table claims the owner atomically, so two racing setup requests cannot both succeed, and any second account creation fails. Public sign-up is closed.

- Sessions use HttpOnly, SameSite=Lax cookies, marked Secure on https, and last 30 days.
- Password sign-in is rate limited to 5 attempts a minute, counted in the database so the limit holds across Worker instances.
- Every `/api` route needs the owner's session. State-changing requests must also come from the app's own origin. The exceptions are `/api/health`, `/api/setup`, `/api/auth/*` and `/api/twilio/*`, and the Twilio routes check Twilio's signature instead.
- With [single sign-on](../single-sign-on/), only the owner's verified email is accepted.

## Webhook signatures

Every request under `/api/twilio/*` must carry a valid `X-Twilio-Signature`. Talvuno follows Twilio's documented algorithm: an HMAC-SHA1 with your auth token over the full URL and the sorted POST fields.

- The URL is rebuilt from `PUBLIC_URL` plus the request path and query. The `Host` and `X-Forwarded-*` headers are never trusted, so a request cannot choose the URL that gets signed.
- The comparison takes constant time.
- A request that fails the check gets a 403.
- Each webhook is recorded under a unique key before it is processed, so a retry from Twilio does not repeat its effects. Status updates never move a message or call backwards, so callbacks that arrive out of order cannot undo each other.

## Spend guards

Before any outgoing text or call reaches Twilio, Talvuno checks, in this order:

1. The number is a valid full E.164 number.
2. It is not a premium-rate number.
3. Its country is on your allowed list. The list starts empty, so nothing can be sent until you add countries.
4. The hourly limit has room. The defaults are 30 texts and 20 calls an hour, and you can change them in Settings.

A refused destination never uses up one of your hourly sends. The counters live in the Durable Object, which handles one request at a time, so the check and the increment cannot race.

## Content security policy

Every page is sent with a Content-Security-Policy and a fresh nonce per request. The nonce goes on every inline script the router emits for hydration. API responses do not carry it. HTML pages also get `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and a strict-origin referrer policy.

| Directive | Value |
| --- | --- |
| `default-src` | `'self'` |
| `script-src` | `'self' 'nonce-<per request>' 'strict-dynamic'` |
| `style-src` | `'self' 'unsafe-inline'` (React inline `style` attributes, which nonces cannot cover) |
| `img-src` | `'self' data: blob:` |
| `font-src` | `'self'` |
| `connect-src` | `'self'`, this site's `ws(s)://` origin for the live channel, and the Twilio hosts below |
| `media-src` | `'self' blob: mediastream:`, `https://sdk.twilio.com`, `https://media.twiliocdn.com` |
| `worker-src`, `manifest-src` | `'self'` |
| `frame-ancestors`, `base-uri`, `object-src` | `'none'` |
| `form-action` | `'self'` |

The Twilio hosts for the Voice SDK, from the [SDK's CSP section](https://github.com/twilio/twilio-voice.js#content-security-policy), are `https://*.twilio.com`, `wss://*.twilio.com`, `https://media.twiliocdn.com` and `https://sdk.twilio.com`.

If something is blocked on your install, set the variable `CSP_REPORT_ONLY` to `true`. Talvuno then sends `Content-Security-Policy-Report-Only` instead, and the browser console lists what the policy would have refused. Leave it unset to enforce the policy.

## What is stored, and for how long

Everything is in your own D1 database and your own Durable Object storage. Talvuno has no server of its own and no analytics.

| Data | Kept |
| --- | --- |
| Owner account, sessions, sign-in rate counters | Until you delete the owner. Sessions last 30 days. |
| Numbers, contacts, call history | Until you remove them. There is no automatic deletion. |
| Conversations and message text | Until you remove them. There is no automatic deletion. |
| Push subscriptions | Until a device turns notifications off or the push service reports it gone. |
| Webhook records (used to recognise Twilio retries) | 30 days, then removed by the cron job. |
| Spend records (the price Twilio reports) | Kept. |
| Audit events (for example connecting or restoring a number) | Kept. They never hold message text or secrets. |

Secrets are stored as Worker secrets, never in the database, and the setup check never shows their values. Call audio goes directly between the browser and Twilio and never passes through the Worker. Talvuno does not record calls. Twilio keeps its own logs of calls and messages as usual, under your Twilio account.
