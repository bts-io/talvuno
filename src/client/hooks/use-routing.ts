/** Call routing settings and the block list, for Settings and the block buttons. */
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BlockedNumber, NumberRouting, NumberRoutingInput } from "../../contracts/routing";
import { api } from "../lib/api";

export const routingQuery = () =>
  queryOptions({
    queryKey: ["routing"],
    queryFn: () => api<{ dnd: boolean; numbers: NumberRouting[] }>("/api/routing"),
  });

export const blockedQuery = () =>
  queryOptions({
    queryKey: ["routing", "blocked"],
    queryFn: async () => (await api<{ items: BlockedNumber[] }>("/api/routing/blocked")).items,
  });

export const saveDnd = (dnd: boolean) =>
  api<{ dnd: boolean }>("/api/routing/dnd", { method: "PUT", json: { dnd } });

export const saveNumberRouting = (numberId: string, json: NumberRoutingInput) =>
  api<NumberRouting>(`/api/routing/numbers/${encodeURIComponent(numberId)}`, { method: "PUT", json });

export const blockAddress = (address: string) =>
  api("/api/routing/blocked", { method: "POST", json: { address } });

export const unblockAddress = (address: string) =>
  api(`/api/routing/blocked/${encodeURIComponent(address)}`, { method: "DELETE" });

/** Whether `address` is blocked, and a toggle for it. Used by Recents, the thread header and contacts. */
export function useBlockToggle(address: string | null | undefined) {
  const qc = useQueryClient();
  const { data } = useQuery({ ...blockedQuery(), enabled: Boolean(address) });
  const blocked = Boolean(address && data?.some((b) => b.address === address));
  const toggle = useMutation({
    mutationFn: () => (blocked ? unblockAddress(address!) : blockAddress(address!)),
    onSettled: () => qc.invalidateQueries({ queryKey: ["routing", "blocked"] }),
  });
  return { blocked, toggle };
}

/** The do not disturb switch and its current state, shared by the shell and the incoming call sheet. */
export function useDnd() {
  const qc = useQueryClient();
  const { data } = useQuery(routingQuery());
  const toggle = useMutation({
    mutationFn: saveDnd,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["routing"] }),
  });
  return { dnd: data?.dnd ?? false, ready: Boolean(data), toggle };
}
