import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { VOICEMAIL_RETENTION_MAX_DAYS, type VoicemailSettings } from "../../../contracts/voicemail";
import { api } from "../../lib/api";
import { ErrorLine, inputClass, primaryButtonClass, Section } from "./section";

const KEY = ["voicemail-settings"] as const;

/** How long voicemail is kept. 0 keeps it forever. */
export function VoicemailSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: KEY,
    queryFn: () => api<VoicemailSettings>("/api/voicemails/settings"),
  });
  const [draft, setDraft] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (retentionDays: number) =>
      api<VoicemailSettings>("/api/voicemails/settings", { method: "PUT", json: { retentionDays } }),
    onSuccess: (s) => {
      qc.setQueryData(KEY, s);
      setDraft(null);
    },
  });

  const value = draft ?? (data ? String(data.retentionDays) : "");
  const n = Number(value);
  const valid = value !== "" && Number.isInteger(n) && n >= 0 && n <= VOICEMAIL_RETENTION_MAX_DAYS;

  return (
    <Section id="voicemail" title={t("settings.voicemail.title")} intro={t("settings.voicemail.intro")}>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate(n);
        }}
      >
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("settings.voicemail.retention")}
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={VOICEMAIL_RETENTION_MAX_DAYS}
            value={value}
            onChange={(e) => setDraft(e.target.value)}
            className={`${inputClass} w-32`}
          />
        </label>
        <button
          type="submit"
          disabled={!valid || draft === null || save.isPending}
          className={primaryButtonClass}
        >
          {t("settings.save")}
        </button>
      </form>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        {valid && n === 0
          ? t("settings.voicemail.forever")
          : t("settings.voicemail.hint", { max: VOICEMAIL_RETENTION_MAX_DAYS })}
      </p>
      <ErrorLine error={save.error} />
    </Section>
  );
}
