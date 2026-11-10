import { useTranslation } from "react-i18next";

/** The Settings sections in page order, as [anchor id, label key]. */
export const SETTINGS_SECTIONS = [
  ["notifications", "settings.jump.notifications"],
  ["numbers", "settings.jump.numbers"],
  ["hours", "settings.jump.hours"],
  ["voicemail", "settings.jump.voicemail"],
  ["blocked", "settings.jump.blocked"],
  ["quick-replies", "settings.jump.quickReplies"],
  ["missed-call-text", "settings.jump.missedCallText"],
  ["safety", "settings.jump.safety"],
  ["digest", "settings.jump.digest"],
  ["account", "settings.jump.account"],
  ["setup-check", "settings.jump.setupCheck"],
] as const;

/** A compact "Jump to" list of the section anchors, for small screens where Settings is very long. */
export function JumpList() {
  const { t } = useTranslation();
  return (
    <nav
      aria-label={t("settings.jump.label")}
      className="flex flex-wrap items-center gap-2 text-sm md:hidden"
    >
      <span className="text-slate-500 dark:text-slate-400">{t("settings.jump.label")}</span>
      {SETTINGS_SECTIONS.map(([id, key]) => (
        <a
          key={id}
          href={`#${id}`}
          className="rounded-full border border-slate-300 px-3 py-1 hover:bg-slate-100 dark:border-navy-700 dark:hover:bg-navy-800"
        >
          {t(key)}
        </a>
      ))}
    </nav>
  );
}
