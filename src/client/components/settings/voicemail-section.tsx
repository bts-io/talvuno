import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  GREETING_MAX,
  type NumberRouting,
  RING_SECONDS_MAX,
  RING_SECONDS_MIN,
} from "../../../contracts/routing";
import { formatPhone } from "../../../lib/phone";
import { routingQuery, saveNumberRouting } from "../../hooks/use-routing";
import { numbersQuery } from "../../hooks/use-settings";
import { ErrorLine, inputClass, primaryButtonClass, Section } from "./section";

/** Per number: how long a call rings before voicemail, and the greeting the caller hears first. */
export function VoicemailSection() {
  const { t } = useTranslation();
  const { data: routing } = useQuery(routingQuery());
  const { data: numbers } = useQuery(numbersQuery());
  return (
    <Section id="voicemail" title={t("routing.voicemail.title")} intro={t("routing.voicemail.intro")}>
      {routing && !routing.numbers.length ? (
        <p className="text-sm text-slate-500">{t("routing.noNumbers")}</p>
      ) : null}
      {routing?.numbers.map((r) => {
        const n = numbers?.find((x) => x.id === r.numberId);
        return (
          <NumberVoicemail
            key={r.numberId}
            routing={r}
            label={n?.friendlyName || formatPhone(n?.e164 ?? "")}
          />
        );
      })}
    </Section>
  );
}

function NumberVoicemail({ routing, label }: { routing: NumberRouting; label: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [greeting, setGreeting] = useState(routing.voicemailGreeting ?? "");
  const [ring, setRing] = useState(String(routing.ringSeconds));
  const ringN = Number(ring);
  const valid = Number.isInteger(ringN) && ringN >= RING_SECONDS_MIN && ringN <= RING_SECONDS_MAX;
  const save = useMutation({
    mutationFn: () =>
      saveNumberRouting(routing.numberId, { ringSeconds: ringN, voicemailGreeting: greeting }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["routing"] }),
  });
  const id = `vm-${routing.numberId}`;
  return (
    <fieldset className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3 dark:border-navy-800">
      <legend className="px-1 text-sm font-medium">{label}</legend>
      <label htmlFor={`${id}-ring`} className="text-sm">
        {t("routing.voicemail.ringTime")}
      </label>
      <input
        id={`${id}-ring`}
        type="number"
        min={RING_SECONDS_MIN}
        max={RING_SECONDS_MAX}
        value={ring}
        onChange={(e) => setRing(e.target.value)}
        className={`${inputClass} max-w-32`}
      />
      <label htmlFor={`${id}-greeting`} className="text-sm">
        {t("routing.voicemail.greeting")}
      </label>
      <textarea
        id={`${id}-greeting`}
        rows={3}
        maxLength={GREETING_MAX}
        value={greeting}
        placeholder={t("routing.defaultGreeting")}
        onChange={(e) => setGreeting(e.target.value)}
        className={inputClass}
      />
      <p className="text-xs text-slate-500">{t("routing.voicemail.greetingHint")}</p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={!valid || save.isPending}
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
