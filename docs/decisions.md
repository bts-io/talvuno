# Decisions

Short records of the choices behind Talvuno's foundation. Each one says what we chose and why. A later
decision that changes one of these adds a new entry rather than editing the old one.

## 1. One Worker for pages and API

TanStack Start renders the pages and Hono answers `/api/*`, both inside one Worker (`src/server.ts`). This is
the same shape as our other TanStack Start Workers, so the build, the tests and the deploy
are already known to work. Server-side loaders call the API in-process through a small bridge, so a page
render costs no extra network hop. Splitting into separate web and API Workers would add a second deploy and
cross-origin cookies for no gain at this size.

## 2. Bun and Biome

Bun installs and runs scripts, and Biome does linting and formatting in one tool. Both match the reference
repos, which keeps the CI workflow and editor setup the same across projects. This overrides the handoff's
pnpm, ESLint and Prettier suggestion.

## 3. D1 with Drizzle and versioned migrations

D1 is the Worker's own database, with no connection management. Drizzle gives typed queries and generates
plain SQL migrations into `migrations/`, which `wrangler d1 migrations apply` runs in order. Every table is
scoped by `owner_id`. Provider SIDs (message, call,
number) carry unique constraints, which is what makes webhook handling idempotent.

## 4. Better Auth with a single owner

Talvuno has exactly one account per deployment. Better Auth handles email and password, sessions and cookies
on D1. Public sign-up is turned off. `/setup` creates the owner once, and a one-row `owner_claim` table makes
that atomic, so two setup requests racing each other cannot both succeed. We chose this over Cloudflare
Access so a self-hoster needs nothing beyond the Worker, and over a home-made session system because cookie,
CSRF and rate-limit details are easy to get wrong. Sessions use HttpOnly, SameSite=Lax cookies, Secure on
https. Our own state-changing routes check the Origin header, and Better Auth does the same for its routes.
Sign-in attempts are rate limited in D1 so the limit holds across Worker isolates.

## 5. A Durable Object per owner as the live hub

Incoming messages and call status changes arrive as Twilio webhooks, and open tabs should update at once. One
`OwnerHub` Durable Object per owner holds every open tab's WebSocket using the hibernation API, so an idle hub
costs nothing. Webhook handlers write to D1 first, then call `notify(event)`. Events only say what changed;
the browser refetches through TanStack Query. A dropped socket therefore loses nothing, because the client
refetches everything when it reconnects. The same object also keeps the per-owner SMS and call counters
(`consume`), because a Durable Object handles one request at a time, which makes the check and the increment
atomic without a database transaction.

## 6. No Queues

Twilio already retries a webhook that does not get a 2xx answer, and every webhook is recorded in
`webhook_events` under a unique idempotency key before it is processed. That covers retries without a queue.
Status updates go through `nextMessageStatus` and `nextCallStatus`, which never move a status backwards, so
callbacks that arrive out of order cannot undo each other.

## 7. The Voice SDK stays in the browser

`@twilio/voice-sdk` needs WebRTC and only works in a browser. It is loaded lazily from one helper
(`src/client/lib/voice-sdk.ts`). A unit test fails if any other file imports it or if it appears in the built
Worker bundle, and the Vite config swaps it for a throwing stub in the server build as a second guard. Call
audio flows directly between the browser and Twilio.

## 8. Foreground calls only, said plainly

A web app cannot ring a locked phone or a background tab reliably. Rather than hide this, the app shows a
reusable notice (`ForegroundCallNote`) on setup, the keypad and settings, and the README states it. Web Push
will be used for missed-call and message notices, never as a substitute for ringing.

## 9. English only, with right-to-left plumbing

i18next carries every UI string from day one, in `src/shared/locales/en.json`. Only English ships, and we do not
claim other languages. The `<html>` element gets `lang` and `dir` from the active locale, and the layout uses
logical properties (start and end), so adding a right-to-left language should need only a locale file and a check
of the screens.

## 10. Phone numbers are E.164 everywhere

Every number that enters the system, typed by a person or sent by Twilio, is normalized with libphonenumber-js
(`src/lib/phone.ts`) before it is stored or compared. Calls and messages are only allowed to countries in the
owner's allowlist, which starts empty, so a fresh install cannot run up international charges.

## 11. Every inbound call waits in a queue of its own

A closed web app cannot be woken to ring, so the caller has to wait somewhere while the owner opens it. Twilio's
documented building block for that is `<Enqueue>`: the caller joins a queue with a `waitUrl` that plays ringback,
and whoever answers takes the caller out with `<Dial><Queue>`. Each call gets its own queue with a random name
that never leaves the Worker. A device answers by placing a call that names the waiting call row
(`AnswerCallId`). The Worker checks that the identity is the owner's, that the row is the owner's and still
waiting, and records the first claim. Only then does it hand Twilio the queue name, so no device can pull a
caller it was not offered and a second device is told the call was answered elsewhere.

Open apps no longer ring through `<Client>`. Ringing the registered devices first and queueing only after would
give a closed app nothing to connect to while the open ones ring, and two paths would need two rules for who
wins. With one path the open app hears the live `incoming` event about as fast as Twilio's own signalling, plays
its own ringtone, and answers the same way a notification does. Every call also sends a high-urgency push with a
time to live of the ring time, even when a tab is open, because an open tab on one device says nothing about the
phone in a pocket.

The `waitUrl` decides when the caller leaves: after the per-number ring time (default 25 seconds, plus a short
grace once a device has claimed the call), and within a few seconds after a decline, because the next ringback
poll sees the decline. Leaving the queue plays the voicemail
greeting and records. Blocked callers are rejected before anything rings, and calls outside business hours or
with do not disturb on go straight to voicemail with no ring and no push. `calls.outcome` records answered,
missed, voicemail, declined or blocked, and only "missed" (or no outcome on older rows) counts as a missed call.
Texts from blocked senders are dropped on arrival, never stored. Queues are deleted when the caller leaves them,
since Twilio keeps queues until they are removed. Decision 8 still holds for the parts a web app cannot do: the
app rings only once it is open, and the notification is how a closed app hears about a call.
