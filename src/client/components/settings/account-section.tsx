import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { BillingUsageLine } from "../../../contracts/numbers";
import { billingQuery } from "../../hooks/use-settings";
import { ApiError } from "../../lib/api";
import { ErrorLine, Section } from "./section";

function money(amount: string | null, currency: string | null, locale: string) {
  const n = Number(amount);
  if (amount === null || !Number.isFinite(n)) return "-";
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: (currency ?? "USD").toUpperCase(),
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency ?? ""}`.trim();
  }
}

export function AccountSection() {
  const { t, i18n } = useTranslation();
  const { data, error, isLoading, refetch, isFetching } = useQuery(billingQuery());
  const notConfigured = error instanceof ApiError && error.code === "not_configured";

  const row = (label: string, line: BillingUsageLine) => (
    <tr>
      <th scope="row" className="py-1 pe-4 text-start font-normal text-slate-600 dark:text-slate-300">
        {label}
      </th>
      <td className="py-1 pe-4">
        {line.usage ?? "0"} {line.usageUnit ?? ""}
      </td>
      <td className="py-1 text-end">{money(line.price, line.priceUnit, i18n.language)}</td>
    </tr>
  );

  return (
    <Section id="account" title={t("settings.account.title")}>
      {isLoading ? <p className="text-sm">{t("settings.loading")}</p> : null}
      {notConfigured ? <p className="text-sm">{t("settings.account.notConfigured")}</p> : null}
      {error && !notConfigured ? <ErrorLine error={error} /> : null}
      {data ? (
        <>
          <p>
            <span className="text-sm text-slate-600 dark:text-slate-300">
              {t("settings.account.balance")}
            </span>
            <br />
            <span className="text-2xl font-semibold">
              {money(data.balance.amount, data.balance.currency, i18n.language)}
            </span>
          </p>
          <div>
            <h3 className="text-sm font-medium">
              {t("settings.account.usage", {
                period:
                  data.period.start && data.period.end
                    ? t("settings.account.range", { start: data.period.start, end: data.period.end })
                    : t("settings.account.thisMonth"),
              })}
            </h3>
            <table className="mt-1 text-sm">
              <tbody>
                {row(t("settings.account.calls"), data.usage.calls)}
                {row(t("settings.account.sms"), data.usage.sms)}
                {row(t("settings.account.total"), data.usage.total)}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      {!notConfigured ? (
        <div>
          <button
            type="button"
            className="text-sm text-brand-blue-strong underline disabled:opacity-50"
            disabled={isFetching}
            onClick={() => refetch()}
          >
            {t("settings.account.refresh")}
          </button>
        </div>
      ) : null}
    </Section>
  );
}
