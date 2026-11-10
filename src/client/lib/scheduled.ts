import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ScheduledMessage, ScheduleInput } from "../../contracts/scheduled";
import { preferencesQuery } from "../hooks/use-settings";
import { api } from "./api";
import { queryKeys } from "./live";

// Under the ["conversations"] live root, so a message or thread event (a scheduled text going out, or failing
// on a thread that exists) refreshes these lists too.
const root = [...queryKeys.conversations, "scheduled"] as const;

export const scheduledQuery = (thread?: { numberId: string; to: string }) =>
  queryOptions({
    queryKey: [...root, thread ? `${thread.numberId}:${thread.to}` : "all"],
    queryFn: () => {
      const params = new URLSearchParams();
      if (thread) {
        params.set("numberId", thread.numberId);
        params.set("to", thread.to);
      }
      return api<ScheduledMessage[]>(`/api/scheduled-messages?${params}`);
    },
  });

export function useScheduleMutations() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: root });
  return {
    create: useMutation({
      mutationFn: (json: ScheduleInput) =>
        api<ScheduledMessage>("/api/scheduled-messages", { method: "POST", json }),
      onSuccess: done,
    }),
    edit: useMutation({
      mutationFn: ({ id, ...json }: { id: string; body?: string; sendAt?: number }) =>
        api<ScheduledMessage>(`/api/scheduled-messages/${encodeURIComponent(id)}`, { method: "PATCH", json }),
      onSuccess: done,
    }),
    cancel: useMutation({
      mutationFn: (id: string) =>
        api<ScheduledMessage>(`/api/scheduled-messages/${encodeURIComponent(id)}`, { method: "DELETE" }),
      onSuccess: done,
    }),
  };
}

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/** The owner's time zone: the digest preference, or this browser's zone until one was chosen. */
export function useOwnerZone(): string {
  const { data } = useQuery(preferencesQuery());
  return data && data.timezone !== "UTC" ? data.timezone : browserZone();
}

/** "Mon 3 Nov, 9:00 am" for `ms` in `timeZone`. */
export function formatScheduled(ms: number, timeZone: string, locale: string): string {
  try {
    return new Date(ms).toLocaleString(locale, {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return new Date(ms).toLocaleString(locale);
  }
}
