import { type ErrorComponentProps, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <main className="mx-auto max-w-md p-8 text-center">
      <p className="text-lg">{t("errors.notFound")}</p>
      <Link to="/" className="mt-4 inline-block text-brand-blue underline">
        {t("app.name")}
      </Link>
    </main>
  );
}

export function ErrorPage({ error }: ErrorComponentProps) {
  const { t } = useTranslation();
  return (
    <main className="mx-auto max-w-md p-8 text-center" role="alert">
      <p className="text-lg">{t("errors.generic")}</p>
      {import.meta.env.DEV ? (
        <pre className="mt-4 text-start text-xs whitespace-pre-wrap">
          {error instanceof Error ? error.message : String(error)}
        </pre>
      ) : null}
    </main>
  );
}
