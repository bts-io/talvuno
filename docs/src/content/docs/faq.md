---
title: FAQ and limitations
description: Common questions and the things Talvuno does not do.
---

## Why does my phone not ring when Talvuno is closed?

Because Talvuno is a web app. Browsers do not let a web app ring a locked phone or a background tab. The call shows up as a missed call in Recents, and a Web Push notice can tell you about it afterwards. While Talvuno is open in the foreground, calls ring normally.

## Can I use it for emergency calls?

No. Do not use Talvuno to reach emergency services.

## Why can I not send anything?

A fresh install has an empty country list, so nothing can be sent until you choose allowed countries in Settings. You also need at least one number, which you load with **Sync from Twilio**.

## Why does a text say it was not delivered?

Often the carrier refused it. Texting US numbers from a US number needs A2P 10DLC registration in Twilio, and carriers may block unregistered traffic. Talvuno cannot do this registration for you. Other countries have their own rules, so check Twilio's guidance for the country you text.

## Why do all my webhooks get a 403?

The signature check failed. The most common cause is a `PUBLIC_URL` that does not match the address Twilio calls, in scheme, host or port. Another is a wrong `TWILIO_AUTH_TOKEN`.

## Can more than one person use a deployment?

No. There is one owner per deployment. A second account cannot be created. If several people need Talvuno, each deploys their own.

## Does it work with a Twilio trial account?

It connects, and the setup check reports the account as a trial. Twilio's own trial limits apply, such as only reaching numbers you have verified.

## How long can a call last?

Up to two hours. An incoming call rings the browser for 25 seconds before it counts as missed.

## Does it support MMS, voicemail or call forwarding?

No. Incoming attachments are shown as a notice and are not saved.

## Is there a native app?

No. Talvuno has no native app, so there is no background ringing.

## Which languages does it support?

English only. Strings are kept in a locale file and the layout is ready for right-to-left languages, but no other language ships.

## I lost the owner password. What now?

See the reset command in [Getting started](../getting-started/#8-first-run-setup). It deletes the owner and their data, so you set up again from scratch.

## Where do I report a bug?

Open an issue on [GitHub](https://github.com/bts-io/talvuno/issues). Please leave out secrets and phone numbers.

## Known limitations

- Calls ring only while the app is open in the foreground.
- No MMS, voicemail or call forwarding.
- One owner, one deployment.
- No automatic deletion of messages, calls or contacts.
- No support for Twilio's sender registration.
- English only.
- Pages and the API need a network connection. Only a small offline shell is cached.
