import { Archive, MagnifyingGlass, NotePencil, PushPin } from "@phosphor-icons/react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, useChildMatches } from "@tanstack/react-router";
import { clsx } from "clsx";
import { useDeferredValue, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConversationListItem, SearchResult } from "../../contracts/messages";
import { formatPhone } from "../../lib/phone";
import { useLongPress } from "../components/row-menu";
import { ThreadRowMenu } from "../components/thread-actions";
import { conversationsQuery, displayAddress, searchQuery, smsNumbersQuery } from "../lib/messages";

/**
 * Messages: the thread list. On phones it fills the screen and a thread replaces it; from `md` up the list
 * stays on the start side and the open thread (child route) shows beside it.
 */
export const Route = createFileRoute("/_app/messages")({ component: MessagesLayout });

function MessagesLayout() {
  const children = useChildMatches();
  const childOpen = children.length > 0;
  return (
    <div className="flex h-[calc(100dvh-5rem)] md:h-dvh">
      <section
        className={clsx(
          "flex w-full flex-col border-e border-slate-200 md:w-80 md:shrink-0 lg:w-96 dark:border-navy-800",
          childOpen && "hidden md:flex",
        )}
      >
        <ThreadList />
      </section>
      <div className={clsx("min-w-0 flex-1", !childOpen && "hidden md:block")}>
        {childOpen ? <Outlet /> : <EmptyPane />}
      </div>
    </div>
  );
}

function EmptyPane() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center p-8 text-slate-500 dark:text-slate-400">
      {t("messages.selectThread")}
    </div>
  );
}

