---
title: Getting started
description: Clone, create the database, set the secrets, deploy and claim the owner account.
---

This page takes you from nothing to a deployed Talvuno with an owner account. Twilio itself is set up on the [next page](../twilio-setup/), and you need its values for the secrets below, so it helps to have the Twilio Console open in another tab.

## 1. Accounts

- A [Cloudflare](https://dash.cloudflare.com) account.
- A [Twilio](https://www.twilio.com) account with a phone number that can do voice, SMS or both.

## 2. Clone and install

```sh
git clone https://github.com/bts-io/talvuno.git
cd talvuno
bun install
```

## 3. Log in to Cloudflare and pick the account

```sh
bunx wrangler login
```

Pick your account by exporting `CLOUDFLARE_ACCOUNT_ID` with your own Cloudflare account ID. The repository holds no account ID, so this step is needed. You can instead add your own `account_id` to `wrangler.jsonc`.

## 4. Create the database

```sh
bunx wrangler d1 create talvuno-db
```

Wrangler prints a database ID. Put it in `d1_databases[0].database_id` in `wrangler.jsonc`. The file holds a placeholder, so set your own.

The deploy command applies the migrations in `migrations/` to this database for you.

## 5. Set the public URL

`PUBLIC_URL` is a plain variable in `wrangler.jsonc`. Set it to the exact URL the Worker will answer on, for example `https://talvuno.<your-subdomain>.workers.dev` or a custom domain of your own. Use no trailing slash.

Twilio webhooks and sign-in both depend on this being exact: same scheme, same host, same port. A mismatch makes every webhook fail its signature check.

## 6. Set the secrets

Never put these in `wrangler.jsonc` or in version control. In production, set each one with `bunx wrangler secret put NAME`. For local work they go in `.dev.vars`, which is ignored by version control (copy `.dev.vars.example` to start).

| Name | What it is for |
| --- | --- |
| `BETTER_AUTH_SECRET` | Signs session cookies. A long random string, for example from `openssl rand -base64 32`. |
| `SETUP_TOKEN` | Required by first-run setup, so only the person who deployed can claim the owner account. Generate it with `openssl rand -hex 24` and keep it. Setup refuses to run (503) while it is unset. |
| `TWILIO_ACCOUNT_SID` | Your Twilio account SID. |
| `TWILIO_API_KEY_SID` | The SID of a Twilio API key. Used to sign Voice access tokens and to call the Twilio REST API. |
| `TWILIO_API_KEY_SECRET` | The secret of that API key. Twilio shows it once. |
| `TWILIO_AUTH_TOKEN` | Your Twilio auth token. Used only to check the signature on incoming webhooks. |
| `TWILIO_TWIML_APP_SID` | The TwiML App that sends outgoing browser calls to this deployment. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push keys for missed-call and message notices. All three are secrets. See [Notifications](../notifications/). |

Optional single sign-on adds `OIDC_DISCOVERY_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and `OIDC_BUTTON_LABEL`. See [Single sign-on](../single-sign-on/).

`SOURCE_URL` is a plain var in `wrangler.jsonc` and defaults to `https://github.com/bts-io/talvuno`. It is the target of the "Source code" link in Settings. If you modify Talvuno and run it for other people, point it at your fork (AGPL-3.0 section 13).

Two more settings exist. `TWILIO_API_BASE` is for tests and local mocks only, so leave it unset. `CSP_REPORT_ONLY` is explained under [Security](../security/).

:::tip
You can deploy first and fill in the Twilio values afterwards. The Settings screen has a setup check that shows which values are set, without ever showing the values themselves.
:::

## 7. Deploy

```sh
bun run deploy
```

This applies the migrations to the remote database, builds the app and deploys the Worker. The Worker also gets a cron trigger that runs every 15 minutes for catch-up and cleanup work.

## 8. First-run setup

Open your `PUBLIC_URL`. The first visit goes to `/setup`, which asks for:

- your name, email and password for the owner account
- the `SETUP_TOKEN` you set above

This works once. A single database row claims the owner, so two setup requests racing each other cannot both succeed. After that, sign-up is closed and only the owner can sign in.

If you lose the owner password, you can start over by deleting the owner from the database. This removes the owner and their data. Audit events stay, without an owner.

```sh
bunx wrangler d1 execute talvuno-db --remote --command "DELETE FROM messages; DELETE FROM conversations; DELETE FROM calls; DELETE FROM user; DELETE FROM owner_claim;"
```

## 9. Before the first call

In Settings, choose **Sync from Twilio**, then **Connect to Talvuno** on each number, and add your **Allowed countries**. The list starts empty, and nothing can be sent until you do. The steps are explained in [Twilio setup](../twilio-setup/#before-the-first-call).

## Running locally

```sh
cp .dev.vars.example .dev.vars    # fill in BETTER_AUTH_SECRET and SETUP_TOKEN at least
bun run db:migrate:local
bun run dev                       # http://localhost:5173
```

Twilio cannot reach `localhost`, so calls and texts need a deployed Worker, or a tunnel to your machine with `PUBLIC_URL` set to the tunnel address.
