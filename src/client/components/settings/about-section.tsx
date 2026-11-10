import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import pkg from "../../../../package.json";
import { authConfigQuery } from "../../hooks/use-me";
import { Section } from "./section";

/** Version and licence note, with the source link AGPL section 13 asks us to offer to users of a running copy. */
export function AboutSection() {
  const { t } = useTranslation();
  const config = useQuery(authConfigQuery());
  return (
    <Section id="about" title={t("settings.about.title")}>
      <p className="text-sm">{t("settings.about.version", { version: pkg.version })}</p>
      <p className="text-sm">
        {t("settings.about.license")}{" "}
        {config.data ? (
          <a
            href={config.data.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="text-brand-blue-strong underline"
          >
            {t("settings.about.source")}
          </a>
        ) : null}
      </p>
    </Section>
  );
}