function ThreadList() {
  const { t } = useTranslation();
  const [numberId, setNumberId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const q = useDeferredValue(search.trim());
  const numbers = useQuery(smsNumbersQuery());
  const [archived, setArchived] = useState(false);
  const list = useInfiniteQuery(conversationsQuery(numberId, "", archived));
  const found = useQuery(searchQuery(q));
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const many = (numbers.data?.length ?? 0) > 1;

  return (
    <>
      <header className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">
            {archived ? t("messages.archivedTitle") : t("messages.title")}
          </h1>
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => setArchived((v) => !v)}
              aria-pressed={archived}
              className={clsx(
                "rounded-full p-2 hover:bg-brand-blue/10",
                archived ? "bg-brand-blue/10 text-brand-blue" : "text-slate-500",
              )}
              aria-label={archived ? t("messages.showInbox") : t("messages.showArchived")}
              title={archived ? t("messages.showInbox") : t("messages.showArchived")}
            >
              <Archive aria-hidden className="size-6" />
            </button>
            <Link
              to="/messages/new"
              className="rounded-full p-2 text-brand-blue hover:bg-brand-blue/10"
              aria-label={t("messages.new")}
              title={t("messages.new")}
            >
              <NotePencil aria-hidden className="size-6" />
            </Link>
          </div>
        </div>
        <label className="relative block">
          <span className="sr-only">{t("messages.search")}</span>
          <MagnifyingGlass
            aria-hidden
            className="pointer-events-none absolute start-3 top-2.5 size-5 text-slate-400"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("messages.search")}
            className="w-full rounded-lg border border-slate-200 bg-white py-2 ps-10 pe-3 dark:border-navy-700 dark:bg-navy-900"
          />
        </label>
        {many && (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-slate-500 dark:text-slate-400">{t("messages.filterNumber")}</span>
            <select
              value={numberId ?? ""}
              onChange={(e) => setNumberId(e.target.value || null)}
              className="flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 dark:border-navy-700 dark:bg-navy-900"
            >
              <option value="">{t("messages.allNumbers")}</option>
              {numbers.data!.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.friendlyName || formatPhone(n.e164)}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      <div className="flex-1 overflow-y-auto">
        {q ? (
          <SearchResults q={q} data={found.data} loading={found.isPending} />
        ) : list.isPending ? (
          <p className="p-4 text-slate-500">{t("messages.loading")}</p>
        ) : items.length === 0 ? (
          <p className="p-4 text-slate-500 dark:text-slate-400">
            {archived ? t("messages.emptyArchived") : t("messages.empty")}
          </p>
        ) : (
          <ul>
            {items.map((c) => (
              <ThreadRow key={c.id} c={c} showNumber={many && !numberId} />
            ))}
          </ul>
        )}
        {!q && list.hasNextPage && (
          <button
            type="button"
            onClick={() => list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
            className="w-full p-3 text-sm text-brand-blue"
          >
            {list.isFetchingNextPage ? t("messages.loading") : t("messages.loadMore")}
          </button>
        )}
      </div>
    </>
  );
}

function timeLabel(ms: number | null, locale: string) {
  if (!ms) return "";
  const d = new Date(ms);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

function ThreadRow({ c, showNumber }: { c: ConversationListItem; showNumber: boolean }) {
  const { t, i18n } = useTranslation();
  const unread = c.unreadCount > 0 || c.markedUnread;
  const [menuOpen, setMenuOpen] = useState(false);
  const press = useLongPress(() => setMenuOpen(true), { touchOnly: true });
  return (
    <li className="relative" {...press}>
      <Link
        to="/messages/$conversationId"
        params={{ conversationId: c.id }}
        className="flex items-start gap-3 border-b border-slate-100 px-4 py-3 hover:bg-slate-100 dark:border-navy-800 dark:hover:bg-navy-800"
        activeProps={{ className: "bg-brand-blue/10 dark:bg-brand-blue/15" }}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span
              className={clsx("flex min-w-0 items-center gap-1", unread ? "font-semibold" : "font-medium")}
            >
              {c.pinnedAt ? (
                <PushPin
                  aria-label={t("messages.pinned")}
                  weight="fill"
                  className="size-3.5 shrink-0 text-slate-400"
                />
              ) : null}
              <span className="truncate">{c.contactName ?? displayAddress(c.participant)}</span>
            </span>
            <time className="me-8 shrink-0 text-xs text-slate-500 dark:text-slate-400">
              {timeLabel(c.lastMessageAt, i18n.language)}
            </time>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p
              className={clsx(
                "truncate text-sm",
                unread ? "text-slate-900 dark:text-slate-100" : "text-slate-500 dark:text-slate-400",
              )}
            >
              {c.lastMessagePreview || t("messages.attachment")}
            </p>
            {unread && (
              <span
                className="shrink-0 rounded-full bg-brand-blue px-2 py-0.5 text-xs font-semibold text-white"
                role="img"
                aria-label={
                  c.unreadCount > 0
                    ? t("messages.unread", { count: c.unreadCount })
                    : t("messages.markedUnread")
                }
              >
                {c.unreadCount > 0 ? c.unreadCount : " "}
              </span>
            )}
          </div>
          {showNumber && <p className="text-xs text-slate-400">{formatPhone(c.numberE164)}</p>}
        </div>
      </Link>
      <ThreadRowMenu c={c} open={menuOpen} setOpen={setMenuOpen} />
    </li>
  );
}

function SearchResults({
  q,
  data,
  loading,
}: {
  q: string;
  data: SearchResult | undefined;
  loading: boolean;
}) {
  const { t } = useTranslation();
  if (loading || !data) return <p className="p-4 text-slate-500">{t("messages.loading")}</p>;
  if (data.conversations.length === 0 && data.messages.length === 0)
    return <p className="p-4 text-slate-500 dark:text-slate-400">{t("messages.noResults")}</p>;
  return (
    <section aria-label={t("messages.searchResults")}>
      <ul>
        {data.conversations.map((c) => (
          <ThreadRow key={c.id} c={c} showNumber={false} />
        ))}
      </ul>
      <ul>
        {data.messages.map((m) => (
          <li key={m.id}>
            <Link
              to="/messages/$conversationId"
              params={{ conversationId: m.conversationId }}
              className="block border-b border-slate-100 px-4 py-3 hover:bg-slate-100 dark:border-navy-800 dark:hover:bg-navy-800"
            >
              <span className="block truncate font-medium">
                {m.contactName ?? displayAddress(m.participant)}
              </span>
              <Highlight text={m.body} q={q} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Highlight({ text, q }: { text: string; q: string }) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  const start = Math.max(0, i - 40);
  const shown = text.slice(start, start + 160);
  if (i < 0) return <span className="block truncate text-sm text-slate-500">{shown}</span>;
  const at = i - start;
  return (
    <span className="block truncate text-sm text-slate-500 dark:text-slate-400">
      {start > 0 && "..."}
      {shown.slice(0, at)}
      <mark className="rounded bg-amber-200/70 px-0.5 text-inherit dark:bg-amber-400/30">
        {shown.slice(at, at + q.length)}
      </mark>
      {shown.slice(at + q.length)}
    </span>
  );
}
