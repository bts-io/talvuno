import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { authConfigQuery } from "../hooks/use-me";
import { authClient } from "../lib/auth-client";

/** Centered card on the brand navy, used by /login and /setup. */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-navy-950 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl dark:bg-navy-900">
        <img src="/brand/talvuno-mascot.webp" alt="" width="96" height="78" className="mx-auto h-auto w-24" />
        <img
          src="/brand/talvuno-wordmark-dark.svg"
          alt="Talvuno"
          className="mx-auto mt-2 mb-4 h-6 w-auto dark:hidden"
        />
        <img
          src="/brand/talvuno-wordmark.svg"
          alt="Talvuno"
          className="mx-auto mt-2 mb-4 hidden h-6 w-auto dark:block"
        />
        <h1 className="mb-6 text-center text-xl font-semibold">{title}</h1>
        {children}
      </div>
    </main>
  );
}

/**
 * The SSO button, shown only when the deployment has OpenID Connect configured. `page` is where Better Auth
 * sends the browser back to if the provider or our owner check refuses the sign-in.
 */
export function SsoButton({ page }: { page: "/login" }) {
  const { t } = useTranslation();
  const config = useQuery(authConfigQuery());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  if (!config.data?.oidc) return null;
  const go = async () => {
    setBusy(true);
    setError(false);
    const { error: err } = await authClient.signIn.social({
      provider: "oidc",
      callbackURL: "/keypad",
      errorCallbackURL: `${page}?sso=failed`,
    });
    // On success the browser is already navigating to the provider.
    if (err) {
      setBusy(false);
      setError(true);
    }
  };
  return (
    <div className="mt-4 flex flex-col gap-3">
      <p className="text-center text-xs text-slate-500 dark:text-slate-400">{t("auth.or")}</p>
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="rounded-lg border border-slate-300 px-4 py-2.5 font-medium hover:bg-slate-50 disabled:opacity-60 dark:border-navy-700 dark:hover:bg-navy-800"
      >
        {config.data.oidcLabel}
      </button>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t("auth.ssoUnavailable")}
        </p>
      ) : null}
    </div>
  );
}

export function Field({
  label,
  hint,
  ...input
}: { label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <input
        {...input}
        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-base dark:border-navy-700 dark:bg-navy-950"
      />
      {hint ? <span className="text-xs text-slate-500 dark:text-slate-400">{hint}</span> : null}
    </label>
  );
}

export function SubmitButton({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="mt-2 rounded-lg bg-brand-blue px-4 py-2.5 font-medium text-white hover:bg-brand-blue-strong disabled:opacity-60"
    >
      {children}
    </button>
  );
}
