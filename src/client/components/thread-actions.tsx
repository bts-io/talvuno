import {
  Archive,
  DotsThreeVertical,
  EnvelopeSimple,
  EnvelopeSimpleOpen,
  PushPin,
  PushPinSlash,
} from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { ConversationListItem } from "../../contracts/messages";
import { type ThreadFlag, threadFlagChoices, useThreadFlag } from "../lib/messages";

type Thread = Pick<ConversationListItem, "id" | "pinnedAt" | "archivedAt" | "unreadCount" | "markedUnread">;

const ICONS: Record<ThreadFlag, typeof PushPin> = {
  pin: PushPin,
  unpin: PushPinSlash,
  archive: Archive,
  unarchive: Archive,
  unread: EnvelopeSimple,
  read: EnvelopeSimpleOpen,
};

const LABELS: Record<ThreadFlag, string> = {
  pin: "messages.actions.pin",
  unpin: "messages.actions.unpin",
  archive: "messages.actions.archive",
  unarchive: "messages.actions.unarchive",
  unread: "messages.actions.markUnread",
  read: "messages.actions.markRead",
};

/** The pin, archive and unread choices for one thread, in menu order. */
function menuChoices(c: Thread) {
  const choices = threadFlagChoices(c);
  return [choices.pin, choices.archive, choices.unread];
}

/** Icon buttons for the thread header. `after` runs once the change was accepted (for example, leave the thread). */
export function ThreadHeaderActions({ c, onDone }: { c: Thread; onDone?: (flag: ThreadFlag) => void }) {
  const { t } = useTranslation();
  const flag = useThreadFlag();
  return (
    <div className="ms-auto flex shrink-0 items-center">
      {menuChoices(c).map((choice) => {
        const Icon = ICONS[choice];
        return (
          <button
            key={choice}
            type="button"
            disabled={flag.isPending}
            onClick={() => flag.mutate({ id: c.id, flag: choice }, { onSuccess: () => onDone?.(choice) })}
            aria-label={t(LABELS[choice])}
            title={t(LABELS[choice])}
            className="rounded-full p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-navy-800"
          >
            <Icon aria-hidden className="size-5" />
          </button>
        );
      })}
    </div>
  );
}

/** The "more" menu on a thread row. */
export function ThreadRowMenu({
  c,
  open,
  setOpen,
}: {
  c: Thread;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const flag = useThreadFlag();
  const box = useRef<HTMLDivElement>(null);

  // Close on a tap elsewhere or Escape.
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open, setOpen]);

  return (
    <div ref={box} className="absolute end-1 top-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("messages.actions.more")}
        title={t("messages.actions.more")}
        className="rounded-full p-1.5 text-slate-400 hover:bg-slate-200 dark:hover:bg-navy-700"
      >
        <DotsThreeVertical aria-hidden weight="bold" className="size-5" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute end-0 z-10 mt-1 w-48 rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-navy-700 dark:bg-navy-900"
        >
          {menuChoices(c).map((choice) => {
            const Icon = ICONS[choice];
            return (
              <div key={choice} role="none">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    flag.mutate({ id: c.id, flag: choice });
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-slate-100 dark:hover:bg-navy-800"
                >
                  <Icon aria-hidden className="size-4" />
                  {t(LABELS[choice])}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** Long-press (about half a second) on touch opens the row menu; the tap that follows must not open the thread. */
export function useLongPress(onLongPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fired = useRef(false);
  const clear = () => clearTimeout(timer.current);
  return {
    onTouchStart: () => {
      fired.current = false;
      timer.current = setTimeout(() => {
        fired.current = true;
        onLongPress();
      }, 500);
    },
    onTouchEnd: clear,
    onTouchMove: clear,
    onTouchCancel: clear,
    onContextMenu: (e: { preventDefault: () => void }) => {
      if (fired.current) e.preventDefault();
    },
    onClickCapture: (e: { preventDefault: () => void; stopPropagation: () => void }) => {
      if (fired.current) {
        fired.current = false;
        e.preventDefault();
        e.stopPropagation();
      }
    },
  };
}
