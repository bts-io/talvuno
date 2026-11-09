import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { numbersQuery, preferencesQuery } from "../hooks/use-settings";

/**
 * Shown above every signed-in screen until a number exists and the country allowlist is not empty: without
 * them nothing can be sent or called. Stays quiet while loading and on the Settings page itself.
 */
export function FirstRunBanner() {
  const { t } = useTranslation();
  const onSettings = useRouterState({ select: (s) => s.location.pathname.startsWith("/settings") });
  const numbers = useQuery(numbersQuery());
  const prefs = useQuery(preferencesQuery());
  if (onSettings || !numbers.data || !prefs.data) return null;
  const noNumbers = numbers.data.every((n) => n.releasedAt);
  const noCountries = prefs.data.countryAllowlist.length === 0;
  if (!noNumbers && !noCountries) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-400/60 bg-amber-50 px-4 py-2 text-sm dark:bg-amber-400/10"
    >
      <span>{noNumbers ? t("settings.banner.noNumbers") : t("settings.banner.noCountries")}</span>
      <Link to="/settings" className="font-medium text-brand-blue-strong underline">
        {t("settings.banner.cta")}
      </Link>
    </div>
  );
}
