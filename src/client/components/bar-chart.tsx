import { useTranslation } from "react-i18next";

export type BarSeries = { key: string; label: string; className: string };

/**
 * A small stacked bar chart in inline SVG, one bar per day. Colours come from classes so light and dark both
 * pass contrast (a darker green on white, the brand green on navy). Identity is never colour alone: the legend
 * names each series, every bar has a hover title, and the same numbers are available as a table.
 */
export function BarChart({
  title,
  data,
  series,
  locale,
}: {
  title: string;
  data: { date: string; [k: string]: number | string }[];
  series: BarSeries[];
  locale: string;
}) {
  const { t } = useTranslation();
  const W = 600;
  const H = 120;
  const PAD_L = 28;
  const PAD_B = 4;
  const totalOf = (d: Record<string, number | string>) =>
    series.reduce((a, s) => a + Number(d[s.key] ?? 0), 0);
  const max = Math.max(0, ...data.map(totalOf));
  const top = Math.max(max, 1);
  const slot = (W - PAD_L) / Math.max(data.length, 1);
  const barW = Math.max(1, Math.min(18, slot - Math.min(2, slot * 0.25)));
  const plotH = H - PAD_B;
  const day = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString(locale, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  const peak = data.find((d) => totalOf(d) === max);
  const first = data[0]?.date as string | undefined;
  const last = data.at(-1)?.date as string | undefined;

  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold">{title}</h3>
        <ul className="flex gap-3 text-xs text-slate-600 dark:text-slate-300">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1">
              <svg width="10" height="10" aria-hidden="true">
                <rect width="10" height="10" rx="2" className={s.className} />
              </svg>
              {s.label}
            </li>
          ))}
        </ul>
      </figcaption>
      {max === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">{t("stats.chartEmpty")}</p>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${W} ${H + 16}`}
            role="img"
            aria-label={t("stats.chartLabel", {
              title,
              from: first ? day(first) : "",
              to: last ? day(last) : "",
              peak: peak ? day(peak.date) : "",
              max,
            })}
            className="w-full"
          >
            <line x1={PAD_L} x2={W} y1={plotH} y2={plotH} className="stroke-slate-300 dark:stroke-navy-700" />
            <line
              x1={PAD_L}
              x2={W}
              y1={0.5}
              y2={0.5}
              strokeDasharray="2 3"
              className="stroke-slate-200 dark:stroke-navy-800"
            />
            <text
              x={PAD_L - 4}
              y={8}
              textAnchor="end"
              className="fill-slate-500 text-[9px] dark:fill-slate-400"
            >
              {max}
            </text>
            <text
              x={PAD_L - 4}
              y={plotH}
              textAnchor="end"
              className="fill-slate-500 text-[9px] dark:fill-slate-400"
            >
              0
            </text>
            {data.map((d, i) => {
              const x = PAD_L + i * slot + (slot - barW) / 2;
              let y = plotH;
              return (
                <g key={d.date}>
                  <title>
                    {day(d.date)}: {series.map((s) => `${s.label} ${d[s.key] ?? 0}`).join(", ")}
                  </title>
                  {series.map((s) => {
                    const v = Number(d[s.key] ?? 0);
                    if (v <= 0) return null;
                    // A 1px gap in surface colour separates stacked segments.
                    const h = Math.max(1, (v / top) * (plotH - 2) - 1);
                    y -= h + 1;
                    return (
                      <rect
                        key={s.key}
                        x={x}
                        y={y + 1}
                        width={barW}
                        height={h}
                        rx={Math.min(2, barW / 2)}
                        className={s.className}
                      />
                    );
                  })}
                </g>
              );
            })}
            {first && last ? (
              <>
                <text x={PAD_L} y={H + 10} className="fill-slate-500 text-[9px] dark:fill-slate-400">
                  {day(first)}
                </text>
                <text
                  x={W}
                  y={H + 10}
                  textAnchor="end"
                  className="fill-slate-500 text-[9px] dark:fill-slate-400"
                >
                  {day(last)}
                </text>
              </>
            ) : null}
          </svg>
          <details className="text-sm">
            <summary className="cursor-pointer text-slate-600 dark:text-slate-300">
              {t("stats.table")}
            </summary>
            <div className="mt-2 max-h-64 overflow-auto">
              <table className="w-full text-start text-xs tabular-nums">
                <thead>
                  <tr className="text-slate-500 dark:text-slate-400">
                    <th scope="col" className="py-1 pe-2 text-start font-medium">
                      {t("stats.date")}
                    </th>
                    {series.map((s) => (
                      <th key={s.key} scope="col" className="py-1 pe-2 text-end font-medium">
                        {s.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.map((d) => (
                    <tr key={d.date} className="border-t border-slate-100 dark:border-navy-800">
                      <th scope="row" className="py-1 pe-2 text-start font-normal">
                        {d.date}
                      </th>
                      {series.map((s) => (
                        <td key={s.key} className="py-1 pe-2 text-end">
                          {d[s.key] ?? 0}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </figure>
  );
}
