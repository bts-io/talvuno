import {
  Archive,
  DotsThreeVertical,
  EnvelopeSimple,
  EnvelopeSimpleOpen,
  PushPin,
  PushPinSlash,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import type { ConversationListItem } from "../../contracts/messages";
import { type ThreadFlag, threadFlagChoices, useThreadFlag } from "../lib/messages";
import { RowMenu, type RowMenuItem } from "./row-menu";

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
  const items: RowMenuItem[] = menuChoices(c).map((choice) => ({
    key: choice,
    label: t(LABELS[choice]),
    icon: ICONS[choice],
    onSelect: () => flag.mutate({ id: c.id, flag: choice }),
  }));
  return (
    <RowMenu
      label={t("messages.actions.more")}
      items={items}
      open={open}
      onOpenChange={setOpen}
      className="absolute end-1 top-1"
      buttonClassName="rounded-full p-1.5 text-slate-400 hover:bg-slate-200 dark:hover:bg-navy-700"
      menuClassName="w-48"
    />
  );
}
