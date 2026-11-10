import { Phone, PhoneDisconnect } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { formatPhone, isE164 } from "../../lib/phone";
import { usePartyLabel } from "./active-call";
import { ForegroundCallNote } from "./foreground-call-note";
import { usePhone } from "./phone-provider";

/**
 * Sheet over any screen while a call waits for an answer. The phone provider plays the ringtone while it
 * shows. Accept connects this device to the waiting caller, Decline sends the caller to voicemail.
 */
export function IncomingCallSheet() {
  const { t } = useTranslation();
  const { incoming, accept, decline, error } = usePhone();
  const label = usePartyLabel(incoming?.party ?? "", incoming?.name ?? null);
  if (!incoming) return null;

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
        <ForegroundCallNote className="mt-4" />
      </div>
    </div>
  );
}
