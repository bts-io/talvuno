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
- **R2, Queues and Workers AI.** Voicemail audio is kept in the `RECORDINGS` bucket. The `TRANSCRIBE` queue runs Whisper on Workers AI through AI Gateway and stores the transcript.
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
| 11 | Voicemail audio in R2, transcripts through a queue | The audio leaves Twilio for our own bucket. Whisper runs from a queue with retries, so a failed transcript never blocks the message. |

A decision that changes one of these adds a new record instead of editing the old one.
