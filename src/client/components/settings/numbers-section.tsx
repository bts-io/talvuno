import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NumberRouting, PhoneNumberRow } from "../../../contracts/numbers";
import { formatPhone } from "../../../lib/phone";
import {
  addBackNumber,
  connectNumber,
  numbersQuery,
  patchNumber,
  removeNumber,
  restoreNumber,
  syncNumbers,
} from "../../hooks/use-settings";
import { buttonClass, Confirm, ErrorLine, inputClass, primaryButtonClass, Section } from "./section";

type Pending = { id: string; kind: "connect" | "restore" | "remove" };

const describe = (r: NumberRouting, none: string) => ({
  voice: r.voiceApplicationSid ? `TwiML App ${r.voiceApplicationSid}` : (r.voiceUrl ?? none),
  sms: r.smsUrl ?? none,
});

export function NumbersSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: numbers, error: loadError } = useQuery(numbersQuery());
  const [pending, setPending] = useState<Pending | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["numbers"] });
  const afterList = (list: PhoneNumberRow[]) => {
    qc.setQueryData(["numbers"], list);
    qc.invalidateQueries({ queryKey: ["preferences"] });
  };

  const sync = useMutation({
    mutationFn: syncNumbers,
    onSuccess: (r) => {
      afterList(r.numbers);
      setNote(t("settings.numbers.synced", { added: r.added, updated: r.updated, released: r.released }));
    },
  });
  const patch = useMutation({
    mutationFn: (v: { id: string; json: { friendlyName?: string; isDefault?: true } }) =>
      patchNumber(v.id, v.json),
    onSuccess: (list) => {
      afterList(list);
      setEditing(null);
    },
  });
  const remove = useMutation({
    mutationFn: removeNumber,
    onSuccess: (list) => {
      afterList(list);
      setPending(null);
    },
  });
  const connect = useMutation({
    mutationFn: connectNumber,
    onSuccess: (r) => {
      refresh();
      setPending(null);
      const after = describe(r.after, t("settings.numbers.none"));
      setNote(
        r.changed
          ? t("settings.numbers.connected", { voice: after.voice, sms: after.sms })
          : t("settings.numbers.alreadyConnected"),
      );
    },
  });
  const restore = useMutation({
    mutationFn: restoreNumber,
    onSuccess: () => {
      refresh();
      setPending(null);
      setNote(t("settings.numbers.restored"));
    },
  });

  const addBack = useMutation({
    mutationFn: addBackNumber,
    onSuccess: (list) => {
      afterList(list);
      setNote(t("settings.numbers.addedBack"));
    },
  });

  const rename = (e: FormEvent<HTMLFormElement>, id: string) => {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("name") ?? "");
    patch.mutate({ id, json: { friendlyName: name } });
  };

  const active = (numbers ?? []).filter((n) => !n.releasedAt);
  const released = (numbers ?? []).filter((n) => n.releasedAt);
  const error =
    loadError ?? sync.error ?? patch.error ?? remove.error ?? connect.error ?? restore.error ?? addBack.error;

  return (
    <Section id="numbers" title={t("settings.numbers.title")} intro={t("settings.numbers.intro")}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={primaryButtonClass}
          disabled={sync.isPending}
          onClick={() => sync.mutate()}
        >
          {sync.isPending ? t("settings.numbers.syncing") : t("settings.numbers.sync")}
        </button>
      </div>
      {note ? (
        <p role="status" className="text-sm text-slate-600 dark:text-slate-300">
          {note}
        </p>
      ) : null}
      <ErrorLine error={error} />
      {numbers && active.length === 0 ? (
        <p className="text-sm text-slate-600 dark:text-slate-300">{t("settings.numbers.empty")}</p>
      ) : null}
      <ul className="flex flex-col gap-3">
        {active.map((n) => (
          <li
            key={n.id}
            className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3 dark:border-navy-800"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <p className="font-medium">{formatPhone(n.e164)}</p>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  {n.friendlyName || t("settings.numbers.unnamed")}
                  {" · "}
                  {[
                    n.capabilities.voice && t("settings.numbers.voice"),
                    n.capabilities.sms && t("settings.numbers.sms"),
                  ]
                    .filter(Boolean)
                    .join(", ")}
                </p>
              </div>
              {n.isDefault ? (
                <span className="rounded-full bg-brand-green/20 px-2 py-0.5 text-xs font-medium">
                  {t("settings.numbers.default")}
                </span>
              ) : null}
            </div>

            {editing === n.id ? (
              <form onSubmit={(e) => rename(e, n.id)} className="flex gap-2">
                <input
                  name="name"
                  defaultValue={n.friendlyName}
                  maxLength={64}
                  aria-label={t("settings.numbers.name")}
                  className={inputClass}
                />
                <button type="submit" className={primaryButtonClass} disabled={patch.isPending}>
                  {t("settings.save")}
                </button>
                <button type="button" className={buttonClass} onClick={() => setEditing(null)}>
                  {t("settings.cancel")}
                </button>
              </form>
            ) : (
              <div className="flex flex-wrap gap-2">
                <button type="button" className={buttonClass} onClick={() => setEditing(n.id)}>
                  {t("settings.numbers.rename")}
                </button>
                {!n.isDefault ? (
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={patch.isPending}
                    onClick={() => patch.mutate({ id: n.id, json: { isDefault: true } })}
                  >
                    {t("settings.numbers.makeDefault")}
                  </button>
                ) : null}
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() => setPending({ id: n.id, kind: "connect" })}
                >
                  {t("settings.numbers.connect")}
                </button>
                {n.restorable ? (
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() => setPending({ id: n.id, kind: "restore" })}
                  >
                    {t("settings.numbers.restore")}
                  </button>
                ) : null}
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() => setPending({ id: n.id, kind: "remove" })}
                >
                  {t("settings.numbers.remove")}
                </button>
              </div>
            )}

            {pending?.id === n.id && pending.kind === "connect" ? (
              <Confirm
                message={t("settings.numbers.connectWarning", { number: formatPhone(n.e164) })}
                confirmLabel={t("settings.numbers.connectConfirm")}
                cancelLabel={t("settings.cancel")}
                busy={connect.isPending}
                onConfirm={() => connect.mutate(n.id)}
                onCancel={() => setPending(null)}
              />
            ) : null}
            {pending?.id === n.id && pending.kind === "restore" && n.restorable ? (
              <Confirm
                message={t("settings.numbers.restoreWarning", {
                  ...describe(n.restorable, t("settings.numbers.none")),
                })}
                confirmLabel={t("settings.numbers.restoreConfirm")}
                cancelLabel={t("settings.cancel")}
                busy={restore.isPending}
                onConfirm={() => restore.mutate(n.id)}
                onCancel={() => setPending(null)}
              />
            ) : null}
            {pending?.id === n.id && pending.kind === "remove" ? (
              <Confirm
                danger
                message={t("settings.numbers.removeWarning")}
                confirmLabel={t("settings.numbers.removeConfirm")}
                cancelLabel={t("settings.cancel")}
                busy={remove.isPending}
                onConfirm={() => remove.mutate(n.id)}
                onCancel={() => setPending(null)}
              />
            ) : null}
          </li>
        ))}
      </ul>
      {released.length ? (
        <details className="text-sm text-slate-500 dark:text-slate-400">
          <summary className="cursor-pointer">
            {t("settings.numbers.removed", { count: released.length })}
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {released.map((n) => (
              <li key={n.id} className="flex flex-wrap items-center gap-2">
                <span>{formatPhone(n.e164)}</span>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={addBack.isPending}
                  onClick={() => addBack.mutate(n.id)}
                >
                  {t("settings.numbers.addBack")}
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Section>
  );
}
