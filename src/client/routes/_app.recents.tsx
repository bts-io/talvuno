import { PhoneIncoming, PhoneOutgoing, PhoneX, UserPlus } from "@phosphor-icons/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import type { CallEntry, CallFilter, CallList } from "../../contracts/contacts";
import { formatPhone, isE164 } from "../../lib/phone";
import { BlockButton } from "../components/block-button";
import { VoicemailList } from "../components/voicemail-list";
import { api } from "../lib/api";
import { queryKeys } from "../lib/live";
import { callFailureKey } from "../lib/voice";

/** The call filters plus the Voicemail tab, which lists recorded messages instead of calls. */
type Tab = CallFilter | "voicemail";
const FILTERS: Tab[] = ["all", "missed", "voicemail"];

export const Route = createFileRoute("/_app/recents")({
  validateSearch: z.object({ filter: z.enum(["all", "missed", "voicemail"]).optional().catch(undefined) }),
  component: RecentsPage,
});

/** "3:07" for a call that lasted 187 seconds; hours roll into the minutes field only past one hour. */
function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function relativeTime(at: number, lng: string, justNow: string): string {
  const diff = (at - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return justNow;
  const rtf = new Intl.RelativeTimeFormat(lng, { numeric: "auto" });
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 7 * 86_400) return rtf.format(Math.round(diff / 86_400), "day");
  return new Date(at).toLocaleDateString(lng, { year: "numeric", month: "short", day: "numeric" });
}

function RecentsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const filter: Tab = Route.useSearch().filter ?? "all";
  const setFilter = (f: Tab) =>
    navigate({ to: "/recents", search: f === "all" ? {} : { filter: f }, replace: true });
  const query = useInfiniteQuery({
    enabled: filter !== "voicemail",
    queryKey: [...queryKeys.calls, filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ filter });
      if (pageParam) params.set("cursor", pageParam);
      return api<CallList>(`/api/calls?${params}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 md:p-8">
      <h1 className="text-2xl font-semibold tracking-tight">{t("recents.title")}</h1>

      <div
        role="tablist"
        aria-label={t("recents.filter")}
        className="grid grid-cols-3 gap-1 rounded-xl bg-slate-200/70 p-1 dark:bg-navy-800"
      >
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={`rounded-lg py-2 text-sm font-medium ${
              filter === f
                ? "bg-white text-brand-blue shadow-sm dark:bg-navy-950"
                : "text-slate-600 dark:text-slate-300"
            }`}
          >
            {t(`recents.${f}`)}
          </button>
        ))}
      </div>

      {filter === "voicemail" ? (
        <VoicemailList when={(at) => relativeTime(at, i18n.language, t("recents.justNow"))} />
      ) : query.isError ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t("recents.loadFailed")}
        </p>
      ) : query.isPending ? (
        <p className="text-slate-500">{t("recents.loading")}</p>
      ) : items.length === 0 ? (
        <p className="text-slate-500 dark:text-slate-400">
          {t(filter === "missed" ? "recents.emptyMissed" : "recents.empty")}
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200 bg-white dark:divide-navy-800 dark:border-navy-800 dark:bg-navy-900">
          {items.map((call) => (
            <CallRow key={call.id} call={call} />
          ))}
        </ul>
      )}

      {filter !== "voicemail" && query.hasNextPage ? (
        <button
          type="button"
          onClick={() => query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
          className="self-center rounded-lg px-4 py-2 text-sm font-medium text-brand-blue hover:bg-brand-blue/10 disabled:opacity-60"
        >
          {query.isFetchingNextPage ? t("recents.loading") : t("recents.loadMore")}
        </button>
      ) : null}
    </section>
  );
}

function CallRow({ call }: { call: CallEntry }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const dialable = isE164(call.party);
  // Withheld and unknown callers have no number to dial or save.
  const name = dialable
    ? (call.contactName ?? formatPhone(call.party))
    : ["anonymous", "restricted"].includes(call.party)
      ? t("recents.withheld")
      : t("recents.unknownCaller");
  const Icon = call.missed ? PhoneX : call.direction === "inbound" ? PhoneIncoming : PhoneOutgoing;
  const routed = call.outcome === "voicemail" || call.outcome === "declined" || call.outcome === "blocked";
  const kind = call.missed
    ? "recents.missedCall"
    : routed
      ? `routing.outcome.${call.outcome}`
      : call.direction === "inbound"
        ? "recents.incoming"
        : "recents.outgoing";
  const when = call.startedAt ?? call.endedAt;
  const details = [
    t(kind),
    call.duration ? formatDuration(call.duration) : null,
    when ? relativeTime(when, i18n.language, t("recents.justNow")) : null,
  ].filter(Boolean);

  // Why a call we placed did not connect, in words, when Twilio gave a reason.
  const failure =
    call.direction === "outbound" && call.errorCode
      ? t(`voice.errors.${callFailureKey(call.errorCode)}`, { code: call.errorCode })
      : null;

  return (
    <li className="flex items-center gap-1 pe-2">
      {dialable ? (
        <button
          type="button"
          onClick={() => navigate({ href: `/keypad?to=${encodeURIComponent(call.party)}` })}
          aria-label={t("recents.callBack", { name })}
          className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-start hover:bg-slate-50 dark:hover:bg-navy-800"
        >
          <Icon
            aria-hidden
            className={`size-5 shrink-0 ${call.missed ? "text-red-600 dark:text-red-400" : "text-slate-500 dark:text-slate-400"}`}
          />
          <span className="min-w-0">
            <span
              className={`block truncate font-medium ${call.missed ? "text-red-600 dark:text-red-400" : ""}`}
              dir="auto"
            >
              {name}
            </span>
            <span className="block truncate text-sm text-slate-500 dark:text-slate-400">
              {details.join(" · ")}
            </span>
            {failure ? <span className="block text-sm text-red-600 dark:text-red-400">{failure}</span> : null}
          </span>
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-start">
          <Icon
            aria-hidden
            className={`size-5 shrink-0 ${call.missed ? "text-red-600 dark:text-red-400" : "text-slate-500 dark:text-slate-400"}`}
          />
          <span className="min-w-0">
            <span
              className={`block truncate font-medium ${call.missed ? "text-red-600 dark:text-red-400" : ""}`}
              dir="auto"
            >
              {name}
            </span>
            <span className="block truncate text-sm text-slate-500 dark:text-slate-400">
              {details.join(" · ")}
            </span>
            {failure ? <span className="block text-sm text-red-600 dark:text-red-400">{failure}</span> : null}
          </span>
        </div>
      )}
      {dialable ? <BlockButton address={call.party} /> : null}
      {call.contactName || !dialable ? null : (
        <button
          type="button"
          onClick={() => navigate({ href: `/contacts?add=${encodeURIComponent(call.party)}` })}
          className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-2 text-sm text-brand-blue hover:bg-brand-blue/10"
        >
          <UserPlus aria-hidden className="size-4" />
          {t("recents.saveContact")}
        </button>
      )}
    </li>
  );
}
