import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { STATS_MAX_DAYS, type Stats } from "../../contracts/stats";
import { formatPhone, isE164 } from "../../lib/phone";
import { BarChart } from "../components/bar-chart";
import { buttonClass, ErrorLine, inputClass, primaryButtonClass } from "../components/settings/section";
import { numbersQuery, preferencesQuery } from "../hooks/use-settings";
import { api } from "../lib/api";
import { formatPercent, formatSeconds, shiftDate, spanDays, todayIn } from "../lib/stats";

export const Route = createFileRoute("/_app/stats")({ component: StatsPage });

const PRESETS = [7, 30, 90] as const;
type Range =
  | { kind: "preset"; days: (typeof PRESETS)[number] }
  | { kind: "custom"; from: string; to: string };

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-navy-800 dark:bg-navy-900">
      <dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
      {detail ? <dd className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">{detail}</dd> : null}
    </div>
  );
}

function StatsPage() {
  const { t, i18n } = useTranslation();
  const { data: prefs } = useQuery(preferencesQuery());
  const { data: numbers } = useQuery(numbersQuery());
  const zone = prefs?.timezone ?? "UTC";
  const [range, setRange] = useState<Range>({ kind: "preset", days: 30 });
  const [draft, setDraft] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [numberId, setNumberId] = useState("");

  const today = todayIn(zone);
  const { from, to } =
    range.kind === "preset" ? { from: shiftDate(today, -(range.days - 1)), to: today } : range;
  const valid = spanDays(from, to) >= 1 && spanDays(from, to) <= STATS_MAX_DAYS;
  const customValid =
    !!draft.from &&
    !!draft.to &&
    spanDays(draft.from, draft.to) >= 1 &&
    spanDays(draft.from, draft.to) <= STATS_MAX_DAYS;

  const qs = new URLSearchParams({ from, to });
  if (numberId) qs.set("numberId", numberId);
  const query = useQuery({
    enabled: !!prefs && valid,
    queryKey: ["stats", from, to, numberId, zone],
    queryFn: () => api<Stats>(`/api/stats?${qs}`),
  });
  const s = query.data;
  const lng = i18n.language;
  const num = (n: number) => n.toLocaleString(lng);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 md:p-8">
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t("stats.title")}</h1>
        <Link to="/settings" className="text-sm text-brand-blue-strong hover:underline dark:text-brand-blue">
          {t("stats.back")}
        </Link>
      </div>

      <div className="flex flex-col gap-3">
        <fieldset
          aria-label={t("stats.range")}
          className="m-0 grid min-w-0 grid-cols-4 gap-1 rounded-xl border-0 bg-slate-200/70 p-1 dark:bg-navy-800"
        >
          {PRESETS.map((d) => {
            const on = range.kind === "preset" && range.days === d;
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                onClick={() => setRange({ kind: "preset", days: d })}
                className={`rounded-lg px-2 py-1.5 text-sm font-medium ${on ? "bg-white shadow-sm dark:bg-navy-950" : "text-slate-600 dark:text-slate-300"}`}
              >
                {t(`stats.last${d}`)}
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={range.kind === "custom"}
            onClick={() => {
              setDraft({ from, to });
              setRange({ kind: "custom", from, to });
            }}
            className={`rounded-lg px-2 py-1.5 text-sm font-medium ${range.kind === "custom" ? "bg-white shadow-sm dark:bg-navy-950" : "text-slate-600 dark:text-slate-300"}`}
          >
            {t("stats.custom")}
          </button>
        </fieldset>

        {range.kind === "custom" ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (customValid) setRange({ kind: "custom", ...draft });
            }}
          >
            <label className="flex flex-col gap-1 text-sm">
              {t("stats.from")}
              <input
                type="date"
                className={inputClass}
                value={draft.from}
                max={draft.to || today}
                onChange={(e) => setDraft({ ...draft, from: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("stats.to")}
              <input
                type="date"
                className={inputClass}
                value={draft.to}
                min={draft.from}
                max={today}
                onChange={(e) => setDraft({ ...draft, to: e.target.value })}
              />
            </label>
            <button type="submit" disabled={!customValid} className={primaryButtonClass}>
              {t("stats.apply")}
            </button>
          </form>
        ) : null}
        {!valid ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {t("stats.rangeError")}
          </p>
        ) : null}

        {numbers && numbers.length > 1 ? (
          <label className="flex flex-col gap-1 text-sm">
            {t("stats.number")}
            <select className={inputClass} value={numberId} onChange={(e) => setNumberId(e.target.value)}>
              <option value="">{t("stats.allNumbers")}</option>
              {numbers.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.friendlyName ? `${n.friendlyName} ${formatPhone(n.e164)}` : formatPhone(n.e164)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {query.isError ? (
        <>
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {t("stats.loadFailed")}
          </p>
          <ErrorLine error={query.error} />
        </>
      ) : !s ? (
        <p className="text-slate-500">{t("stats.loading")}</p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3">
            <Tile
              label={t("stats.tiles.calls")}
              value={s.totals.calls > 0 ? num(s.totals.calls) : t("stats.noCalls")}
              detail={
                s.totals.calls > 0
                  ? t("stats.callsDetail", {
                      inbound: num(s.totals.callsInbound),
                      outbound: num(s.totals.callsOutbound),
                    })
                  : undefined
              }
            />
            <Tile
              label={t("stats.tiles.missedRate")}
              value={s.totals.missedRate === null ? t("stats.noCalls") : formatPercent(s.totals.missedRate)}
              detail={
                s.totals.missedRate === null
                  ? undefined
                  : t("stats.missedDetail", {
                      missed: num(s.totals.missed),
                      inbound: num(s.totals.callsInboundRated),
                    })
              }
            />
            <Tile
              label={t("stats.tiles.avgLength")}
              value={
                s.totals.avgAnsweredSeconds === null
                  ? t("stats.noAnswered")
                  : formatSeconds(s.totals.avgAnsweredSeconds)
              }
              detail={
                s.totals.avgAnsweredSeconds === null
                  ? undefined
                  : t("stats.avgDetail", { count: s.totals.answered })
              }
            />
            <Tile
              label={t("stats.tiles.texts")}
              value={
                s.totals.textsSent + s.totals.textsReceived > 0
                  ? num(s.totals.textsSent + s.totals.textsReceived)
                  : t("stats.noTexts")
              }
              detail={
                s.totals.textsSent + s.totals.textsReceived > 0
                  ? t("stats.textsDetail", {
                      sent: num(s.totals.textsSent),
                      received: num(s.totals.textsReceived),
                    })
                  : undefined
              }
            />
          </dl>
          <p className="text-sm text-slate-500 dark:text-slate-400">{t("stats.missedHelp")}</p>

          <section className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-navy-800 dark:bg-navy-900">
            <BarChart
              title={t("stats.callsChart")}
              locale={lng}
              data={s.days}
              series={[
                {
                  key: "callsInbound",
                  label: t("stats.inbound"),
                  className: "fill-brand-blue-strong dark:fill-brand-blue",
                },
                {
                  key: "callsOutbound",
                  label: t("stats.outbound"),
                  className: "fill-emerald-600 dark:fill-brand-green",
                },
              ]}
            />
            <BarChart
              title={t("stats.textsChart")}
              locale={lng}
              data={s.days}
              series={[
                {
                  key: "textsReceived",
                  label: t("stats.received"),
                  className: "fill-brand-blue-strong dark:fill-brand-blue",
                },
                {
                  key: "textsSent",
                  label: t("stats.sent"),
                  className: "fill-emerald-600 dark:fill-brand-green",
                },
              ]}
            />
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {t("stats.voicemailsLine", { count: s.totals.voicemails })}
            </p>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-navy-800 dark:bg-navy-900">
            <h2 className="text-lg font-semibold">{t("stats.top")}</h2>
            {s.topContacts.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{t("stats.topNone")}</p>
            ) : (
              <ol className="mt-2 flex flex-col divide-y divide-slate-100 dark:divide-navy-800">
                {s.topContacts.map((c) => (
                  <li key={c.party} className="flex flex-col py-2">
                    <span className="font-medium">
                      {c.name ?? (isE164(c.party) ? formatPhone(c.party) : c.party)}
                    </span>
                    <span className="text-xs text-slate-600 dark:text-slate-300">
                      {[
                        t("stats.topCalls", { count: c.calls }),
                        t("stats.topTexts", { count: c.texts }),
                        t("stats.topVoicemails", { count: c.voicemails }),
                      ].join(", ")}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-4 dark:border-navy-800 dark:bg-navy-900">
            <h2 className="text-lg font-semibold">{t("stats.export")}</h2>
            <div className="flex flex-wrap gap-2">
              <a className={buttonClass} href={`/api/export/calls.csv?${qs}`} download>
                {t("stats.exportCalls")}
              </a>
              <a className={buttonClass} href={`/api/export/messages.csv?${qs}`} download>
                {t("stats.exportTexts")}
              </a>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t("stats.exportNote", { zone })}</p>
          </section>
        </>
      )}
    </div>
  );
}
