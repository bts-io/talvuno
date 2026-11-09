import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { type Me, PASSWORD_MAX, PASSWORD_MIN } from "../../contracts";
import { AuthCard, Field, SubmitButton } from "../components/auth-card";
import { ForegroundCallNote } from "../components/foreground-call-note";
import { meQuery, setupStatusQuery } from "../hooks/use-me";
import { ApiError, api } from "../lib/api";

/** First run only: once an owner exists this page sends everyone to /login. */
export const Route = createFileRoute("/setup")({
  beforeLoad: async ({ context }) => {
    const setup = await context.queryClient.fetchQuery(setupStatusQuery());
    if (!setup.needed) throw redirect({ to: "/login" });
  },
  component: SetupPage,
});

function SetupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const me = await api<Me>("/api/setup", {
        method: "POST",
        json: {
          name: form.get("name"),
          email: form.get("email"),
          password: form.get("password"),
          setupToken: form.get("setupToken"),
        },
      });
      qc.setQueryData(meQuery().queryKey, me);
      await navigate({ to: "/keypad" });
    } catch (err) {
      setError(t("auth.setupFailed", { message: err instanceof ApiError ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t("auth.setupTitle")}>
      <p className="mb-4 text-sm text-slate-600 dark:text-slate-300">{t("auth.setupIntro")}</p>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label={t("auth.name")} name="name" autoComplete="name" required maxLength={100} />
        <Field label={t("auth.email")} name="email" type="email" autoComplete="username" required />
        <Field
          label={t("auth.password")}
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN}
          maxLength={PASSWORD_MAX}
          hint={t("auth.passwordHint", { min: PASSWORD_MIN })}
        />
        <Field
          label={t("auth.setupToken")}
          name="setupToken"
          type="password"
          autoComplete="off"
          required
          maxLength={256}
          hint={t("auth.setupTokenHint")}
        />
        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}
        <SubmitButton busy={busy}>{busy ? t("auth.setupWorking") : t("auth.setupSubmit")}</SubmitButton>
      </form>
      <ForegroundCallNote className="mt-6" />
    </AuthCard>
  );
}
