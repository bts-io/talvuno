import { Backspace, Phone } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AsYouType } from "libphonenumber-js";
import { type ClipboardEvent, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { countryOf, formatPhone, toE164 } from "../../lib/phone";
import { ForegroundCallNote } from "../components/foreground-call-note";
import { usePhone } from "../components/phone-provider";
import { cleanDialInput } from "../lib/voice";
import { callerIdsQuery, lookupContactName } from "../lib/voice-api";

export const Route = createFileRoute("/_app/keypad")({
  validateSearch: z.object({ to: z.string().max(40).optional() }),
  component: KeypadPage,
});

const KEYS: [string, string][] = [
  ["1", ""],
  ["2", "ABC"],
  ["3", "DEF"],
  ["4", "GHI"],
  ["5", "JKL"],
  ["6", "MNO"],
  ["7", "PQRS"],
  ["8", "TUV"],
  ["9", "WXYZ"],
  ["*", ""],
  ["0", "+"],
  ["#", ""],
];

function KeypadPage() {
  const { t } = useTranslation();
  const { to } = Route.useSearch();
  const phone = usePhone();
  const qc = useQueryClient();
  const callerIds = useQuery(callerIdsQuery());
  const [digits, setDigits] = useState(() => cleanDialInput(to ?? ""));
  const [callerId, setCallerId] = useState<string>("");

  useEffect(() => {
    if (to) setDigits(cleanDialInput(to));
  }, [to]);

  const numbers = callerIds.data ?? [];
  const from = numbers.find((n) => n.e164 === callerId) ?? numbers[0] ?? null;
  // National numbers are read in the country of the number the call goes out from.
  const country = from ? (countryOf(from.e164) ?? undefined) : undefined;
  const formatted = useMemo(() => (digits ? new AsYouType(country).input(digits) : ""), [digits, country]);
  const e164 = toE164(digits, country);

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    setDigits(cleanDialInput(e.clipboardData.getData("text")));
  };

  const call = async () => {
    if (!e164) return;
    // The active call screen shows the contact's name when the number is in the contact book.
    const name = await qc.fetchQuery(lookupContactName(e164)).catch(() => null);
    await phone.placeCall(e164, from?.e164 ?? null, name);
  };

  const ready = phone.deviceState === "ready";
  const noNumbers = callerIds.isSuccess && numbers.length === 0;

  return (
    <div className="mx-auto flex max-w-sm flex-col gap-5 px-4 py-6">
      <h1 className="sr-only">{t("nav.keypad")}</h1>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-slate-500 dark:text-slate-400">{t("voice.callerId")}</span>
        <select
          value={from?.e164 ?? ""}
          onChange={(e) => setCallerId(e.target.value)}
          disabled={!numbers.length}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 dark:border-navy-700 dark:bg-navy-800"
        >
          {numbers.map((n) => (
            <option key={n.id} value={n.e164}>
              {n.friendlyName ? `${n.friendlyName} (${formatPhone(n.e164)})` : formatPhone(n.e164)}
              {n.isDefault ? ` ${t("voice.defaultSuffix")}` : ""}
            </option>
          ))}
        </select>
      </label>
      {noNumbers ? (
        <p className="text-sm text-amber-700 dark:text-amber-400">{t("voice.noNumbers")}</p>
      ) : null}

      <div className="flex items-center gap-2 border-b border-slate-200 pb-2 dark:border-navy-700">
        <input
          inputMode="tel"
          autoComplete="tel"
          aria-label={t("voice.numberLabel")}
          placeholder={t("voice.numberPlaceholder")}
          value={formatted}
          onChange={(e) => setDigits(cleanDialInput(e.target.value))}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter") void call();
          }}
          className="min-w-0 flex-1 bg-transparent text-center text-3xl tracking-wide outline-none"
        />
        {digits ? (
          <button
            type="button"
            onClick={() => setDigits((d) => d.slice(0, -1))}
            className="p-2 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
          >
            <Backspace aria-hidden className="size-6" />
            <span className="sr-only">{t("voice.delete")}</span>
          </button>
        ) : null}
      </div>
      {digits && !e164 ? (
        <p className="-mt-3 text-center text-sm text-slate-500 dark:text-slate-400">
          {t("voice.incomplete")}
        </p>
      ) : null}

      <div className="grid grid-cols-3 gap-3 self-center">
        {KEYS.map(([k, letters]) => (
          <button
            key={k}
            type="button"
            onClick={() => setDigits((d) => cleanDialInput(d + k))}
            onContextMenu={(e) => {
              if (k !== "0") return;
              e.preventDefault();
              setDigits((d) => cleanDialInput(`${d}+`));
            }}
            className="flex size-20 flex-col items-center justify-center rounded-full bg-slate-100 hover:bg-slate-200 dark:bg-navy-800 dark:hover:bg-navy-700"
          >
            <span className="text-3xl">{k}</span>
            <span className="h-3 text-[10px] tracking-widest text-slate-500 dark:text-slate-400">
              {letters}
            </span>
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => void call()}
        disabled={!ready || !e164 || Boolean(phone.active) || phone.placing}
        className="flex size-20 items-center justify-center self-center rounded-full bg-brand-green text-white hover:opacity-90 disabled:opacity-40"
      >
        <Phone aria-hidden className="size-9" weight="fill" />
        <span className="sr-only">{t("voice.call")}</span>
      </button>

      <div className="flex items-center justify-center gap-3 text-sm" aria-live="polite">
        <span className="text-slate-500 dark:text-slate-400">{t(`voice.device.${phone.deviceState}`)}</span>
        {phone.failed ? (
          <button
            type="button"
            onClick={phone.retry}
            className="rounded-lg border border-slate-300 px-3 py-1 font-medium hover:bg-slate-100 dark:border-navy-700 dark:hover:bg-navy-800"
          >
            {t("voice.retry")}
          </button>
        ) : null}
      </div>
      {phone.error ? (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
        >
          <span>{t(`voice.errors.${phone.error}`, { code: phone.errorCode ?? "" })}</span>
          <button type="button" onClick={phone.clearError} className="font-medium underline">
            {t("voice.dismiss")}
          </button>
        </div>
      ) : null}

      <ForegroundCallNote />
    </div>
  );
}
