import { BellSlash } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { useDnd } from "../hooks/use-routing";

/** A small do not disturb switch for the app shell. While on, nothing rings and calls go to voicemail. */
export function DndToggle({ className = "" }: { className?: string }) {
  const { t } = useTranslation();
  const { dnd, ready, toggle } = useDnd();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dnd}
      disabled={!ready || toggle.isPending}
      onClick={() => toggle.mutate(!dnd)}
      className={`flex items-center gap-2 text-sm ${
        dnd
          ? "font-medium text-amber-700 dark:text-amber-300"
          : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
      } ${className}`}
    >
      <BellSlash aria-hidden className="size-4" weight={dnd ? "fill" : "regular"} />
      {t("routing.hours.dnd")}
      <span className="text-xs">{dnd ? t("routing.dndState.on") : t("routing.dndState.off")}</span>
    </button>
  );
}
