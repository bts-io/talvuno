import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { AuthCard, Field, SsoButton, SubmitButton } from "../components/auth-card";
import { meQuery, setupStatusQuery } from "../hooks/use-me";
import { authClient } from "../lib/auth-client";
import { safeNext } from "../lib/safe-next";

export const Route = createFileRoute("/login")({
  validateSearch: z.object({ next: z.string().optional(), sso: z.string().optional() }),
  beforeLoad: async ({ context, search }) => {
    if (await context.queryClient.ensureQueryData(meQuery())) throw redirect({ href: safeNext(search.next) });
    const setup = await context.queryClient.fetchQuery(setupStatusQuery());
    if (setup.needed) throw redirect({ to: "/setup" });
  },
  component: LoginPage,
});

function LoginPage() {
  const { t } = useTranslation();
  const { next, sso } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shownError = error ?? (sso === "failed" ? t("auth.ssoRefused") : null);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.signIn.email({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    setBusy(false);
    if (err) {
      setError(t("auth.signInFailed"));
      return;
    }
    await qc.invalidateQueries({ queryKey: meQuery().queryKey });
    await navigate({ href: safeNext(next) });
  };

  return (
    <AuthCard title={t("auth.signInTitle")}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label={t("auth.email")} name="email" type="email" autoComplete="username" required />
        <Field
          label={t("auth.password")}
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        {shownError ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {shownError}
          </p>
        ) : null}
        <SubmitButton busy={busy}>{busy ? t("auth.signingIn") : t("auth.signIn")}</SubmitButton>
      </form>
      <SsoButton page="/login" />
    </AuthCard>
  );
}
