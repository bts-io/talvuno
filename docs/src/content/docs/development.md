---
title: Development
description: Scripts, tests and the project layout.
---

Talvuno uses Bun for installs and scripts, and Biome for linting and formatting.

## Scripts

| Command | What it does |
| --- | --- |
| `bun run dev` | Starts the dev server at `http://localhost:5173`. |
| `bun run build` | Builds the client and the Worker. |
| `bun run verify` | Biome, typecheck, unit and workerd integration tests, build, SSR tests. |
| `bun run check` | Generates Worker types and routes, then typechecks the app, the Worker and the tooling. |
| `bun run lint` | `biome check .` |
| `bun run format` | `biome format --write .` |
| `bun run test:unit` | Quick unit tests, Node only. |
| `bun run test:integration` | Integration tests, run inside workerd. |
| `bun run test:ssr` | Builds, then tests the rendered pages. |
| `bun run db:generate` | Generates a migration after you change `src/worker/db/schema/*.ts`. |
| `bun run db:migrate:local` | Applies migrations to the local database. |
| `bun run db:migrate:remote` | Applies migrations to the deployed database. |
| `bun run deploy` | Migrates the remote database, builds, and deploys. |
| `bun run vapid:generate` | Prints a new set of Web Push keys. |

## Tests

- `tests/unit` runs in Node. It covers phone and vCard handling, the status rules, the Twilio REST client and token, the CSP builder, the service worker and the client pieces.
- `tests/integration` runs in workerd with a real D1 and Durable Objects. It covers sign-in and setup, the webhooks and their signatures, the spend guards, numbers, contacts, SMS, voice, push and the cron jobs.
- `tests/ssr` builds the Worker and checks the rendered pages.

Never edit a migration that has been applied. Add a new migration with `bun run db:generate` and commit it.

## Project layout

| Path | What is there |
| --- | --- |
| `src/server.ts` | The Worker entry. Sends `/api/*` to Hono and renders every other path. |
| `src/worker/index.ts` | The Hono app and the route mounts. |
| `src/worker/routes/` | API routes: account, numbers, calls, messages, contacts, preferences, push, status, billing and the Twilio webhooks. |
| `src/worker/lib/` | Server helpers: Twilio REST, signatures, tokens, spend guards, SMS and voice logic, push, the CSP. |
| `src/worker/durable/` | The `OwnerHub` Durable Object. |
| `src/worker/db/schema/` | Drizzle table definitions. |
| `src/worker/cron.ts` | The scheduled jobs. |
| `src/client/routes/` | The pages: keypad, recents, messages, contacts, settings, login and setup. |
| `src/contracts/` | Zod schemas for requests, responses, statuses and live events, shared by the Worker and the browser. |
| `src/lib/` | Phone number, SMS length and vCard helpers. |
| `src/shared/locales/en.json` | Every UI string. |
| `migrations/` | Versioned SQL migrations for D1. |
| `public/` | Icons, the web manifest and the service worker. |

## Conventions

- Every `/api` route requires the owner's session, and state-changing requests must come from the app's own origin.
- Phone numbers are stored as E.164, through `src/lib/phone.ts`.
- Message and call statuses are only written through `nextMessageStatus` and `nextCallStatus`, which never move a status backwards.
- The Voice SDK is loaded only through `src/client/lib/voice-sdk.ts`.
- Only English ships today. The layout uses logical properties (start and end), so a right-to-left language should need only a locale file and a check of the screens.
- UI strings contain no em or en dashes, and a test checks this.

The documentation you are reading lives in `docs/` and is built with Astro Starlight. Run `cd docs && bun install && bun run dev` to preview it.
