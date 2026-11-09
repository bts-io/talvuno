import { DotsNine, Microphone, MicrophoneSlash, PhoneDisconnect } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatPhone, isE164 } from "../../lib/phone";
import { formatCallTime } from "../lib/voice";
import { usePhone } from "./phone-provider";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"] as const;

/** What to call a party on screen: the contact name, else the formatted number, else "Withheld number". */
export function usePartyLabel(party: string, name: string | null) {
  const { t } = useTranslation();
  if (name) return name;
  return isE164(party) ? formatPhone(party) : t("voice.withheld");
}

/** Full-screen call in progress: who, timer, mute, keypad for tones, hang up. */
export function ActiveCallScreen() {
  const { t } = useTranslation();
  const { active, hangUp, toggleMute, sendDigits } = usePhone();
  const [now, setNow] = useState(() => Date.now());
  const [showKeys, setShowKeys] = useState(false);
  const [tones, setTones] = useState("");
  const label = usePartyLabel(active?.party ?? "", active?.name ?? null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!active) return null;
  const status =
    active.state === "open" && active.answeredAt
      ? formatCallTime((now - active.answeredAt) / 1000)
      : t(`voice.state.${active.state}`);

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

      {showKeys ? (
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
          onClick={() => setShowKeys((s) => !s)}
          aria-pressed={showKeys}
          className={`flex size-16 items-center justify-center rounded-full ${showKeys ? "bg-white text-navy-900" : "bg-white/10 hover:bg-white/20"}`}
        >
          <DotsNine className="size-7" aria-hidden />
          <span className="sr-only">{t("voice.keypad")}</span>
        </button>
      </div>
    </div>
  );
}
