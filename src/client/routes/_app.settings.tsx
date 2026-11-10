import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { DndToggle } from "../components/dnd-toggle";
import { ForegroundCallNote } from "../components/foreground-call-note";
import { NotificationsSettings } from "../components/notifications-settings";
import { AboutSection } from "../components/settings/about-section";
import { AccountSection } from "../components/settings/account-section";
import { AiSummariesSection } from "../components/settings/ai-summaries-section";
import { BlockedSection } from "../components/settings/blocked-section";
import { DigestSection } from "../components/settings/digest-section";
import { HoursSection } from "../components/settings/hours-section";
import { JumpList } from "../components/settings/jump-list";
import { MenuSection } from "../components/settings/menu-section";
import { MissedCallTextSection } from "../components/settings/missed-call-text-section";
import { NumbersSection } from "../components/settings/numbers-section";
import { QuickRepliesSection } from "../components/settings/quick-replies-section";
import { RecordingSection } from "../components/settings/recording-section";
import { SafetySection } from "../components/settings/safety-section";
import { SetupCheckSection } from "../components/settings/setup-check-section";
import { StatsSection } from "../components/settings/stats-section";
import { VoicemailSection } from "../components/settings/voicemail-section";

export const Route = createFileRoute("/_app/settings")({ component: SettingsPage });

function SettingsPage() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 md:p-8">
      <h1 className="text-2xl font-semibold tracking-tight">{t("nav.settings")}</h1>
      <JumpList />
      <DndToggle className="md:hidden" />
      <ForegroundCallNote />
      <NotificationsSettings />
      <NumbersSection />
      <HoursSection />
      <MenuSection />
      <VoicemailSection />
      <RecordingSection />
      <AiSummariesSection />
      <BlockedSection />
      <QuickRepliesSection />
      <MissedCallTextSection />
      <SafetySection />
      <DigestSection />
      <StatsSection />
      <AccountSection />
      <SetupCheckSection />
      <AboutSection />
    </div>
  );
}
