import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type NumberRecording,
  type NumberRecordingList,
  RECORDING_NOTICE_MAX,
} from "../../../contracts/recording";
import { formatPhone } from "../../../lib/phone";
import { numbersQuery } from "../../hooks/use-settings";
import { api } from "../../lib/api";
import { ErrorLine, inputClass, primaryButtonClass, Section } from "./section";

const KEY = ["recording-settings"] as const;

/** Call recording per number: record calls, play a notice, the notice text. All off by default. */
export function RecordingSection() {
  const { t } = useTranslation();
  const { data, isError } = useQuery({
    queryKey: KEY,
    queryFn: () => api<NumberRecordingList>("/api/recordings/settings"),
  });
  const { data: numbers } = useQuery(numbersQuery());
  return (
    <Section id="recording" title={t("recording.settings.title")} intro={t("recording.settings.intro")}>
      {isError ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t("recording.settings.loadFailed")}
        </p>
      ) : null}
      {data && !data.items.length ? <p className="text-sm text-slate-500">{t("routing.noNumbers")}</p> : null}
      {data?.items.map((r) => {
        const n = numbers?.find((x) => x.id === r.numberId);
        return (
          <NumberRecordingForm
            key={r.numberId}
            value={r}
            label={n?.friendlyName || formatPhone(n?.e164 ?? "")}
          />
        );
      })}
      <p className="text-sm text-slate-500 dark:text-slate-400">{t("recording.settings.consent")}</p>
    </Section>
  );
}

function NumberRecordingForm({ value, label }: { value: NumberRecording; label: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [recordCalls, setRecordCalls] = useState(value.recordCalls);
  const [playNotice, setPlayNotice] = useState(value.playNotice);
  const [notice, setNotice] = useState(value.noticeText ?? "");
  const save = useMutation({
    mutationFn: () =>
      api<NumberRecording>(`/api/recordings/settings/${value.numberId}`, {
        method: "PUT",
        json: { recordCalls, playNotice, noticeText: notice.trim() || null },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
  const id = `rec-${value.numberId}`;
  return (
    <fieldset className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3 dark:border-navy-800">
      <legend className="px-1 text-sm font-medium">{label}</legend>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={recordCalls} onChange={(e) => setRecordCalls(e.target.checked)} />
        {t("recording.settings.recordCalls")}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={playNotice} onChange={(e) => setPlayNotice(e.target.checked)} />
        {t("recording.settings.playNotice")}
      </label>
      <label htmlFor={`${id}-notice`} className="text-sm">
        {t("recording.settings.noticeText")}
      </label>
      <textarea
        id={`${id}-notice`}
        rows={2}
        maxLength={RECORDING_NOTICE_MAX}
        value={notice}
        disabled={!playNotice}
        placeholder={t("recording.defaultNotice")}
        onChange={(e) => setNotice(e.target.value)}
        className={inputClass}
      />
      <p className="text-xs text-slate-500">{t("recording.settings.noticeHint")}</p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={save.isPending}
          onClick={() => save.mutate()}
          className={primaryButtonClass}
        >
          {t("routing.save")}
        </button>
        {save.isSuccess ? <span className="text-sm text-slate-500">{t("routing.saved")}</span> : null}
      </div>
      <ErrorLine error={save.error} />
    </fieldset>
  );
}
