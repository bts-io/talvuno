import {
  ArrowBendUpRight,
  DotsNine,
  Microphone,
  MicrophoneSlash,
  Pause,
  PhoneDisconnect,
  Play,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatPhone, isE164, toE164 } from "../../lib/phone";
import { callControlErrorKey } from "../lib/call-control";
import { formatCallTime } from "../lib/voice";
import { usePhone } from "./phone-provider";
import { RecordToggle } from "./record-toggle";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"] as const;

/** What to call a party on screen: the contact name, else the formatted number, else "Withheld number". */
export function usePartyLabel(party: string, name: string | null) {
  const { t } = useTranslation();
  if (name) return name;
  return isE164(party) ? formatPhone(party) : t("voice.withheld");
}

/** Full-screen call in progress: who, timer, record, mute, keypad for tones, hold, transfer, hang up. */
export function ActiveCallScreen() {
  const { t } = useTranslation();
  const { active, hangUp, toggleMute, sendDigits, controlCall } = usePhone();
  const [busy, setBusy] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [showTransfer, setShowTransfer] = useState(false);
  const [target, setTarget] = useState("");
  const [confirmTo, setConfirmTo] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [showKeys, setShowKeys] = useState(false);
  const [tones, setTones] = useState("");
  const label = usePartyLabel(active?.party ?? "", active?.name ?? null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!active) return null;
  const status = active.held
    ? t("voice.control.onHold")
    : active.state === "open" && active.answeredAt
      ? formatCallTime((now - active.answeredAt) / 1000)
      : t(`voice.state.${active.state}`);
  const connected = active.state === "open" && Boolean(active.answeredAt);

  const run = async (action: "hold" | "resume" | "transfer", to?: string) => {
    setBusy(true);
    setControlError(null);
    try {
      await controlCall(action, to);
      if (action === "transfer") setConfirmTo(null);
    } catch (err) {
      setControlError(t(`voice.control.errors.${callControlErrorKey(err)}`));
    } finally {
      setBusy(false);
    }
  };

  const askTransfer = () => {
    const e164 = toE164(target.trim());
    if (!e164) {
      setControlError(t("voice.control.errors.invalidNumber"));
      return;
    }
    setControlError(null);
    setConfirmTo(e164);
  };

  const press = (key: string) => {
    sendDigits(key);
    setTones((d) => (d + key).slice(-20));
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("voice.activeCall")}
      className="fixed inset-0 z-40 flex flex-col items-center justify-between bg-navy-900 px-6 py-10 text-white"
      style={{ paddingBottom: "max(2.5rem, env(safe-area-inset-bottom))" }}
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <p className="text-sm text-slate-300">
          {active.direction === "inbound" ? t("voice.incomingLabel") : t("voice.outgoingLabel")}
        </p>
        <h2 className="text-3xl font-semibold break-all">{label}</h2>
        {active.name && isE164(active.party) ? (
          <p className="text-slate-300">{formatPhone(active.party)}</p>
        ) : null}
        <p className="mt-2 font-mono text-lg tabular-nums" aria-live="polite">
          {status}
        </p>
      </div>

      {showTransfer ? (
        <div className="flex w-full max-w-xs flex-col gap-3">
          {confirmTo ? (
            <>
              <p className="text-center">{t("voice.control.confirm", { number: formatPhone(confirmTo) })}</p>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setConfirmTo(null)}
                  disabled={busy}
                  className="flex-1 rounded-full bg-white/10 px-4 py-2 hover:bg-white/20 disabled:opacity-50"
                >
                  {t("voice.control.cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => run("transfer", confirmTo)}
                  disabled={busy}
                  className="flex-1 rounded-full bg-white px-4 py-2 font-medium text-navy-900 disabled:opacity-50"
                >
                  {busy ? t("voice.control.transferring") : t("voice.control.transferNow")}
                </button>
              </div>
            </>
          ) : (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                askTransfer();
              }}
            >
              <label htmlFor="transfer-to" className="text-sm text-slate-300">
                {t("voice.control.transferTo")}
              </label>
              <input
                id="transfer-to"
                type="tel"
                inputMode="tel"
                autoComplete="off"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder={t("voice.control.transferPlaceholder")}
                className="rounded-lg bg-white/10 px-3 py-2 text-lg text-white placeholder:text-slate-400"
              />
              <button
                type="submit"
                disabled={!target.trim()}
                className="rounded-full bg-white px-4 py-2 font-medium text-navy-900 disabled:opacity-50"
              >
                {t("voice.control.next")}
              </button>
            </form>
          )}
        </div>
      ) : showKeys ? (
        <div className="flex flex-col items-center gap-3">
          <p className="h-7 font-mono text-xl tracking-widest" aria-live="polite">
            {tones}
          </p>
          <div className="grid grid-cols-3 gap-3">
            {KEYS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => press(k)}
                className="size-16 rounded-full bg-white/10 text-2xl hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-white"
              >
                {k}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div />
      )}

      {active.state === "open" ? <RecordToggle callSid={active.callSid} /> : null}

      <div className="flex flex-col items-center gap-6">
        {controlError ? (
          <p role="alert" className="max-w-xs text-center text-sm text-red-200">
            {controlError}
          </p>
        ) : null}
        {connected ? (
          <div className="flex items-center gap-6">
            <button
              type="button"
              onClick={() => run(active.held ? "resume" : "hold")}
              disabled={busy}
              aria-pressed={active.held}
              className={`flex size-16 items-center justify-center rounded-full disabled:opacity-50 ${active.held ? "bg-white text-navy-900" : "bg-white/10 hover:bg-white/20"}`}
            >
              {active.held ? (
                <Play className="size-7" aria-hidden />
              ) : (
                <Pause className="size-7" aria-hidden />
              )}
              <span className="sr-only">
                {active.held ? t("voice.control.resume") : t("voice.control.hold")}
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                setShowTransfer((s) => !s);
                setShowKeys(false);
                setConfirmTo(null);
                setControlError(null);
              }}
              aria-pressed={showTransfer}
              className={`flex size-16 items-center justify-center rounded-full ${showTransfer ? "bg-white text-navy-900" : "bg-white/10 hover:bg-white/20"}`}
            >
              <ArrowBendUpRight className="size-7" aria-hidden />
              <span className="sr-only">{t("voice.control.transfer")}</span>
            </button>
          </div>
        ) : null}
        <div className="flex items-center gap-6">
          <button
            type="button"
            onClick={toggleMute}
            aria-pressed={active.muted}
            className={`flex size-16 flex-col items-center justify-center rounded-full ${active.muted ? "bg-white text-navy-900" : "bg-white/10 hover:bg-white/20"}`}
          >
            {active.muted ? (
              <MicrophoneSlash className="size-7" aria-hidden />
            ) : (
              <Microphone className="size-7" aria-hidden />
            )}
            <span className="sr-only">{active.muted ? t("voice.unmute") : t("voice.mute")}</span>
          </button>
          <button
            type="button"
            onClick={hangUp}
            className="flex size-20 items-center justify-center rounded-full bg-red-600 hover:bg-red-700"
          >
            <PhoneDisconnect className="size-9" weight="fill" aria-hidden />
            <span className="sr-only">{t("voice.hangUp")}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setShowKeys((s) => !s);
              setShowTransfer(false);
            }}
            aria-pressed={showKeys}
            className={`flex size-16 items-center justify-center rounded-full ${showKeys ? "bg-white text-navy-900" : "bg-white/10 hover:bg-white/20"}`}
          >
            <DotsNine className="size-7" aria-hidden />
            <span className="sr-only">{t("voice.keypad")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
