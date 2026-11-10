import { Pause, Record } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { LiveRecordingAction, LiveRecordingState } from "../../contracts/recording";
import { ApiError, api } from "../lib/api";

const key = (callSid: string) => ["live-recording", callSid] as const;

/**
 * The call screen's record switch for the call on this device's own leg. Shows what Twilio reports (off,
 * recording, paused) and starts, pauses or resumes the recording of this call only.
 */
export function RecordToggle({ callSid }: { callSid: string | null }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const state = useQuery({
    enabled: Boolean(callSid),
    queryKey: key(callSid ?? ""),
    queryFn: () =>
      api<LiveRecordingState>(`/api/recordings/live?callSid=${encodeURIComponent(callSid ?? "")}`),
  });
  const change = useMutation({
    mutationFn: (action: LiveRecordingAction["action"]) =>
      api<LiveRecordingState>("/api/recordings/live", { method: "POST", json: { callSid, action } }),
    onSuccess: (s) => qc.setQueryData(key(callSid ?? ""), s),
  });
  if (!callSid) return null;

  const current = state.data?.state ?? "off";
  const action: LiveRecordingAction["action"] =
    current === "recording" ? "pause" : current === "paused" ? "resume" : "start";
  const label =
    action === "pause"
      ? t("recording.live.pause")
      : action === "resume"
        ? t("recording.live.resume")
        : t("recording.live.start");

  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        onClick={() => change.mutate(action)}
        disabled={state.isPending || change.isPending}
        aria-pressed={current === "recording"}
        className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium disabled:opacity-60 ${
          current === "recording" ? "bg-red-600 text-white hover:bg-red-700" : "bg-white/10 hover:bg-white/20"
        }`}
      >
        {current === "recording" ? (
          <Pause aria-hidden className="size-4" weight="fill" />
        ) : (
          <Record aria-hidden className="size-4" weight="fill" />
        )}
        {label}
      </button>
      <p className="min-h-5 max-w-xs text-center text-xs text-slate-300" aria-live="polite">
        {change.error instanceof ApiError && change.error.code === "recording_notice_on"
          ? t("recording.live.noticeOn")
          : change.isError || state.isError
            ? t("recording.live.failed")
            : current === "recording"
              ? t("recording.live.recording")
              : current === "paused"
                ? t("recording.live.paused")
                : ""}
      </p>
    </div>
  );
}
