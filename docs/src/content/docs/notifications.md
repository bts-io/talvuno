---
title: Notifications and installing
description: Web Push keys, turning notifications on, and installing Talvuno on iOS and Android.
---

Talvuno is an installable web app and can send Web Push notices for missed calls and new messages.

## Generate the push keys

Do this once per deployment:

```sh
bun run vapid:generate
```

It prints `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and a `VAPID_SUBJECT` placeholder. Put them in `.dev.vars` for local work, or set each with `bunx wrangler secret put NAME` in production.

Set the subject to a `mailto:` address you read. Push services use it to contact you if your server misbehaves.

Keep the same keys for the life of the deployment. New keys invalidate every device's subscription, and each device then has to turn notifications on again in Settings.

## Turn notifications on

Open Settings, turn on notifications on each device you want them on, and use the test button. Notices are sent only when no Talvuno tab is open, so you are not told twice.

## Install on iPhone and iPad

iOS only allows Web Push for an app added to the Home Screen, on iOS 16.4 or newer.

1. Open Talvuno in Safari.
2. Tap the Share button.
3. Choose Add to Home Screen.
4. Open Talvuno from the Home Screen icon, then turn notifications on in Settings.

## Install on Android

Open Talvuno in Chrome or another Chromium browser, then use the menu and choose Install app or Add to Home Screen. Settings also has an **Install the app** button where the browser supports it.

## Limits to know about

- A notice cannot ring. A closed or locked app does not ring for an incoming call, with or without push. You get a notice about the missed call afterwards.
- Delivery is up to the browser vendor's push service. Notices can arrive late. A phone in battery saver mode, or a browser that was force-quit, may not get them. Undelivered notices are dropped after a day.
- The app keeps a small offline shell (the offline page, icons and build files) and nothing else. Pages and `/api/*` always come from the network, so calling and messaging need a connection.
- When a new version is deployed, the app shows a "new version" notice and reloads when you tap it.
