import { Hono } from "hono";
import { twilioSignature } from "../lib/twilio/signature";
import type { AppEnv } from "../types";
import { twilioSms } from "./twilio-sms";
import { twilioVoice } from "./twilio-voice";
import { twilioVoicemail } from "./twilio-voicemail";

/**
 * Twilio webhooks (voice TwiML, call status, inbound SMS, message status). Mounted at /api/twilio, outside the
 * session and Origin checks, because Twilio has no cookie and sends no Origin.
 *
 * `twilioSignature()` guards every path here: nothing reaches a handler unless X-Twilio-Signature matches
 * PUBLIC_URL plus the exact path and the posted form fields. Handlers must still record the event in
 * webhook_events (unique idempotency key) so Twilio's retries are processed once.
 *
 * Webhook URLs (the contract with the Twilio console, see README "Twilio setup"):
 *   POST /api/twilio/voice/outbound   TwiML App Voice URL (browser calls out)
 *   POST /api/twilio/voice/inbound    number's voice URL
 *   POST /api/twilio/voice/status     call status callback
 *   POST /api/twilio/voice/voicemail  recording status callback of a voicemail <Record>
 *   POST /api/twilio/sms/inbound      number's messaging URL
 *   POST /api/twilio/sms/status       message status callback
 *
 * Voice and SMS routers mount below with one line each.
 */
export const twilio = new Hono<AppEnv>();

twilio.use("*", twilioSignature());
twilio.route("/sms", twilioSms);
twilio.route("/voice", twilioVoice);
twilio.route("/voice/voicemail", twilioVoicemail);
