import { CheckCircle, XCircle } from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { ConfigStatus } from "../../../contracts/numbers";
import { configQuery, testTwilio } from "../../hooks/use-settings";
import { buttonClass, ErrorLine, Section } from "./section";

const ITEMS: { key: keyof ConfigStatus; label: string; optional?: boolean }[] = [
  { key: "twilioAccountSid", label: "TWILIO_ACCOUNT_SID" },
  { key: "twilioApiKey", label: "TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET" },
  { key: "twilioAuthToken", label: "TWILIO_AUTH_TOKEN" },
  { key: "twilioTwimlApp", label: "TWILIO_TWIML_APP_SID" },
  { key: "publicUrl", label: "PUBLIC_URL" },
  { key: "vapid", label: "VAPID keys", optional: true },
  { key: "oidc", label: "OIDC", optional: true },
  { key: "setupToken", label: "SETUP_TOKEN", optional: true },
];

export function SetupCheckSection() {
  const { t } = useTranslation();
  const { data, error } = useQuery(configQuery());
  const test = useMutation({ mutationFn: testTwilio });

  return (
    <Section id="setup-check" title={t("settings.check.title")} intro={t("settings.check.intro")}>
      <ErrorLine error={error} />
      <ul className="flex flex-col gap-1 text-sm">
        {data
          ? ITEMS.map(({ key, label, optional }) => (
              <li key={key} className="flex items-center gap-2">
                {data[key] ? (
                  <CheckCircle aria-hidden weight="fill" className="size-5 text-brand-green" />
                ) : (
                  <XCircle
                    aria-hidden
                    weight="fill"
                    className={`size-5 ${optional ? "text-slate-400" : "text-red-500"}`}
                  />
                )}
                <span className="font-mono">{label}</span>
                <span className="text-slate-500 dark:text-slate-400">
                  {data[key]
                    ? t("settings.check.set")
                    : optional
                      ? t("settings.check.optionalMissing")
                      : t("settings.check.missing")}
                </span>
              </li>
            ))
          : null}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={buttonClass} disabled={test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? t("settings.check.testing") : t("settings.check.test")}
        </button>
        {test.data ? (
          <p role="status" className="text-sm">
            {test.data.ok
              ? test.data.currency
                ? t("settings.check.ok", { currency: test.data.currency })
                : t("settings.check.okNoCurrency")
              : t("settings.check.failed", { error: test.data.error })}
          </p>
        ) : null}
        <ErrorLine error={test.error} />
      </div>
    </Section>
  );
}
