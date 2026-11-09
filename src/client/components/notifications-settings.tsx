import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  currentSubscription,
  disablePush,
  enablePush,
  PushSetupError,
  type PushSupport,
  pushSupport,
  readPlatform,
  sendTestPush,
} from "../lib/push";

/** The browser event that offers the install prompt (Chrome, Edge and Android; not in lib.dom). */
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type Status = "loading" | "on" | "off" | "denied";

const button =
  "rounded-lg bg-brand-blue-strong px-3 py-2 text-sm font-medium text-white hover:bg-brand-blue disabled:opacity-50";
const secondary =
  "rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-50 dark:border-navy-700 dark:hover:bg-navy-800";

/**
 * Settings section: turn notifications on for this device, send a test, and install the app. Notices cover
 * missed calls and new messages only. A closed app cannot ring for a call, and iOS needs the app on the Home
 * Screen before it allows notifications at all.
 */
export function NotificationsSettings() {
  const { t } = useTranslation();
  const [support, setSupport] = useState<PushSupport | null>(null);
  const [ios, setIos] = useState(false);
  const [standalone, setStandalone] = useState(false);
  const [status, setStatus] = useState<Status>("loading");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [installEvent, setInstallEvent] = useState<InstallPromptEvent | null>(null);

  const refresh = useCallback(async () => {
    const platform = readPlatform();
    setSupport(pushSupport(platform));
    setIos(platform.ios);
    setStandalone(platform.standalone);
    if (!platform.hasPush) return setStatus("off");
    if (Notification.permission === "denied") return setStatus("denied");
    try {
      setStatus((await currentSubscription()) && Notification.permission === "granted" ? "on" : "off");
    } catch {
      setStatus("off");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstallEvent(null);
      setStandalone(true);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, [refresh]);

  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await action());
    } catch (err) {
      if (err instanceof PushSetupError) setMessage(t(`push.error.${err.code}`));
      else setMessage(t("push.error.generic"));
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const enable = () =>
    run(async () => {
      await enablePush();
      return t("push.enabled");
    });
  const disable = () =>
    run(async () => {
      await disablePush();
      return t("push.disabled");
    });
  const test = () =>
    run(async () => {
      const res = await sendTestPush();
      return res.sent > 0 ? t("push.testSent") : t("push.testNone");
    });
  const install = async () => {
    if (!installEvent) return;
    await installEvent.prompt();
    await installEvent.userChoice;
    setInstallEvent(null);
  };

  return (
    <section aria-labelledby="notifications-heading" className="flex flex-col gap-4">
      <h2 id="notifications-heading" className="text-lg font-semibold">
        {t("push.title")}
      </h2>
      <p className="text-sm text-slate-600 dark:text-slate-300">{t("push.intro")}</p>
      <p className="text-sm text-slate-600 dark:text-slate-300">{t("push.closedAppLimit")}</p>

      {support === "needs-install" && (
        <p role="note" className="rounded-lg border border-brand-blue/30 bg-brand-blue/10 p-3 text-sm">
          {t("push.iosNeedsInstall")}
        </p>
      )}
      {support === "unsupported" && (
        <p role="note" className="rounded-lg border border-slate-300 p-3 text-sm dark:border-navy-700">
          {t("push.unsupported")}
        </p>
      )}
      {status === "denied" && (
        <p role="note" className="rounded-lg border border-slate-300 p-3 text-sm dark:border-navy-700">
          {t("push.blocked")}
        </p>
      )}

      <p className="text-sm" aria-live="polite">
        {t("push.status")}: <strong>{t(`push.state.${status}`)}</strong>
      </p>

      <div className="flex flex-wrap gap-2">
        {status !== "on" ? (
          <button
            type="button"
            className={button}
            onClick={enable}
            disabled={busy || support !== "ready" || status === "denied"}
          >
            {t("push.enable")}
          </button>
        ) : (
          <>
            <button type="button" className={secondary} onClick={test} disabled={busy}>
              {t("push.test")}
            </button>
            <button type="button" className={secondary} onClick={disable} disabled={busy}>
              {t("push.disable")}
            </button>
          </>
        )}
      </div>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}

      {support !== null && !standalone && (
        <div className="flex flex-col gap-2 border-t border-slate-200 pt-4 dark:border-navy-800">
          <h3 className="font-medium">{t("install.title")}</h3>
          {installEvent && (
            <div>
              <button type="button" className={button} onClick={install}>
                {t("install.button")}
              </button>
            </div>
          )}
          {ios ? (
            <ol className="list-decimal ps-5 text-sm text-slate-600 dark:text-slate-300">
              <li>{t("install.iosStep1")}</li>
              <li>{t("install.iosStep2")}</li>
              <li>{t("install.iosStep3")}</li>
            </ol>
          ) : (
            !installEvent && (
              <p className="text-sm text-slate-600 dark:text-slate-300">{t("install.other")}</p>
            )
          )}
        </div>
      )}
    </section>
  );
}
