---
title: Twilio setup
description: The API key, the TwiML App, the number webhooks, and the Connect to Talvuno button.
---

Talvuno talks to Twilio in two directions. It calls the Twilio REST API with an API key, and Twilio calls Talvuno's webhooks when something happens.

Every webhook is checked against the `X-Twilio-Signature` header, computed over `PUBLIC_URL` plus the path. The URLs on this page must therefore start with exactly the `PUBLIC_URL` you configured, with the same scheme, host and port. A request that does not match gets a 403.

## 1. API key

1. In the Twilio Console, open Account, then API keys and tokens.
2. Create a Standard API key.
3. Put its SID in `TWILIO_API_KEY_SID` and its secret in `TWILIO_API_KEY_SECRET`. The secret is shown once.
4. On the same page, copy the Account SID into `TWILIO_ACCOUNT_SID` and the auth token into `TWILIO_AUTH_TOKEN`.

The key signs Voice access tokens for the browser and calls the REST API. The auth token is used only to check webhook signatures.

## 2. TwiML App

Browser calls go out through a TwiML App.

1. In the Console, open Voice, then TwiML Apps, and create an app.
2. Set its Voice request URL to `${PUBLIC_URL}/api/twilio/voice/outbound`, with HTTP POST.
3. Put the app's SID (it starts with `AP`) in `TWILIO_TWIML_APP_SID`.

## 3. Number webhooks

You can set these by hand, or let Talvuno do it with the Connect button described below.

For each phone number, under Phone Numbers and Active numbers:

| Field | URL |
| --- | --- |
| Voice, "A call comes in" | `${PUBLIC_URL}/api/twilio/voice/inbound` (POST) |
| Voice, "Call status changes" | `${PUBLIC_URL}/api/twilio/voice/status` (POST) |
| Messaging, "A message comes in" | `${PUBLIC_URL}/api/twilio/sms/inbound` (POST) |

Outgoing messages set their own status callback, `${PUBLIC_URL}/api/twilio/sms/status`, so the number needs no messaging status URL.

All the webhooks in one place:

| Webhook | URL |
| --- | --- |
| TwiML App Voice URL (outgoing calls) | `${PUBLIC_URL}/api/twilio/voice/outbound` |
| Number voice URL (incoming calls) | `${PUBLIC_URL}/api/twilio/voice/inbound` |
| Call status callback | `${PUBLIC_URL}/api/twilio/voice/status` |
| Number messaging URL (incoming SMS) | `${PUBLIC_URL}/api/twilio/sms/inbound` |
| Message status callback | `${PUBLIC_URL}/api/twilio/sms/status` |

## 4. Sync your numbers

Sign in, open Settings, and in the Numbers section choose **Sync from Twilio**. Talvuno reads the numbers on your Twilio account and reports how many it added, updated and removed. You can rename a number and make one the default for new calls and texts.

## 5. Connect to Talvuno

Next to each number is a **Connect to Talvuno** button. It sets the number's voice URL, messaging URL and status callback to the Talvuno URLs above, and clears any TwiML App set on the number.

:::caution
Connecting replaces whatever the number pointed at before. Incoming calls and texts then come to Talvuno instead.
:::

Talvuno asks you to confirm first, and saves the number's previous settings before it changes anything. If the number already points at Talvuno, nothing is changed and you are told so.

### Restore

If you want a number back the way it was, choose **Restore previous**. Talvuno puts the saved settings back, and then it stops receiving that number's calls and texts. The saved settings come from the most recent Connect. Once you restore, there is nothing left to restore until you connect again.

A number can also be removed from Talvuno. This removes it from Talvuno only. History stays, and the number stays on your Twilio account. You can add it back.

## Background jobs

A cron trigger runs every 15 minutes. It does three things:

- It removes webhook records older than 30 days.
- It asks Twilio for the final state of messages that have sat in a sending state for over an hour (for up to seven days).
- It asks Twilio for the final state of calls that were still open two hours after they started.

These catch the case where a final status callback never arrived.

## Check it works

In Settings, the Setup check section lists which settings are present (never their values) and has a **Test Twilio connection** button. It makes one read of your Twilio account and tells you the account name and whether it is a trial or a full account. A trial account can only reach numbers you have verified in Twilio.

## Before the first call

A new install cannot send anything until three things are done in Settings:

1. Choose **Sync from Twilio** so your numbers load.
2. Choose **Connect to Talvuno** on each number you want to use.
3. Add your **Allowed countries**. The list starts empty, and nothing can be sent until you add at least one.
