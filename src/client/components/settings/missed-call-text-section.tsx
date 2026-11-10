import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { type MissedCallText, QUICK_REPLY_MAX } from "../../../contracts/messages";
import { formatPhone } from "../../../lib/phone";
import { missedCallTextsQuery, saveMissedCallText } from "../../lib/quick-replies";
import { ErrorLine, inputClass, primaryButtonClass, Section } from "./section";

function NumberRow({ n }: { n: MissedCallText }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(n.enabled);
  const [text, setText] = useState(n.text);
  const save = useMutation({
    mutationFn: () => saveMissedCallText(n.numberId, { enabled, text: text.trim() }),
    onSuccess: (saved) =>
      qc.setQueryData<MissedCallText[]>(["missed-call-text"], (list) =>
        list?.map((x) => (x.numberId === saved.numberId ? saved : x)),
      ),
  });
  const dirty = enabled !== n.enabled || text.trim() !== n.text;
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3 dark:border-navy-800">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {n.friendlyName || formatPhone(n.e164)}
      </label>
      <input
        aria-label={t("settings.missedCallText.text")}
        value={text}
        maxLength={QUICK_REPLY_MAX}
        onChange={(e) => setText(e.target.value)}
        className={inputClass}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!dirty || save.isPending || (enabled && !text.trim())}
          onClick={() => save.mutate()}
          className={primaryButtonClass}
        >
          {t("settings.save")}
        </button>
        <ErrorLine error={save.error} />
      </div>
    </li>
  );
}

/** Settings: the automatic text to a caller after a missed call, per number, off until turned on. */
export function MissedCallTextSection() {
  const { t } = useTranslation();
  const { data: numbers, error } = useQuery(missedCallTextsQuery());
  return (
    <Section
      id="missed-call-text"
      title={t("settings.missedCallText.title")}
      intro={t("settings.missedCallText.intro")}
    >
      <ErrorLine error={error} />
      <ul className="flex flex-col gap-2">
        {(numbers ?? []).map((n) => (
          <NumberRow key={`${n.numberId}:${n.enabled}:${n.text}`} n={n} />
        ))}
      </ul>
    </Section>
  );
}
