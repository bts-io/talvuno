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

## 11. Voicemail audio in R2, transcripts through a queue

This changes decision 6 for one job. Voicemail recordings are copied from Twilio into our own R2 bucket and
then deleted on Twilio, so the audio lives only where the owner controls it. The voicemail row is written
before the download, and the Twilio copy is only deleted after the R2 copy exists, so a failed download keeps
the message and the cron tries again. Transcription is slow and can fail on its own, which a webhook retry
does not fit, so it runs from a Cloudflare Queue (`talvuno-transcribe`) with retries and backoff. Whisper runs
on Workers AI through AI Gateway (`AI_GATEWAY_ID`). A transcript that still fails is marked failed and can be
retried from Recents. The audio stays playable either way. A per-owner retention setting (default 90 days,
0 for forever) is enforced by the cron.
