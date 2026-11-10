import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { preferencesQuery, savePreferences } from "../../hooks/use-settings";
import { ErrorLine, inputClass, primaryButtonClass, Section } from "./section";

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const zoneNames = (current: string) => {
  let names: string[] = [];
  try {
    names = Intl.supportedValuesOf("timeZone");
  } catch {
    names = [];
  }
  return names.includes(current) ? names : [current, ...names];
};

export function DigestSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: prefs } = useQuery(preferencesQuery());
  const [draft, setDraft] = useState<{ enabled?: boolean; time?: string; zone?: string }>({});

  const save = useMutation({
    mutationFn: savePreferences,
    onSuccess: (p) => {
      qc.setQueryData(["preferences"], p);
      setDraft({});
    },
  });

  const enabled = draft.enabled ?? prefs?.digestEnabled ?? false;
  const time = draft.time ?? prefs?.digestTime ?? "08:00";
  // Until the owner picks a zone, offer the one this browser is in.
  const zone = draft.zone ?? (prefs && prefs.timezone !== "UTC" ? prefs.timezone : browserZone());
  const valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(time) && zone.length > 0;
  const dirty = draft.enabled !== undefined || draft.time !== undefined || draft.zone !== undefined;

  return (
    <Section id="digest" title={t("settings.digest.title")} intro={t("settings.digest.intro")}>
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
        />
        {t("settings.digest.enable")}
      </label>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="digest-time" className="text-sm font-medium">
            {t("settings.digest.time")}
          </label>
          <input
            id="digest-time"
            type="time"
            value={time}
            onChange={(e) => setDraft((d) => ({ ...d, time: e.target.value }))}
            className={inputClass}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="digest-zone" className="text-sm font-medium">
            {t("settings.digest.timezone")}
          </label>
          <select
            id="digest-zone"
            value={zone}
            onChange={(e) => setDraft((d) => ({ ...d, zone: e.target.value }))}
            className={inputClass}
          >
            {zoneNames(zone).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {!valid ? (
        <p role="alert" className="text-sm text-red-600">
          {t("settings.digest.invalid")}
        </p>
      ) : null}
      <ErrorLine error={save.error} />
      <div>
        <button
          type="button"
          className={primaryButtonClass}
          disabled={!dirty || !valid || save.isPending}
          onClick={() => save.mutate({ digestEnabled: enabled, digestTime: time, timezone: zone })}
        >
          {t("settings.save")}
        </button>
      </div>
    </Section>
  );
}
