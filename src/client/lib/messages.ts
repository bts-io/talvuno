import {
  type InfiniteData,
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  ConversationListItem,
  Page,
  SearchResult,
  SendSmsResult,
  SmsNumber,
  ThreadMessage,
} from "../../contracts/messages";
import { formatPhone } from "../../lib/phone";
import { ApiError, api } from "./api";
import { queryKeys } from "./live";

/** Every query here sits under the live roots ["conversations"] and ["messages", id], so events refresh them. */
export const smsNumbersQuery = () =>
  queryOptions({
    queryKey: [...queryKeys.conversations, "numbers"],
    queryFn: () => api<SmsNumber[]>("/api/messages/numbers"),
    staleTime: 60_000,
  });

export const conversationsQuery = (numberId: string | null, q: string, archived = false) =>
  infiniteQueryOptions({
    queryKey: [...queryKeys.conversations, "list", numberId ?? "all", q, archived ? "archived" : "main"],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (numberId) params.set("numberId", numberId);
      if (archived) params.set("archived", "1");
      if (q) params.set("q", q);
      if (pageParam) params.set("cursor", pageParam);
      return api<Page<ConversationListItem>>(`/api/messages/conversations?${params}`);
    },
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const conversationQuery = (id: string) =>
  queryOptions({
    queryKey: [...queryKeys.conversations, "one", id],
    queryFn: () => api<ConversationListItem>(`/api/messages/conversations/${encodeURIComponent(id)}`),
  });

export const threadQuery = (id: string) =>
  infiniteQueryOptions({
    queryKey: [...queryKeys.messages(id), "thread"],
    queryFn: ({ pageParam }) =>
      api<Page<ThreadMessage>>(
        `/api/messages/conversations/${encodeURIComponent(id)}/messages${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const searchQuery = (q: string) =>
  queryOptions({
    queryKey: [...queryKeys.conversations, "search", q],
    queryFn: () => api<SearchResult>(`/api/messages/search?q=${encodeURIComponent(q)}`),
    enabled: q.length > 0,
  });

export const markRead = (id: string) =>
  api(`/api/messages/conversations/${encodeURIComponent(id)}/read`, { method: "POST" });

/** Pin, archive and mark unread. The server returns the updated thread; lists refresh through the live roots. */
export type ThreadFlag = "pin" | "unpin" | "archive" | "unarchive" | "unread" | "read";

const FLAG_REQUESTS: Record<ThreadFlag, [string, Record<string, boolean>]> = {
  pin: ["pin", { pinned: true }],
  unpin: ["pin", { pinned: false }],
  archive: ["archive", { archived: true }],
  unarchive: ["archive", { archived: false }],
  unread: ["unread", { unread: true }],
  read: ["unread", { unread: false }],
};

export function useThreadFlag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, flag }: { id: string; flag: ThreadFlag }) => {
      const [path, json] = FLAG_REQUESTS[flag];
      return api<ConversationListItem>(`/api/messages/conversations/${encodeURIComponent(id)}/${path}`, {
        method: "POST",
        json,
      });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.conversations }),
  });
}

/** Which flag change each action of a thread's menu makes, from its current state. */
export function threadFlagChoices(
  c: Pick<ConversationListItem, "pinnedAt" | "archivedAt" | "unreadCount" | "markedUnread">,
) {
  const unread = c.unreadCount > 0 || c.markedUnread;
  return {
    pin: (c.pinnedAt ? "unpin" : "pin") as ThreadFlag,
    archive: (c.archivedAt ? "unarchive" : "archive") as ThreadFlag,
    unread: (unread ? "read" : "unread") as ThreadFlag,
  };
}

export type SendInput = {
  numberId: string;
  to: string;
  body: string;
  /** Known when sending inside an open thread; enables the optimistic bubble. */
  conversationId?: string;
  from?: string;
};

type Thread = InfiniteData<Page<ThreadMessage>, string>;

function addOptimistic(qc: QueryClient, conversationId: string, message: ThreadMessage) {
  qc.setQueryData<Thread>(threadQuery(conversationId).queryKey, (data) => {
    if (!data) return data;
    const [first, ...rest] = data.pages;
    return { ...data, pages: [{ ...first!, items: [message, ...first!.items] }, ...rest] };
  });
}

function replaceByClientId(
  qc: QueryClient,
  conversationId: string,
  clientId: string,
  next: ThreadMessage | null,
) {
  qc.setQueryData<Thread>(threadQuery(conversationId).queryKey, (data) => {
    if (!data) return data;
    return {
      ...data,
      pages: data.pages.map((p) => ({
        ...p,
        items: p.items.flatMap((m) => (m.clientId === clientId ? (next ? [next] : []) : [m])),
      })),
    };
  });
}

/**
 * Sends one SMS. Each call gets a fresh clientId, so the server never sends it twice even if the request is
 * repeated. Inside a thread the bubble shows at once and is removed again if the request fails.
 */
export function useSendMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ input, clientId }: { input: SendInput; clientId: string }) =>
      api<SendSmsResult>("/api/messages/send", {
        method: "POST",
        json: { numberId: input.numberId, to: input.to, body: input.body, clientId },
      }),
    onMutate: async ({ input, clientId }) => {
      const id = input.conversationId;
      if (!id) return;
      await qc.cancelQueries({ queryKey: threadQuery(id).queryKey });
      const now = Date.now();
      addOptimistic(qc, id, {
        id: `pending-${clientId}`,
        conversationId: id,
        twilioSid: null,
        direction: "outbound",
        from: input.from ?? "",
        to: input.to,
        body: input.body,
        status: "queued",
        errorCode: null,
        errorMessage: null,
        clientId,
        media: null,
        sentAt: null,
        createdAt: now,
      });
    },
    onError: (_err, { input, clientId }) => {
      if (input.conversationId) replaceByClientId(qc, input.conversationId, clientId, null);
    },
    onSuccess: (result, { clientId }) => {
      replaceByClientId(qc, result.conversationId, clientId, result.message);
    },
    onSettled: (result, _err, { input }) => {
      const id = result?.conversationId ?? input.conversationId;
      if (id) void qc.invalidateQueries({ queryKey: queryKeys.messages(id) });
      void qc.invalidateQueries({ queryKey: queryKeys.conversations });
    },
  });
}

export const newClientId = () => crypto.randomUUID();

/** A phone number formatted for people; short codes and sender IDs as they are. */
export const displayAddress = (address: string) => (address.startsWith("+") ? formatPhone(address) : address);

/** The line shown when a send request itself fails (refused number, limit, offline). */
export function failureText(
  t: (key: string, options?: Record<string, unknown>) => string,
  err: unknown,
): string {
  const message = err instanceof ApiError ? err.message : t("errors.generic");
  return t("messages.sendFailed", { message });
}
