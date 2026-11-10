import { ChatCircleText, PaperPlaneRight } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { type FormEvent, type KeyboardEvent, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { SMS_BODY_MAX } from "../../contracts";
import { smsLength } from "../../lib/sms";
import { useDraft } from "../lib/drafts";
import { fillDraft, quickRepliesQuery } from "../lib/quick-replies";

/**
 * The message box: a growing textarea kept as a draft on this device under `draftKey`, a character and
 * segment count, and a send button. Enter sends on devices with a keyboard; Shift+Enter adds a line.
 */
export function SmsComposer({
  draftKey,
  disabled,
  onSend,
}: {
  draftKey: string;
  disabled?: boolean;
  /** Resolve true when the message was accepted, so the draft is cleared. */
  onSend: (body: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft, clear] = useDraft(draftKey);
  const counterId = useId();
  const [pickerOpen, setPickerOpen] = useState(false);
  const replies = useQuery(quickRepliesQuery());
  const length = smsLength(draft);
  const tooLong = length.characters > SMS_BODY_MAX;
  const canSend = !disabled && draft.trim().length > 0 && !tooLong;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSend) return;
    const body = draft;
    clear();
    if (!(await onSend(body))) setDraft(body);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.nativeEvent.isComposing &&
      window.matchMedia("(pointer: fine)").matches
    ) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form
      onSubmit={submit}
      className="border-t border-slate-200 bg-white p-2 dark:border-navy-800 dark:bg-navy-900"
      style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
    >
      {pickerOpen && replies.data?.length ? (
        <ul aria-label={t("messages.quickReplies")} className="mb-2 flex flex-wrap gap-1.5">
          {replies.data.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => {
                  setDraft(fillDraft(draft, r.text));
                  setPickerOpen(false);
                }}
                className="rounded-full bg-slate-100 px-3 py-1 text-sm hover:bg-slate-200 dark:bg-navy-800 dark:hover:bg-navy-700"
              >
                {r.text}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-end gap-2">
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          aria-expanded={pickerOpen}
          aria-label={t("messages.quickReplies")}
          title={t("messages.quickReplies")}
          className="mb-0.5 rounded-full p-2.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-navy-800"
        >
          <ChatCircleText aria-hidden className="size-5" />
        </button>
        <label className="flex-1">
          <span className="sr-only">{t("messages.composer")}</span>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={t("messages.composer")}
            aria-describedby={counterId}
            aria-invalid={tooLong || undefined}
            enterKeyHint="send"
            className="field-sizing-content max-h-40 min-h-10 w-full resize-none rounded-2xl border border-slate-200 bg-slate-50 px-4 py-2 dark:border-navy-700 dark:bg-navy-950"
          />
        </label>
        <button
          type="submit"
          disabled={!canSend}
          aria-label={t("messages.send")}
          className="mb-0.5 rounded-full bg-brand-blue p-2.5 text-white disabled:opacity-40"
        >
          <PaperPlaneRight aria-hidden weight="fill" className="size-5 rtl:-scale-x-100" />
        </button>
      </div>
      <p
        id={counterId}
        aria-live="polite"
        className={clsx("px-3 pt-1 text-end text-xs", tooLong ? "text-red-600" : "text-slate-400")}
      >
        {tooLong
          ? t("messages.tooLong", { max: SMS_BODY_MAX })
          : draft
            ? t("messages.counter", {
                characters: length.characters,
                max: SMS_BODY_MAX,
                segments: length.segments,
              })
            : " "}
      </p>
    </form>
  );
}
