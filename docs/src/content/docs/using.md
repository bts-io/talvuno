---
title: The app
description: Keypad, Recents, Messages, Contacts and Settings.
---

Talvuno has five tabs: Keypad, Recents, Messages, Contacts and Settings. Open pages update by themselves when something arrives, and a small indicator shows whether live updates are on.

Until you add a number and choose allowed countries, a banner in the app points you to Settings. Nothing can be sent before then.

## Keypad

Type or paste a number and choose **Call**. Use the "Call from" picker to choose which of your numbers the call goes out from. The default number is chosen for you.

- Numbers are read as E.164. If you type a number without a country, start it with `+` and the country code.
- The first call asks for microphone permission. If you block it, allow microphone access for the site in your browser settings and try again.
- During a call you can mute, show the keypad, and hang up.
- An incoming call shows Accept and Decline. It only rings while Talvuno is open in the foreground (see [Introduction](../introduction/)).
- Calls to countries you have not allowed, to premium-rate numbers, or past your hourly limit are refused.

## Recents

Your call history, newest first, with a filter for All or Missed calls. Each row shows whether the call was incoming or outgoing. A call from a withheld number shows as "Withheld number". From a row you can call back, or save the number as a contact. Longer lists load with **Show more**.

## Messages

Threaded SMS conversations.

- The list shows unread counts. A filter limits it to one of your numbers, and search covers messages and contacts.
- **New message** takes a number and a "From" number.
- The composer shows a character and segment count. Messages can be at most the length shown there.
- Each outgoing message shows its status: queued, sending, sent, delivered, or not delivered. A failed message shows the reason and a **Retry** button.
- Pictures and other attachments are not supported. An incoming message with attachments shows a notice that says so.
- Short codes and alphanumeric senders can message you, but you cannot reply to them. The thread says so.
- Texting a US number from a US number shows a reminder about A2P 10DLC registration.

## Contacts

A simple address book. Search by name or number, add or edit a contact with several numbers and labels, and call or text from a row.

- **Import** reads a vCard file (`.vcf`). It takes up to 1 MB and up to 500 cards per import. It reads the name, organisation, note and phone numbers, and ignores the rest. Cards without a usable name or a valid phone number are skipped and counted in the result.
- **Export** downloads all contacts as `talvuno-contacts.vcf`.

## Settings

### Numbers

Your Twilio numbers. **Sync from Twilio** loads them. For each number you can rename it, make it the default, connect it to Talvuno, restore its previous Twilio settings, or remove it. See [Twilio setup](../twilio-setup/).

### Calling and texting safety

- **Allowed countries.** Talvuno only calls or texts countries on this list. It starts empty, so a fresh install cannot run up international charges. Search for a country and add it.
- **Texts per hour** and **Calls per hour.** Hard limits for the owner. They start at 30 texts and 20 calls. Texts can be set from 0 to 10000 and calls from 0 to 1000. Setting a limit to 0 stops that kind of traffic.

### Account

Your Twilio balance and this month's usage for calls, texts and the total. The figures are cached for five minutes, with a **Refresh** button.

### Setup check

Which settings this deployment has, as set, missing or optional. Values are never shown. A **Test Twilio connection** button makes one read of your account.

### Notifications, install and theme

Turn Web Push on for the device in your hand, send a test notice, and install the app. The theme can follow the system or be light or dark. See [Notifications and installing](../notifications/).
