import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { SCHEDULE_MAX_LEAD_MS, SCHEDULE_MIN_LEAD_MS, sendAtProblem } from "../../contracts/scheduled";
import { epochToZoned, zonedToEpoch } from "../../lib/schedule-time";

/**
 * A date and time field read in the owner's time zone, with the "sends within 15 minutes" note. Reports the
 * chosen instant (epoch ms) or null when the field is empty, malformed or outside the allowed window.
 */
export function SchedulePicker({
  zone,
  initial,
  onChange,
}: {
  zone: string;
  /** Epoch ms to start from (editing); otherwise one hour ahead. */
  initial?: number;
  onChange: (sendAt: number | null) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [now] = useState(() => Date.now());
  const [value, setValue] = useState(() => epochToZoned(initial ?? now + 60 * 60 * 1000, zone));
  const sendAt = zonedToEpoch(value, zone);
  const problem = sendAt === null ? "invalid" : sendAtProblem(sendAt);
  // Tell the parent about the starting value once, so its Save button knows the field is already valid.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once on mount
  useEffect(() => onChange(sendAt !== null && !sendAtProblem(sendAt) ? sendAt : null), []);
  const min = epochToZoned(now + SCHEDULE_MIN_LEAD_MS, zone);
  const max = epochToZoned(now + SCHEDULE_MAX_LEAD_MS, zone);

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {t("scheduled.when")}
      </label>
      <input
        id={id}
        type="datetime-local"
        value={value}
        min={min}
        max={max}
        aria-invalid={problem ? true : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          const next = zonedToEpoch(e.target.value, zone);
          onChange(next !== null && !sendAtProblem(next) ? next : null);
        }}
        className="rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-navy-700 dark:bg-navy-900"
      />
      <p className="text-xs text-slate-500 dark:text-slate-400">{t("scheduled.zone", { zone })}</p>
      <p className="text-xs text-slate-500 dark:text-slate-400">{t("scheduled.within15")}</p>
      {problem && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {t(`scheduled.problem.${problem}`)}
        </p>
      )}
    </div>
  );
}
