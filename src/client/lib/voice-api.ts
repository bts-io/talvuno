/** Voice API calls: the access token and the caller IDs a call may go out from. */
import { queryOptions } from "@tanstack/react-query";
import type { Contact } from "../../contracts";
import { api } from "./api";
import type { IceServerAnswer } from "./ice-servers";

export type VoiceToken = { token: string; identity: string; ttl: number };
export type CallerId = { id: string; e164: string; friendlyName: string; isDefault: boolean };

export const fetchVoiceToken = () => api<VoiceToken>("/api/voice/token", { method: "POST" });

/** How long the browser waits for the ICE servers before a call goes ahead with the public STUN server. */
export const ICE_FETCH_TIMEOUT_MS = 3_000;

/** Twilio STUN and TURN servers for this browser (short-lived TURN credentials, never cached by HTTP). */
export const fetchIceServers = () =>
  api<IceServerAnswer>("/api/voice/ice-servers", { signal: AbortSignal.timeout(ICE_FETCH_TIMEOUT_MS) });

export const callerIdsQuery = () =>
  queryOptions({
    queryKey: ["voice", "caller-ids"],
    queryFn: async () => (await api<{ numbers: CallerId[] }>("/api/voice/caller-ids")).numbers,
    staleTime: 60_000,
  });

/** The name of the contact with this number, or null. Cached briefly so a redial does not ask again. */
export const lookupContactName = (e164: string) =>
  queryOptions({
    queryKey: ["contacts", "lookup", e164],
    queryFn: async () =>
      (await api<Contact | null>(`/api/contacts/lookup?number=${encodeURIComponent(e164)}`))?.displayName ??
      null,
    staleTime: 30_000,
  });
