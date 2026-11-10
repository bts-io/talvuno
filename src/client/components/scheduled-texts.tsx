import { Clock, PencilSimple, WarningCircle, X } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SMS_BODY_MAX } from "../../contracts";
import type { ScheduledMessage } from "../../contracts/scheduled";
import { formatPhone } from "../../lib/phone";
import { ApiError } from "../lib/api";
import { formatScheduled, scheduledQuery, useOwnerZone, useScheduleMutations } from "../lib/scheduled";
import { SchedulePicker } from "./schedule-picker";

/**
 * Scheduled texts: for one thread (`thread`) or all of them. Each row can be edited while it is waiting and
 * cancelled. A text that could not be sent shows its reason and can be dismissed.
 */
export function ScheduledTexts({
  thread,
  showRecipient,
}: {
  thread?: { numberId: string; to: string };
  showRecipient?: boolean;
}) {
  const { t } = useTranslation();
  const { data } = useQuery(scheduledQuery(thread));
  if (!data?.length) return null;
  return (
    <section aria-label={t("scheduled.title")} className="border-b border-slate-200 dark:border-navy-800">
      <h2 className="flex items-center gap-1.5 px-4 pt-3 text-sm font-semibold">
        <Clock aria-hidden className="size-4" />
        {t("scheduled.title")}
      </h2>
      <ul>
        {data.map((m) => (
          <ScheduledRow key={m.id} m={m} showRecipient={showRecipient} />
        ))}
      </ul>
    </section>
  );
}

function ScheduledRow({ m, showRecipient }: { m: ScheduledMessage; showRecipient?: boolean }) {
  const { t, i18n } = useTranslation();
  const zone = useOwnerZone();
  const { edit, cancel } = useScheduleMutations();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(m.body);
  const [sendAt, setSendAt] = useState<number | null>(m.sendAt);
  const [error, setError] = useState<string | null>(null);
  const failed = m.status === "failed";
  const waiting = m.status === "scheduled";
  const fail = (err: unknown) => setError(err instanceof ApiError ? err.message : t("scheduled.error"));

  return (
    <li className="flex flex-col gap-1 px-4 py-2 text-sm">
      {editing ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (sendAt === null || !body.trim()) return;
            setError(null);
            edit.mutate({ id: m.id, body, sendAt }, { onSuccess: () => setEditing(false), onError: fail });
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="sr-only">{t("scheduled.body")}</span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={SMS_BODY_MAX}
              rows={2}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-navy-700 dark:bg-navy-900"
            />
          </label>
          <SchedulePicker zone={zone} initial={m.sendAt} onChange={setSendAt} />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={sendAt === null || !body.trim() || edit.isPending}
              className="rounded-lg bg-brand-blue px-3 py-1.5 text-white disabled:opacity-40"
            >
              {t("scheduled.save")}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setBody(m.body);
              }}
              className="rounded-lg px-3 py-1.5 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-navy-800"
            >
              {t("scheduled.discard")}
            </button>
          </div>
        </form>
      ) : (
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {showRecipient ? `${formatPhone(m.to)} · ` : ""}
              {failed ? t("scheduled.failed") : formatScheduled(m.sendAt, zone, i18n.language)}
              {m.status === "sending" ? ` · ${t("scheduled.sending")}` : ""}
            </p>
            <p className="break-words whitespace-pre-wrap">{m.body}</p>
            {failed && (
              <p className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
                <WarningCircle aria-hidden className="size-4 shrink-0" />
                {t("messages.failedReason", { reason: m.error ?? t("scheduled.error") })}
              </p>
            )}
          </div>
          {waiting && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label={t("scheduled.edit")}
              title={t("scheduled.edit")}
              className="rounded-full p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-navy-800"
            >
              <PencilSimple aria-hidden className="size-4" />
            </button>
          )}
          {(waiting || failed) && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                cancel.mutate(m.id, { onError: fail });
              }}
              disabled={cancel.isPending}
              aria-label={failed ? t("scheduled.dismiss") : t("scheduled.cancel")}
              title={failed ? t("scheduled.dismiss") : t("scheduled.cancel")}
              className="rounded-full p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-navy-800"
            >
              <X aria-hidden className="size-4" />
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </li>
  );
}
