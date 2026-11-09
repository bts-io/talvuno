import { Info } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

/**
 * The honest platform caveat: a web app cannot ring a locked phone or a background tab the way a native
 * dialer does. Show it wherever a person might expect background ringing (keypad, settings, onboarding).
 */
export function ForegroundCallNote({ className = "" }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <p
      role="note"
      className={`flex items-start gap-2 rounded-lg border border-brand-blue/30 bg-brand-blue/10 p-3 text-sm text-slate-700 dark:text-slate-200 ${className}`}
    >
      <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-brand-blue" weight="bold" />
      <span>{t("notes.foregroundCalls")}</span>
    </p>
  );
}
