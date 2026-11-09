import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ForegroundCallNote } from "../components/foreground-call-note";
import { NotificationsSettings } from "../components/notifications-settings";
import { AccountSection } from "../components/settings/account-section";
import { NumbersSection } from "../components/settings/numbers-section";
import { SafetySection } from "../components/settings/safety-section";
import { SetupCheckSection } from "../components/settings/setup-check-section";

export const Route = createFileRoute("/_app/settings")({ component: SettingsPage });

function SettingsPage() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 md:p-8">
      <h1 className="text-2xl font-semibold tracking-tight">{t("nav.settings")}</h1>
      <ForegroundCallNote />
      <NotificationsSettings />
      <NumbersSection />
      <SafetySection />
      <AccountSection />
      <SetupCheckSection />
    </div>
  );
}
