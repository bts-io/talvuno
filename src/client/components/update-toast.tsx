import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { applyUpdate, onUpdateReady } from "../lib/sw";

/** "A new version is ready": shown when a new service worker is waiting. Tapping it reloads into the new build. */
export function UpdateToast() {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  useEffect(() => onUpdateReady((worker) => setReady(worker !== null)), []);
  if (!ready) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-4 bottom-24 z-50 mx-auto flex max-w-sm items-center justify-between gap-3 rounded-xl bg-navy-900 p-3 text-sm text-white shadow-lg md:bottom-6"
    >
      <span>{t("update.available")}</span>
      <button
        type="button"
        onClick={applyUpdate}
        className="rounded-lg bg-brand-blue px-3 py-1.5 font-medium text-white hover:bg-brand-blue-strong"
      >
        {t("update.reload")}
      </button>
    </div>
  );
}
