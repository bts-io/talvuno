import { ArrowClockwise, Trash } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CallRecording, CallRecordingList } from "../../contracts/recording";
import { api } from "../lib/api";
import { queryKeys } from "../lib/live";
import { Confirm } from "./settings/section";
import { SummaryBlock } from "./voicemail-list";

/** The recordings of one call, each with its player and transcript. Keyed under ["calls"] for live events. */
export function CallRecordings({ callId }: { callId: string }) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: [...queryKeys.calls, callId, "recordings"],
    queryFn: () => api<CallRecordingList>(`/api/calls/${callId}/recordings`),
  });
  if (query.isError)
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {t("recording.recents.loadFailed")}
      </p>
    );
  if (query.isPending) return <p className="text-sm text-slate-500">{t("recents.loading")}</p>;
  if (!query.data.items.length)
    return <p className="text-sm text-slate-500 dark:text-slate-400">{t("recording.recents.empty")}</p>;
  return (
    <ul className="flex flex-col gap-3">
      {query.data.items.map((r) => (
        <RecordingItem key={r.id} rec={r} />
      ))}
    </ul>
  );
}

function RecordingItem({ rec }: { rec: CallRecording }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.calls });
  const remove = useMutation({
    mutationFn: () => api(`/api/recordings/${rec.id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  const retry = useMutation({
    mutationFn: () => api(`/api/recordings/${rec.id}/transcribe`, { method: "POST" }),
    onSuccess: refresh,
  });

  return (
    <li className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {rec.audioReady ? (
          // biome-ignore lint/a11y/useMediaCaption: the transcript below is the text alternative.
          <audio
            controls
            preload="none"
            src={`/api/recordings/${rec.id}/audio`}
            className="h-10 min-w-0 flex-1"
          />
        ) : (
          <p className="flex-1 text-sm text-slate-500 dark:text-slate-400">
            {t("recording.recents.audioPending")}
          </p>
        )}
        <button
          type="button"
          onClick={() => setConfirming(true)}
          aria-label={t("recording.recents.delete")}
          className="shrink-0 rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-navy-800"
        >
          <Trash aria-hidden className="size-5" />
        </button>
      </div>

      {rec.transcriptStatus === "done" ? (
        <p className="text-sm whitespace-pre-line text-slate-700 dark:text-slate-200" dir="auto">
          {rec.transcript || t("recording.recents.noSpeech")}
        </p>
      ) : rec.transcriptStatus === "failed" ? (
        <p className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
          {t("recording.recents.transcriptFailed")}
          <button
            type="button"
            onClick={() => retry.mutate()}
            disabled={retry.isPending}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 font-medium text-brand-blue hover:bg-brand-blue/10 disabled:opacity-60"
          >
            <ArrowClockwise aria-hidden className="size-4" />
            {t("recording.recents.retry")}
          </button>
        </p>
      ) : rec.audioReady ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{t("recording.recents.transcribing")}</p>
      ) : null}

      {rec.aiSummary ? <SummaryBlock summary={rec.aiSummary} kind="call" /> : null}

      {confirming ? (
        <Confirm
          message={t("recording.recents.deleteConfirm")}
          confirmLabel={t("recording.recents.delete")}
          cancelLabel={t("settings.cancel")}
          busy={remove.isPending}
          danger
          onConfirm={() => remove.mutate()}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
      {remove.isError ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t("recording.recents.deleteFailed")}
        </p>
      ) : null}
    </li>
  );
}
