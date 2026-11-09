import type { ReactNode } from "react";

/** The card every Settings section sits in. */
export function Section({
  id,
  title,
  intro,
  children,
}: {
  id: string;
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-navy-800 dark:bg-navy-900"
    >
      <div>
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {title}
        </h2>
        {intro ? <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{intro}</p> : null}
      </div>
      {children}
    </section>
  );
}

export const buttonClass =
  "rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 disabled:opacity-50 dark:border-navy-700 dark:hover:bg-navy-800";
export const primaryButtonClass =
  "rounded-lg bg-brand-blue-strong px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-blue disabled:opacity-50";
export const dangerButtonClass =
  "rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50";
export const inputClass =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-navy-700 dark:bg-navy-950";

/** Inline confirmation: says what will happen and asks for a second click. */
export function Confirm({
  message,
  confirmLabel,
  cancelLabel,
  busy,
  danger,
  onConfirm,
  onCancel,
}: {
  message: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  busy?: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-label={confirmLabel}
      className="flex flex-col gap-3 rounded-lg border border-amber-400/60 bg-amber-50 p-3 text-sm dark:bg-amber-400/10"
    >
      <div>{message}</div>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className={danger ? dangerButtonClass : primaryButtonClass}
        >
          {confirmLabel}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className={buttonClass}>
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}

export function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm text-red-600 dark:text-red-400">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}
