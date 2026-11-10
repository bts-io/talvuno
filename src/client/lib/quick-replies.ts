import { queryOptions } from "@tanstack/react-query";
import type { MissedCallText, QuickReply } from "../../contracts/messages";
import { api } from "./api";

// Outside the live-event roots: these lists only change when the owner edits them.
export const quickRepliesQuery = () =>
  queryOptions({ queryKey: ["quick-replies"], queryFn: () => api<QuickReply[]>("/api/quick-replies") });

export const addQuickReply = (text: string) =>
  api<QuickReply>("/api/quick-replies", { method: "POST", json: { text } });
export const saveQuickReply = (id: string, text: string) =>
  api<QuickReply>(`/api/quick-replies/${encodeURIComponent(id)}`, { method: "PATCH", json: { text } });
export const removeQuickReply = (id: string) =>
  api(`/api/quick-replies/${encodeURIComponent(id)}`, { method: "DELETE" });

export const missedCallTextsQuery = () =>
  queryOptions({
    queryKey: ["missed-call-text"],
    queryFn: () => api<MissedCallText[]>("/api/missed-call-text"),
  });

export const saveMissedCallText = (numberId: string, json: { enabled: boolean; text: string }) =>
  api<MissedCallText>(`/api/missed-call-text/${encodeURIComponent(numberId)}`, { method: "PUT", json });

export { declineTextNumber, declineWithText, fillDraft } from "../../lib/quick-replies";
