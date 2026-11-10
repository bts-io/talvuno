---
title: Architecture
description: How the browser, the Worker, D1, the OwnerHub Durable Object and Twilio fit together, and the decisions behind them.
---

One Cloudflare Worker serves everything. TanStack Start renders the pages and Hono answers `/api/*`, both inside the same Worker.

```mermaid
flowchart TB
  B["Browser<br/>React, Voice SDK"]
  T["Twilio"]
  W["Worker<br/>pages + Hono API"]
  H["OwnerHub<br/>Durable Object"]
  D[("D1 database")]

  B <-->|"call audio<br/>(WebRTC)"| T
  B -->|"pages<br/>and /api"| W
  T -->|"signed<br/>webhooks"| W
  W -->|"REST:<br/>SMS, account"| T
  W -->|"notify,<br/>send limits"| H
  W -->|"queries"| D
  B <-.->|"live updates<br/>via /api/live"| H
```

## The parts

- **Browser.** A React app with TanStack Router and TanStack Query. The official `@twilio/voice-sdk` runs here and nowhere else. Call audio goes straight between the browser and Twilio and never passes through the Worker.
- **Worker.** Serves the server-rendered pages and the Hono API. Server-side loaders call the API in-process, so a page render costs no extra network hop. It also handles Twilio webhooks and runs the cron job every 15 minutes.
- **D1.** The database, reached through Drizzle ORM with versioned SQL migrations. Every table is scoped by `owner_id`. Provider SIDs for messages, calls and numbers carry unique constraints, which is what makes webhook handling idempotent.
- **OwnerHub.** One Durable Object per owner. It holds the WebSocket of every open tab for live updates, and keeps the hourly send counters for the spend guards.
- **R2, Queues and Workers AI.** Voicemail audio is kept in the `RECORDINGS` bucket. The `TRANSCRIBE` queue runs Whisper on Workers AI through AI Gateway and stores the transcript. Each transcript then gets a short AI summary (Gemma 4 on Workers AI, also through AI Gateway) as its own job on the same queue, unless the owner has switched summaries off in Settings.
- **Twilio.** Receives REST calls from the Worker, sends signed webhooks to it, and carries call audio to the browser.

## Stack

- TanStack Start (React, server-rendered) for the pages, with TanStack Router and TanStack Query in the browser.
- Hono for the API under `/api/*`.
- Cloudflare D1 with Drizzle ORM and versioned SQL migrations in `migrations/`.
- Better Auth for email and password sign-in.
- A Durable Object (`OwnerHub`) for live updates over WebSockets and for send limits.
- The official `@twilio/voice-sdk` in the browser.
- Tailwind CSS, i18next, Zod, libphonenumber-js, Biome and Vitest.

## How an incoming text reaches the screen

1. Twilio posts to `/api/twilio/sms/inbound`.
2. The Worker checks the signature, records the webhook under a unique key, and writes the message to D1.
3. After the write commits, the Worker tells the owner's hub. Events say only what changed.
4. Every open tab receives the event and refetches through TanStack Query.
5. If no tab is open, the Worker sends a Web Push notice instead.

A dropped socket loses nothing, because the browser refetches everything when it reconnects.

## How an incoming call reaches the owner

```mermaid
flowchart TB
  C["Caller dials a number"]
  R{"Blocked, closed hours<br/>or do not disturb?"}
  X["Rejected or voicemail<br/>no ring, no push"]
  Q["Caller waits in its own<br/>queue with ringback"]
  N["Live event to open tabs<br/>high-urgency push to devices"]
  A["A device answers<br/>with AnswerCallId"]
  K{"First claim of a call<br/>that is still waiting?"}
  B["Bridged to the caller"]
  V["Ring time up or declined:<br/>voicemail"]

  C --> R
  R -->|"yes"| X
  R -->|"no"| Q
  Q --> N
  N --> A
  A --> K
  K -->|"yes"| B
  K -->|"no"| E["Told it was answered elsewhere"]
  Q --> V
```

