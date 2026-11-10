import { ArrowClockwise, Sparkle, Trash, Voicemail as VoicemailIcon } from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AiSummary } from "../../contracts/ai-summary";
import type { Voicemail, VoicemailList as VoicemailPage } from "../../contracts/voicemail";
import { formatPhone, isE164 } from "../../lib/phone";
import { api } from "../lib/api";
import { queryKeys } from "../lib/live";
import { Confirm } from "./settings/section";

/** "0:42" for 42 seconds. */
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/** The Voicemail tab of Recents: newest first, with a player, the transcript, unheard dots and delete. */
export function VoicemailList({ when }: { when: (at: number) => string }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const q = useDeferredValue(search.trim());
  const query = useInfiniteQuery({
    queryKey: [...queryKeys.voicemails, q],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (pageParam) params.set("cursor", pageParam);
      return api<VoicemailPage>(`/api/voicemails?${params}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="flex flex-col gap-3">
      <label className="block">
        <span className="sr-only">{t("voicemail.search")}</span>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("voicemail.search")}
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-navy-700 dark:bg-navy-950"
        />
      </label>
      {query.isError ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t("voicemail.loadFailed")}
        </p>
      ) : query.isPending ? (
        <p className="text-slate-500">{t("recents.loading")}</p>
      ) : items.length === 0 ? (
        <p className="text-slate-500 dark:text-slate-400">{t(q ? "voicemail.noMatch" : "voicemail.empty")}</p>
      ) : (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200 bg-white dark:divide-navy-800 dark:border-navy-800 dark:bg-navy-900">
          {items.map((vm) => (
            <VoicemailRow key={vm.id} vm={vm} when={when} />
          ))}
        </ul>
      )}
      {query.hasNextPage ? (
        <button
          type="button"
          onClick={() => query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
          className="self-center rounded-lg px-4 py-2 text-sm font-medium text-brand-blue hover:bg-brand-blue/10 disabled:opacity-60"
        >
          {query.isFetchingNextPage ? t("recents.loading") : t("recents.loadMore")}
        </button>
      ) : null}
    </div>
  );
}

function VoicemailRow({ vm, when }: { vm: Voicemail; when: (at: number) => string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.voicemails });

  const listened = useMutation({
    mutationFn: () => api(`/api/voicemails/${vm.id}/listened`, { method: "POST" }).catch(() => undefined),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/voicemails/${vm.id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  const retry = useMutation({
    mutationFn: () => api(`/api/voicemails/${vm.id}/transcribe`, { method: "POST" }),
    onSuccess: refresh,
  });

  const name = isE164(vm.from)
    ? (vm.contactName ?? formatPhone(vm.from))
    : ["anonymous", "restricted"].includes(vm.from)
      ? t("recents.withheld")
      : t("recents.unknownCaller");
  const unheard = vm.listenedAt === null;
  const details = [vm.duration ? clock(vm.duration) : null, when(vm.createdAt)].filter(Boolean);

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-center gap-3">
        <VoicemailIcon aria-hidden className="size-5 shrink-0 text-slate-500 dark:text-slate-400" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            {unheard ? <span aria-hidden className="size-2 shrink-0 rounded-full bg-brand-blue" /> : null}
            <span className={`block truncate ${unheard ? "font-semibold" : "font-medium"}`} dir="auto">
              {name}
            </span>
            {unheard ? <span className="sr-only">{t("voicemail.unheard")}</span> : null}
          </span>
          {vm.aiSummary?.oneLiner ? (
            <span className="block truncate text-sm text-slate-700 dark:text-slate-200" dir="auto">
              {vm.aiSummary.oneLiner}
            </span>
          ) : null}
          <span className="block truncate text-sm text-slate-500 dark:text-slate-400">
            {details.join(" · ")}
          </span>
        </span>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          aria-label={t("voicemail.delete")}
          className="shrink-0 rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-navy-800"
        >
          <Trash aria-hidden className="size-5" />
        </button>
      </div>

      {vm.audioReady ? (
        // biome-ignore lint/a11y/useMediaCaption: the transcript below is the text alternative.
        <audio
          controls
          preload="none"
          src={`/api/voicemails/${vm.id}/audio`}
          onPlay={() => (unheard && !listened.isPending ? listened.mutate() : undefined)}
          className="h-10 w-full"
        />
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400">{t("voicemail.audioPending")}</p>
      )}

      {vm.transcriptStatus === "done" ? (
        <p className="text-sm whitespace-pre-line text-slate-700 dark:text-slate-200" dir="auto">
          {vm.transcript || t("voicemail.noSpeech")}
        </p>
      ) : vm.transcriptStatus === "failed" ? (
        <p className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
          {t("voicemail.transcriptFailed")}
          <button
            type="button"
            onClick={() => retry.mutate()}
            disabled={retry.isPending}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 font-medium text-brand-blue hover:bg-brand-blue/10 disabled:opacity-60"
          >
            <ArrowClockwise aria-hidden className="size-4" />
            {t("voicemail.retry")}
          </button>
        </p>
      ) : vm.audioReady ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{t("voicemail.transcribing")}</p>
      ) : null}

      {vm.aiSummary ? <SummaryBlock summary={vm.aiSummary} /> : null}

      {confirming ? (
        <Confirm
          message={t("voicemail.deleteConfirm", { name })}
          confirmLabel={t("voicemail.delete")}
          cancelLabel={t("settings.cancel")}
          busy={remove.isPending}
          danger
          onConfirm={() => remove.mutate()}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
      {remove.isError ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t("voicemail.deleteFailed")}
        </p>
      ) : null}
    </li>
  );
}

/**
 * The AI summary of a voicemail or a recorded call and what was asked for, labelled so it is never taken for
 * the transcript.
 */
export function SummaryBlock({
  summary,
  kind = "voicemail",
}: {
  summary: AiSummary;
  kind?: "voicemail" | "call";
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-navy-800">
      <span className="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
        <Sparkle aria-hidden className="size-3.5" />
        {t("voicemail.aiLabel")}
      </span>
      <p className="text-slate-700 dark:text-slate-200" dir="auto">
        {summary.summary}
      </p>
      {summary.actionItems.length ? (
        <>
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {t(kind === "call" ? "recording.followUps" : "voicemail.actionItems")}
          </span>
          <ul className="list-disc ps-5 text-slate-700 dark:text-slate-200">
            {summary.actionItems.map((item) => (
              <li key={item} dir="auto">
                {item}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
