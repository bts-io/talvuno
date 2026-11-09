import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type CountryCode, getCountries } from "libphonenumber-js";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { preferencesQuery, savePreferences } from "../../hooks/use-settings";
import { buttonClass, ErrorLine, inputClass, primaryButtonClass, Section } from "./section";

/** Country names in the reader's language; the code stands in where the browser has no name for it. */
function useCountries(locale: string) {
  return useMemo(() => {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([locale], { type: "region" });
    } catch {
      names = null;
    }
    return getCountries()
      .map((code) => ({ code, name: names?.of(code) ?? code }))
      .sort((a, b) => a.name.localeCompare(b.name, locale));
  }, [locale]);
}

export function SafetySection() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { data: prefs } = useQuery(preferencesQuery());
  const countries = useCountries(i18n.language);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<{
    allow?: CountryCode[];
    sms?: string;
    calls?: string;
  }>({});

  const save = useMutation({
    mutationFn: savePreferences,
    onSuccess: (p) => {
      qc.setQueryData(["preferences"], p);
      setDraft({});
    },
  });

  const allow = draft.allow ?? prefs?.countryAllowlist ?? [];
  const sms = draft.sms ?? String(prefs?.smsPerHour ?? "");
  const calls = draft.calls ?? String(prefs?.callsPerHour ?? "");
  const nameOf = (code: CountryCode) => countries.find((c) => c.code === code)?.name ?? code;

  const q = search.trim().toLowerCase();
  const matches = q
    ? countries.filter((c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q).slice(0, 8)
    : [];

  const smsN = Number(sms);
  const callsN = Number(calls);
  const limitsOk =
    Number.isInteger(smsN) &&
    smsN >= 0 &&
    smsN <= 10_000 &&
    Number.isInteger(callsN) &&
    callsN >= 0 &&
    callsN <= 1_000;
  const dirty = draft.allow !== undefined || draft.sms !== undefined || draft.calls !== undefined;

  const toggle = (code: CountryCode) =>
    setDraft((d) => {
      const cur = d.allow ?? prefs?.countryAllowlist ?? [];
      return { ...d, allow: cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code].sort() };
    });

  return (
    <Section id="safety" title={t("settings.safety.title")} intro={t("settings.safety.intro")}>
      <div className="flex flex-col gap-2">
        <label htmlFor="country-search" className="text-sm font-medium">
          {t("settings.safety.countries")}
        </label>
        <input
          id="country-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("settings.safety.search")}
          className={inputClass}
          autoComplete="off"
        />
        {matches.length ? (
          <ul aria-label={t("settings.safety.results")} className="flex flex-wrap gap-2">
            {matches.map((c) => {
              const on = allow.includes(c.code);
              return (
                <li key={c.code}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(c.code)}
                    className={buttonClass}
                  >
                    {on ? "✓ " : "+ "}
                    {c.name}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : q ? (
          <p className="text-sm text-slate-500">{t("settings.safety.noMatch")}</p>
        ) : null}
        {allow.length === 0 ? (
          <p className="text-sm text-amber-700 dark:text-amber-300">{t("settings.safety.noneAllowed")}</p>
        ) : (
          <ul aria-label={t("settings.safety.allowed")} className="flex flex-wrap gap-2">
            {allow.map((code) => (
              <li key={code}>
                <button
                  type="button"
                  onClick={() => toggle(code)}
                  aria-label={t("settings.safety.removeCountry", { name: nameOf(code) })}
                  className="rounded-full bg-brand-blue/15 px-3 py-1 text-sm hover:bg-brand-blue/25"
                >
                  {nameOf(code)} ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="sms-per-hour" className="text-sm font-medium">
            {t("settings.safety.smsPerHour")}
          </label>
          <input
            id="sms-per-hour"
            type="number"
            inputMode="numeric"
            min={0}
            max={10000}
            value={sms}
            onChange={(e) => setDraft((d) => ({ ...d, sms: e.target.value }))}
            className={inputClass}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="calls-per-hour" className="text-sm font-medium">
            {t("settings.safety.callsPerHour")}
          </label>
          <input
            id="calls-per-hour"
            type="number"
            inputMode="numeric"
            min={0}
            max={1000}
            value={calls}
            onChange={(e) => setDraft((d) => ({ ...d, calls: e.target.value }))}
            className={inputClass}
          />
        </div>
      </div>
      {!limitsOk ? (
        <p role="alert" className="text-sm text-red-600">
          {t("settings.safety.limitsInvalid")}
        </p>
      ) : null}
      <ErrorLine error={save.error} />
      <div>
        <button
          type="button"
          className={primaryButtonClass}
          disabled={!dirty || !limitsOk || save.isPending}
          onClick={() => save.mutate({ countryAllowlist: allow, smsPerHour: smsN, callsPerHour: callsN })}
        >
          {t("settings.save")}
        </button>
      </div>
    </Section>
  );
}