1. Twilio posts to `/api/twilio/voice/inbound`. A blocked caller gets `<Reject>`. Outside the number's hours, or with do not disturb on, the caller hears the voicemail greeting at once.
2. If the number has a phone menu, the caller hears its prompt in a `<Gather>` for one key and nothing rings yet. `/menu-choice` runs the key: ring goes on to the queue below, voicemail goes to the greeting, and forward dials a number the owner saved, from the called number, after the same allowlist and hourly checks as any outbound call. No key, or a key with nothing behind it, plays the prompt once more and then takes the menu's default (ring or voicemail).
3. Otherwise the Worker stores the call with a random queue name and answers `<Enqueue>`. The queue's `waitUrl` (`/queue-wait`) plays ringback and decides when the caller leaves.
4. The Worker sends a live `incoming` event to every open tab and a high-urgency Web Push to every subscribed device. Tapping the notice opens `/answer/<call id>`.
5. Answering from the sheet or the notice places a call from the browser with `AnswerCallId`. The Worker checks it belongs to the owner, is still waiting and is not claimed, then answers `<Dial><Queue>`.
6. Just before the bridge, Twilio requests `/queue-bridge`, which marks the call answered and tells every other tab to stop ringing.
7. When the ring time is up or the owner declined, the caller leaves the queue and `/queue-done` answers with the voicemail greeting and `<Record>`. The recording goes to the voicemail pipeline.

Every call keeps one row, keyed by the caller's CallSid, with an outcome: answered, missed, voicemail, declined, blocked or forwarded. Only missed calls count as missed and get the missed call notice.

## Hold and transfer

Hold and transfer redirect one leg of a call that is already bridged, through Twilio's REST API.

```mermaid
flowchart TB
  L["Live call<br/>browser and other party"]
  H["Hold: other party redirected<br/>into a th_ queue with music"]
  S["Browser stays on<br/>a quiet loop"]
  R["Resume: browser redirected<br/>to Dial Queue of that queue"]
  T["Transfer: target checked<br/>against the allowlist"]
  D["Other party redirected<br/>to Dial the target"]
  E["Browser leg ended,<br/>Recents shows the transfer"]
  O["Ten minutes on hold:<br/>spoken message, call ends"]

  L --> H
  H --> S
  S --> R
  R --> L
  S --> O
  L --> T
  T --> D
  D --> E
```

1. The active call screen sends `POST /api/calls/<call>/hold`, `/resume` or `/transfer`. Each is owner-only and
   idempotent, and refuses a call that is not answered and in progress.
2. Hold redirects the other party into a queue of its own. The browser's `<Dial>` ends and its action
   (`/api/twilio/voice/hold/owner`) keeps the browser connected to silence.
3. Resume redirects the browser leg to `<Dial><Queue>` of the hold queue, and the two are bridged again.
4. Transfer checks the target like any call we place, then redirects the other party to dial it from the
   call's own number and ends the browser leg.
5. After ten minutes on hold the party hears a short message and the call ends.
6. If the owner hangs up while the other party is held, the Worker ends the call at once: the hang-up button
   sends `POST /api/calls/<call>/hangup`, and the browser leg's status callback is the fallback. The held
   party hears a short goodbye.
7. The transfer target's status callback records how the transfer ended and how long it talked.

## Decision records

The short records of the foundation choices are in [docs/decisions.md](https://github.com/bts-io/talvuno/blob/main/docs/decisions.md) in the repository. In brief:

| # | Decision | Why |
| --- | --- | --- |
| 1 | One Worker for pages and API | One build and one deploy. Splitting would add a second deploy and cross-origin cookies for no gain at this size. |
| 2 | Bun and Biome | One tool to install and run, one to lint and format. |
| 3 | D1 with Drizzle and versioned migrations | The Worker's own database with no connections to manage, and plain SQL migrations. |
| 4 | Better Auth with a single owner | Handles passwords, sessions and cookies. Sign-up is off and `/setup` claims the owner once. |
| 5 | A Durable Object per owner as the live hub | Live updates through hibernating WebSockets, and atomic counters without a transaction. |
| 6 | No Queues | Twilio retries failed webhooks and every webhook is recorded under a unique key. Statuses never move backwards. |
| 7 | The Voice SDK stays in the browser | It needs WebRTC. A unit test and a build stub keep it out of the Worker bundle. |
| 8 | Foreground calls only, said plainly | A web app cannot ring a locked phone. The app says so on setup, the keypad and settings. |
| 9 | English only, with right-to-left plumbing | Every string goes through i18next, and the layout uses start and end properties. |
| 10 | Phone numbers are E.164 everywhere | One normal form for comparing and storing, and an empty country list by default. |
| 11 | Every inbound call waits in a queue of its own | A closed app cannot be woken to ring. The caller waits with ringback, a push opens the app, and the first device to claim the call is bridged. |
| 12 | Voicemail audio in R2, transcripts through a queue | The audio leaves Twilio for our own bucket. Whisper runs from a queue with retries, so a failed transcript never blocks the message. |
| 13 | Hold and transfer move the other party's leg, not the bridge | A REST redirect into a hold queue or a new dial covers both directions without turning every call into a conference. |

A decision that changes one of these adds a new record instead of editing the old one.
