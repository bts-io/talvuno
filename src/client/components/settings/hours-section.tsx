import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NumberRouting } from "../../../contracts/routing";
import { type DayDraft, fromDays, isOpenAt, toDays, validDays } from "../../../lib/business-hours";
import { formatPhone } from "../../../lib/phone";
import { routingQuery, saveDnd, saveNumberRouting } from "../../hooks/use-routing";
import { numbersQuery } from "../../hooks/use-settings";
import { ErrorLine, inputClass, primaryButtonClass, Section } from "./section";

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function zones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  try {
    return intl.supportedValuesOf?.("timeZone") ?? [browserZone()];
  } catch {
    return [browserZone()];
  }
}

function weekdayName(day: number, locale: string) {
  // 2026-11-08 is a Sunday.
  return new Date(Date.UTC(2026, 10, 8 + day)).toLocaleDateString(locale, {
    weekday: "long",
    timeZone: "UTC",
  });
}

/** Do not disturb and per-number opening hours. Outside hours or with DND on, calls go to voicemail. */
export function HoursSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: routing } = useQuery(routingQuery());
  const { data: numbers } = useQuery(numbersQuery());
  const dnd = useMutation({
    mutationFn: saveDnd,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["routing"] }),
  });

  return (
    <Section id="hours" title={t("routing.hours.title")} intro={t("routing.hours.intro")}>
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={routing?.dnd ?? false}
          disabled={!routing || dnd.isPending}
          onChange={(e) => dnd.mutate(e.target.checked)}
        />
        {t("routing.hours.dnd")}
      </label>
      {routing?.dnd ? (
        <p role="status" className="text-sm text-amber-700 dark:text-amber-300">
          {t("routing.hours.dndOn")}
        </p>
      ) : null}
      <ErrorLine error={dnd.error} />
      {routing && !routing.numbers.length ? (
        <p className="text-sm text-slate-500">{t("routing.noNumbers")}</p>
      ) : null}
      {routing?.numbers.map((r) => {
        const n = numbers?.find((x) => x.id === r.numberId);
        return (
          <NumberHours key={r.numberId} routing={r} label={n?.friendlyName || formatPhone(n?.e164 ?? "")} />
        );
      })}
    </Section>
  );
}

function NumberHours({ routing, label }: { routing: NumberRouting; label: string }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const allZones = useMemo(zones, []);
  const [limited, setLimited] = useState(Boolean(routing.hours));
  const [timeZone, setTimeZone] = useState(routing.hours?.timeZone ?? browserZone());
  const [days, setDays] = useState(() => toDays(routing.hours));
  const save = useMutation({
    mutationFn: () =>
      saveNumberRouting(routing.numberId, { hours: limited ? fromDays(timeZone, days) : null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["routing"] }),
  });
  const valid = validDays(days);
  const open = isOpenAt(routing.hours, new Date());
  const order = [1, 2, 3, 4, 5, 6, 0];

  return (
    <fieldset className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3 dark:border-navy-800">
      <legend className="px-1 text-sm font-medium">
        {label}{" "}
        <span className="font-normal text-slate-500">
          {open ? t("routing.hours.openNow") : t("routing.hours.closedNow")}
        </span>
      </legend>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={limited} onChange={(e) => setLimited(e.target.checked)} />
        {t("routing.hours.useHours")}
      </label>
      {!limited ? <p className="text-sm text-slate-500">{t("routing.hours.alwaysOpen")}</p> : null}
      {limited ? (
        <>
          <label className="flex flex-col gap-1 text-sm">
            {t("routing.hours.timeZone")}
            <select value={timeZone} onChange={(e) => setTimeZone(e.target.value)} className={inputClass}>
              {(allZones.includes(timeZone) ? allZones : [timeZone, ...allZones]).map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </label>
          <ul className="flex flex-col gap-1">
            {order.map((d) => {
              const day = days[d]!;
              const set = (p: Partial<DayDraft>) => setDays((all) => ({ ...all, [d]: { ...all[d]!, ...p } }));
              const name = weekdayName(d, i18n.language);
              return (
                <li key={d} className="flex flex-wrap items-center gap-2 text-sm">
                  <label className="flex w-36 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={day.open}
                      onChange={(e) => set({ open: e.target.checked })}
                    />
                    {name}
                  </label>
                  {day.open ? (
                    <>
                      <input
                        type="time"
                        aria-label={`${name} ${t("routing.hours.opens")}`}
                        value={day.from}
                        onChange={(e) => set({ from: e.target.value })}
                        className="rounded border border-slate-300 px-2 py-1 dark:border-navy-700 dark:bg-navy-950"
                      />
                      <input
                        type="time"
                        aria-label={`${name} ${t("routing.hours.closes")}`}
                        value={day.to}
                        onChange={(e) => set({ to: e.target.value })}
                        className="rounded border border-slate-300 px-2 py-1 dark:border-navy-700 dark:bg-navy-950"
                      />
                    </>
                  ) : (
                    <span className="text-slate-500">{t("routing.hours.closed")}</span>
                  )}
                </li>
              );
            })}
          </ul>
          {!valid ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {t("routing.hours.invalid")}
            </p>
          ) : null}
        </>
      ) : null}
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
