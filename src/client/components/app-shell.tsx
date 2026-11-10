import {
  ChatsCircle,
  ClockCounterClockwise,
  DotsNine,
  GearSix,
  type Icon,
  SignOut,
  UserList,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useLive } from "../hooks/use-live";
import { authClient } from "../lib/auth-client";
import { clearAllDrafts } from "../lib/drafts";
import { disablePush } from "../lib/push";
import { cleanupBeforeSignOut } from "../lib/sign-out-cleanup";
import { openUrlFromMessage } from "../lib/sw";
import { FirstRunBanner } from "./first-run-banner";
import { PhoneProvider } from "./phone-provider";

export const TABS: {
  to: "/keypad" | "/recents" | "/messages" | "/contacts" | "/settings";
  key: string;
  icon: Icon;
}[] = [
  { to: "/keypad", key: "nav.keypad", icon: DotsNine },
  { to: "/recents", key: "nav.recents", icon: ClockCounterClockwise },
  { to: "/messages", key: "nav.messages", icon: ChatsCircle },
  { to: "/contacts", key: "nav.contacts", icon: UserList },
  { to: "/settings", key: "nav.settings", icon: GearSix },
];

/**
 * The signed-in layout. Phones get a bottom tab bar (thumb reach, safe-area aware); from `md` up the same tabs
 * become a sidebar. Logical properties (start/end, ps/pe) keep it correct in right-to-left languages.
 */
export function AppShell() {
  const { t } = useTranslation();
  const live = useLive();
  const qc = useQueryClient();
  const navigate = useNavigate();

  // A tapped notification asks the open window to route itself, so a call in progress is never reloaded.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
    const onMessage = (event: MessageEvent) => {
      const path = openUrlFromMessage(event.data, window.location.origin);
      if (path) void navigate({ to: path });
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [navigate]);

  const signOut = async () => {
    await cleanupBeforeSignOut({ unsubscribe: disablePush, clearDrafts: clearAllDrafts });
    await authClient.signOut();
    qc.clear();
    await navigate({ to: "/login" });
  };

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="hidden w-60 shrink-0 flex-col border-e border-slate-200 bg-white p-4 md:flex dark:border-navy-800 dark:bg-navy-900">
        <div className="mb-6 flex items-center gap-2 px-2">
          <img src="/brand/talvuno-mascot.webp" alt="" width="40" height="32" className="h-8 w-auto" />
          <img
            src="/brand/talvuno-wordmark-dark.svg"
            alt={t("app.name")}
            className="h-5 w-auto dark:hidden"
          />
          <img
            src="/brand/talvuno-wordmark.svg"
            alt={t("app.name")}
            className="hidden h-5 w-auto dark:block"
          />
        </div>
        <nav aria-label={t("nav.main")} className="flex flex-col gap-1">
          {TABS.map(({ to, key, icon: TabIcon }) => (
            <Link
              key={to}
              to={to}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-navy-800"
              activeProps={{
                className:
                  "bg-brand-blue/10 font-medium text-brand-blue dark:bg-brand-blue/15 dark:text-brand-blue",
              }}
            >
              <TabIcon aria-hidden className="size-5" />
              {t(key)}
            </Link>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2 px-2 text-sm">
          <LiveBadge state={live} />
          <button
            onClick={signOut}
            className="flex items-center gap-2 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
          >
            <SignOut aria-hidden className="size-4" />
            {t("auth.signOut")}
          </button>
        </div>
      </aside>

      <main className="flex-1 pb-20 md:pb-0">
        <FirstRunBanner />
        <PhoneProvider>
          <Outlet />
        </PhoneProvider>
      </main>

      <nav
        aria-label={t("nav.main")}
        className="fixed inset-x-0 bottom-0 z-10 border-t border-slate-200 bg-white/95 backdrop-blur md:hidden dark:border-navy-800 dark:bg-navy-900/95"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <ul className="grid grid-cols-5">
          {TABS.map(({ to, key, icon: TabIcon }) => (
            <li key={to}>
              <Link
                to={to}
                className="flex flex-col items-center gap-0.5 py-2 text-xs text-slate-500 dark:text-slate-400"
                activeProps={{ className: "text-brand-blue dark:text-brand-blue" }}
              >
                <TabIcon aria-hidden className="size-6" />
                {t(key)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

function LiveBadge({ state }: { state: ReturnType<typeof useLive> }) {
  const { t } = useTranslation();
  const open = state === "open";
  return (
    <span className="flex items-center gap-2 text-slate-500 dark:text-slate-400" aria-live="polite">
      <span aria-hidden className={`size-2 rounded-full ${open ? "bg-brand-green" : "bg-amber-400"}`} />
      {open ? t("live.connected") : t("live.reconnecting")}
    </span>
  );
}
