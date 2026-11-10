import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { QUICK_REPLY_MAX } from "../../../contracts/messages";
import { addQuickReply, quickRepliesQuery, removeQuickReply, saveQuickReply } from "../../lib/quick-replies";
import { buttonClass, ErrorLine, inputClass, primaryButtonClass, Section } from "./section";

/** Settings: the saved short replies used in the composer and when declining a call with a text. */
export function QuickRepliesSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: replies, error: loadError } = useQuery(quickRepliesQuery());
  const [newText, setNewText] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["quick-replies"] });

  const add = useMutation({
    mutationFn: addQuickReply,
    onSuccess: () => {
      setNewText("");
      return refresh();
    },
  });
  const save = useMutation({
    mutationFn: (v: { id: string; text: string }) => saveQuickReply(v.id, v.text),
    onSuccess: () => {
      setEditing(null);
      return refresh();
    },
  });
  const remove = useMutation({ mutationFn: removeQuickReply, onSuccess: refresh });

  const submitNew = (e: FormEvent) => {
    e.preventDefault();
    if (newText.trim()) add.mutate(newText.trim());
  };

  return (
    <Section
      id="quick-replies"
      title={t("settings.quickReplies.title")}
      intro={t("settings.quickReplies.intro")}
    >
      <ErrorLine error={loadError ?? add.error ?? save.error ?? remove.error} />
      <ul className="flex flex-col gap-2">
        {(replies ?? []).map((r) => (
          <li key={r.id} className="flex items-center gap-2">
            {editing?.id === r.id ? (
              <>
                <input
                  aria-label={t("settings.quickReplies.text")}
                  value={editing.text}
                  maxLength={QUICK_REPLY_MAX}
                  onChange={(e) => setEditing({ id: r.id, text: e.target.value })}
                  className={inputClass}
                />
                <button
                  type="button"
                  disabled={save.isPending || !editing.text.trim()}
                  onClick={() => save.mutate({ id: r.id, text: editing.text.trim() })}
                  className={primaryButtonClass}
                >
                  {t("settings.save")}
                </button>
                <button type="button" onClick={() => setEditing(null)} className={buttonClass}>
                  {t("settings.cancel")}
                </button>
              </>
            ) : (
              <>
                <span className="min-w-0 flex-1 break-words text-sm">{r.text}</span>
                <button
                  type="button"
                  onClick={() => setEditing({ id: r.id, text: r.text })}
                  className={buttonClass}
                >
                  {t("settings.quickReplies.edit")}
                </button>
                <button
                  type="button"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(r.id)}
                  className={buttonClass}
                >
                  {t("settings.quickReplies.remove")}
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={submitNew} className="flex items-center gap-2">
        <input
          aria-label={t("settings.quickReplies.new")}
          placeholder={t("settings.quickReplies.new")}
          value={newText}
          maxLength={QUICK_REPLY_MAX}
          onChange={(e) => setNewText(e.target.value)}
          className={inputClass}
        />
        <button type="submit" disabled={add.isPending || !newText.trim()} className={primaryButtonClass}>
          {t("settings.quickReplies.add")}
        </button>
      </form>
    </Section>
  );
}
