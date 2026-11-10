import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { buttonClass, Section } from "./section";

/** A link card to the Activity page (stats and CSV export). */
export function StatsSection() {
  const { t } = useTranslation();
  return (
    <Section id="stats" title={t("settings.stats.title")} intro={t("settings.stats.intro")}>
      <div>
        <Link to="/stats" className={`${buttonClass} inline-block`}>
          {t("settings.stats.open")}
        </Link>
      </div>
    </Section>
  );
}
