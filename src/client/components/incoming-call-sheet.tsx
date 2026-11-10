import { Phone, PhoneDisconnect } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatPhone, isE164 } from "../../lib/phone";
import { failureText, newClientId, smsNumbersQuery, useSendMessage } from "../lib/messages";
import { declineTextNumber, declineWithText, quickRepliesQuery } from "../lib/quick-replies";
import { usePartyLabel } from "./active-call";
import { ForegroundCallNote } from "./foreground-call-note";
import { usePhone } from "./phone-provider";

/**
 * Sheet over any screen while a call rings. The ringtone is the Voice SDK's own incoming sound, which plays
 * while the call rings and stops on accept, decline or cancel.
 */
export function IncomingCallSheet() {
  const { t } = useTranslation();
  const { incoming, accept, decline, error } = usePhone();
  const label = usePartyLabel(incoming?.party ?? "", incoming?.name ?? null);
  const numbers = useQuery({ ...smsNumbersQuery(), enabled: Boolean(incoming) });
  const replies = useQuery({ ...quickRepliesQuery(), enabled: Boolean(incoming) });
  const send = useSendMessage();
  const [listOpen, setListOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);
  if (!incoming) return null;

  // Only when the caller is a full number and the number they called can send texts.
  const via = declineTextNumber(incoming, numbers.data);
  const canText = via !== null && (replies.data?.length ?? 0) > 0;

  const declineText = async (text: string) => {
    if (!via || busy) return;
    setBusy(true);
    setTextError(null);
    const result = await declineWithText(text, {
      send: (body) =>
        send.mutateAsync({
          input: { numberId: via.id, to: incoming.party, body, from: via.e164 },
          clientId: newClientId(),
        }),
      decline,
    });
    setBusy(false);
    if (!result.ok) setTextError(failureText(t, result.error));
  };

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/40 md:items-center">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="incoming-call-title"
        className="w-full max-w-md rounded-t-2xl bg-white p-6 shadow-xl md:rounded-2xl dark:bg-navy-900"
        style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
      >
        <p className="text-sm text-slate-500 dark:text-slate-400">{t("voice.incomingLabel")}</p>
        <h2 id="incoming-call-title" className="mt-1 text-2xl font-semibold break-all">
          {label}
        </h2>
        {incoming.name && isE164(incoming.party) ? (
          <p className="text-slate-500 dark:text-slate-400">{formatPhone(incoming.party)}</p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
            {t(`voice.errors.${error}`)}
          </p>
        ) : null}
        <div className="mt-6 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={decline}
            className="flex items-center justify-center gap-2 rounded-xl bg-red-600 py-3 font-medium text-white hover:bg-red-700"
          >
            <PhoneDisconnect aria-hidden className="size-5" weight="fill" />
            {t("voice.decline")}
          </button>
          <button
            type="button"
            onClick={() => void accept()}
            className="flex items-center justify-center gap-2 rounded-xl bg-brand-green py-3 font-medium text-white hover:opacity-90"
          >
            <Phone aria-hidden className="size-5" weight="fill" />
            {t("voice.accept")}
          </button>
        </div>
        {canText ? (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setListOpen((v) => !v)}
              aria-expanded={listOpen}
              className="w-full rounded-xl border border-slate-300 py-2.5 text-sm font-medium hover:bg-slate-100 dark:border-navy-700 dark:hover:bg-navy-800"
            >
              {t("voice.declineWithText")}
            </button>
            {listOpen ? (
              <ul aria-label={t("voice.declineWithText")} className="mt-2 flex flex-col gap-1.5">
                {replies.data!.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void declineText(r.text)}
                      className="w-full rounded-lg bg-slate-100 px-3 py-2 text-start text-sm hover:bg-slate-200 disabled:opacity-50 dark:bg-navy-800 dark:hover:bg-navy-700"
                    >
                      {r.text}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {textError ? (
              <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
                {textError}
              </p>
            ) : null}
          </div>
        ) : null}
        <ForegroundCallNote className="mt-4" />
      </div>
    </div>
  );
}
