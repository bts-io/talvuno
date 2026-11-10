import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AiSummarySettings } from "../../../contracts/ai-summary";
import { api } from "../../lib/api";
import { ErrorLine, Section } from "./section";

const KEY = ["ai-summary-settings"] as const;

/** AI summaries on or off. Off means no transcript is sent to the model. */
export function AiSummariesSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: KEY,
    queryFn: () => api<AiSummarySettings>("/api/ai-summaries/settings"),
  });
  const save = useMutation({
    mutationFn: (enabled: boolean) =>
      api<AiSummarySettings>("/api/ai-summaries/settings", { method: "PUT", json: { enabled } }),
    onSuccess: (s) => qc.setQueryData(KEY, s),
  });
  const enabled = save.isPending ? Boolean(save.variables) : (data?.enabled ?? true);

  return (
    <Section
      id="ai-summaries"
      title={t("settings.aiSummaries.title")}
      intro={t("settings.aiSummaries.intro")}
    >
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!data || save.isPending}
          onChange={(e) => save.mutate(e.target.checked)}
        />
        {t("settings.aiSummaries.enable")}
      </label>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        {t(enabled ? "settings.aiSummaries.onHint" : "settings.aiSummaries.offHint")}
      </p>
      <ErrorLine error={save.error} />
    </Section>
  );
}
