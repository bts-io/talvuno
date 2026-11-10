---
title: Introduction
description: What Talvuno is, what it is not, and the platform limits to know before you rely on it.
---

Talvuno is an open-source softphone and two-way SMS app for your own Twilio numbers. It runs as one Cloudflare Worker on your own Cloudflare account. You use it from a browser on a phone or a desktop, and you can install it as a web app (a PWA).

It is free software under the AGPL-3.0. If you run a modified copy for other people over a network, you must offer them its source. Using an unmodified copy yourself or inside your own team needs nothing extra. The source is at [github.com/bts-io/talvuno](https://github.com/bts-io/talvuno).

## What it does

- Make and take calls from the browser on your Twilio numbers.
- Send and receive SMS in threaded conversations.
- Use several Twilio numbers and pick which one a call or a message goes out from.
- Keep contacts, with vCard import and export.
- Show live updates across open tabs, and send Web Push notices for missed calls and new messages.
- Keep everything under one owner account per deployment.

## What it is not

- It is not a hosted service. You deploy it, and you pay Cloudflare and Twilio directly.
- It is not a multi-user product. One deployment has exactly one owner. Public sign-up is closed.
- It is not a native phone app. It cannot ring a locked phone the way the built-in dialer does (see below).
- It does not do MMS, voicemail or call forwarding. If someone sends you a picture, you see a notice that an attachment arrived and was not saved.
- It does not do Twilio's sender registration for you.

## Platform limits

Please read these before you rely on Talvuno for calls.

:::caution[Calls only ring while the app is open in the foreground]
Talvuno is a web app. Browsers do not let a web app ring a locked phone or a background tab the way the built-in dialer does. On iOS and Android, a call that arrives while Talvuno is closed, in the background or on a locked screen will usually not ring. It shows up as a missed call in Recents.
:::

- Web Push notices can tell you about a missed call or a new message after the fact. They cannot wake the browser into a ringing call.
- **Do not use Talvuno for emergency calls.** Twilio numbers used through a browser are not a dependable way to reach emergency services. Keep a normal phone for that.
- Sending SMS in some countries needs sender registration with Twilio. In the US this is A2P 10DLC. Without it, carriers may block your messages. Talvuno does not do the registration. The message screen reminds you of this when you text a US number from a US number.
- Talvuno has no native app, so there is no background ringing.

## What you need

- [Bun](https://bun.sh) 1.4 or newer, for the deploy.
- A Cloudflare account. The Workers free plan is enough to try it, and Durable Objects with SQLite storage are included.
- A Twilio account with at least one phone number.

Next: [Getting started](../getting-started/).
