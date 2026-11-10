import { ArrowLeft, Paperclip, WarningCircle } from "@phosphor-icons/react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { clsx } from "clsx";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ThreadMessage } from "../../contracts/messages";
import { isE164 } from "../../lib/phone";
import { BlockButton } from "../components/block-button";
import { SmsComposer } from "../components/sms-composer";
import { ThreadHeaderActions } from "../components/thread-actions";

import { queryKeys } from "../lib/live";
import {
  conversationQuery,
  displayAddress,
  failureText,
  markRead,
  newClientId,
  threadQuery,
  useSendMessage,
} from "../lib/messages";

const blockInHeader =
  "inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-navy-800";

/** One conversation: bubbles newest at the bottom, older pages on demand, and the composer. */
export const Route = createFileRoute("/_app/messages/$conversationId")({ component: ThreadPage });

function ThreadPage() {
  const { conversationId } = Route.useParams();
  const { t } = useTranslation();
  const qc = useQueryClient();
  const conversation = useQuery(conversationQuery(conversationId));
  const thread = useInfiniteQuery(threadQuery(conversationId));
  const send = useSendMessage();
  const navigate = useNavigate();
  const bottom = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const c = conversation.data;

  // Newest first from the API; shown oldest first.
  const items = (thread.data?.pages.flatMap((p) => p.items) ?? []).slice().reverse();
  const newestId = items[items.length - 1]?.id;

  // Opening the thread (and any new message arriving while it is open) marks it read.
  const unread = (c?.unreadCount ?? 0) + (c?.markedUnread ? 1 : 0);
  useEffect(() => {
    if (unread > 0)
      void markRead(conversationId).then(() => qc.invalidateQueries({ queryKey: queryKeys.conversations }));
  }, [conversationId, unread, qc]);

  // Keep the newest message in view when one arrives (not when older pages load above).
  useEffect(() => {
    if (newestId) bottom.current?.scrollIntoView({ block: "end" });
  }, [newestId]);

  const sendBody = async (body: string, clientId = newClientId()) => {
    if (!c) return false;
    setError(null);
    try {
      await send.mutateAsync({
        input: { numberId: c.numberId, to: c.participant, body, conversationId, from: c.numberE164 },
        clientId,
      });
      return true;
    } catch (err) {
      setError(failureText(t, err));
      return false;
    }
  };

  const title = c ? (c.contactName ?? displayAddress(c.participant)) : "";
  const canReply = c ? isE164(c.participant) : true;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-slate-200 p-3 dark:border-navy-800">
        <Link
          to="/messages"
          className="rounded-full p-2 md:hidden"
          aria-label={t("messages.back")}
          title={t("messages.back")}
        >
          <ArrowLeft aria-hidden className="size-5 rtl:-scale-x-100" />
        </Link>
        <div className="min-w-0">
          <h1 className="truncate font-semibold">{title}</h1>
          {c?.contactName && (
            <p className="truncate text-xs text-slate-500">{displayAddress(c.participant)}</p>
          )}
        </div>
        {c ? (
          <ThreadHeaderActions
            c={c}
            // Archiving or marking unread sends you back to the list, like closing the thread.
            onDone={(flag) => {
              if (flag === "archive" || flag === "unread") void navigate({ to: "/messages" });
            }}
          />
        ) : null}
        <BlockButton address={c?.participant} className={blockInHeader} />
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-4" aria-live="polite">
        {thread.hasNextPage && (
          <div className="mb-3 text-center">
            <button
              type="button"
              onClick={() => thread.fetchNextPage()}
              disabled={thread.isFetchingNextPage}
              className="rounded-full px-3 py-1 text-sm text-brand-blue hover:bg-brand-blue/10"
            >
              {thread.isFetchingNextPage ? t("messages.loading") : t("messages.loadOlder")}
            </button>
          </div>
        )}
        {thread.isPending && <p className="text-center text-slate-500">{t("messages.loading")}</p>}
        <ol className="flex flex-col gap-1.5">
          {items.map((m) => (
            <Bubble key={m.id} m={m} onRetry={() => void sendBody(m.body)} />
          ))}
        </ol>
        <div ref={bottom} />
      </div>

      {error && (
        <p
          role="alert"
          className="border-t border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </p>
      )}
      {canReply ? (
        <SmsComposer draftKey={conversationId} disabled={!c} onSend={(body) => sendBody(body)} />
      ) : (
        <p className="border-t border-slate-200 p-4 text-center text-sm text-slate-500 dark:border-navy-800">
          {t("messages.cannotReply")}
        </p>
      )}
    </div>
  );
}

const FAILED = new Set(["failed", "undelivered", "canceled"]);

function Bubble({ m, onRetry }: { m: ThreadMessage; onRetry: () => void }) {
  const { t, i18n } = useTranslation();
  const out = m.direction === "outbound";
  const failed = out && FAILED.has(m.status);
  const time = new Date(m.createdAt).toLocaleString(i18n.language, {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  });
  return (
    <li className={clsx("flex flex-col", out ? "items-end" : "items-start")}>
      <div
        className={clsx(
          "max-w-[80%] rounded-2xl px-3.5 py-2 break-words whitespace-pre-wrap",
          out
            ? failed
              ? "rounded-ee-md bg-red-50 text-red-900 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-100 dark:ring-red-900"
              : "rounded-ee-md bg-brand-blue text-white"
            : "rounded-es-md bg-white text-slate-900 ring-1 ring-slate-200 dark:bg-navy-800 dark:text-slate-100 dark:ring-navy-700",
        )}
      >
        {m.body}
        {m.media && (
          <span className="mt-1 flex items-center gap-1.5 text-sm opacity-80">
            <Paperclip aria-hidden className="size-4 shrink-0" />
            {t("messages.attachmentDetail", { count: m.media.count, types: m.media.contentTypes.join(", ") })}
          </span>
        )}
      </div>
      <span className="mt-0.5 flex items-center gap-1.5 px-1 text-[11px] text-slate-400">
        <time dateTime={new Date(m.createdAt).toISOString()}>{time}</time>
        {out && !failed && <span>{t(`messages.status.${m.status}`)}</span>}
      </span>
      {failed && (
        <span className="flex items-center gap-2 px-1 text-xs text-red-600 dark:text-red-400">
          <WarningCircle aria-hidden className="size-4" />
          {m.errorMessage
            ? t("messages.failedReason", { reason: m.errorMessage })
            : t(`messages.status.${m.status}`)}
          <button type="button" onClick={onRetry} className="font-medium underline">
            {t("messages.retry")}
          </button>
        </span>
      )}
    </li>
  );
}
