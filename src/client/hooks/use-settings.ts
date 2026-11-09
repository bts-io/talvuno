import { queryOptions } from "@tanstack/react-query";
import type { Preferences } from "../../contracts";
import type {
  Billing,
  ConfigStatus,
  ConnectResult,
  PhoneNumberRow,
  TwilioTestResult,
} from "../../contracts/numbers";
import { api } from "../lib/api";

// Query keys sit outside the live-event roots (conversations, messages, calls): these screens only change
// when the owner changes them.
export const numbersQuery = () =>
  queryOptions({ queryKey: ["numbers"], queryFn: () => api<PhoneNumberRow[]>("/api/numbers") });

export const preferencesQuery = () =>
  queryOptions({ queryKey: ["preferences"], queryFn: () => api<Preferences>("/api/preferences") });

export const billingQuery = () =>
  queryOptions({
    queryKey: ["billing"],
    queryFn: () => api<Billing>("/api/billing"),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

export const configQuery = () =>
  queryOptions({ queryKey: ["status", "config"], queryFn: () => api<ConfigStatus>("/api/status/config") });

export const syncNumbers = () =>
  api<{ added: number; updated: number; released: number; numbers: PhoneNumberRow[] }>("/api/numbers/sync", {
    method: "POST",
  });
export const patchNumber = (id: string, json: { friendlyName?: string; isDefault?: true }) =>
  api<PhoneNumberRow[]>(`/api/numbers/${id}`, { method: "PATCH", json });
export const removeNumber = (id: string) => api<PhoneNumberRow[]>(`/api/numbers/${id}`, { method: "DELETE" });
export const connectNumber = (id: string) =>
  api<ConnectResult>(`/api/numbers/${id}/connect`, { method: "POST", json: {} });
export const restoreNumber = (id: string) =>
  api<ConnectResult>(`/api/numbers/${id}/restore`, { method: "POST", json: {} });
export const addBackNumber = (id: string) =>
  api<PhoneNumberRow[]>(`/api/numbers/${id}/restore-number`, { method: "POST", json: {} });
export const savePreferences = (json: Partial<Preferences>) =>
  api<Preferences>("/api/preferences", { method: "PUT", json });
export const testTwilio = () =>
  api<TwilioTestResult>("/api/status/twilio-test", { method: "POST", json: {} });
