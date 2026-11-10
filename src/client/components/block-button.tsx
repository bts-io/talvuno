import { Prohibit } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { useBlockToggle } from "../hooks/use-routing";

/**
 * Blocks or unblocks one number or sender. Shown in Recents, the thread header and on a contact. Withheld
 * callers have no number to block, so nothing renders for them.
 */
export function BlockButton({
  address,
  className,
}: {
  address: string | null | undefined;
  className?: string;
}) {
  const { t } = useTranslation();
  const { blocked, toggle } = useBlockToggle(address);
  if (!address || ["anonymous", "restricted", "unavailable", "unknown"].includes(address.toLowerCase()))
    return null;
  const label = blocked ? t("routing.blocked.unblockNumber") : t("routing.blocked.blockNumber");
  return (
    <button
      type="button"
      aria-pressed={blocked}
      aria-label={label}
      title={label}
      disabled={toggle.isPending}
      onClick={() => toggle.mutate()}
      className={
        className ??
        "inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-navy-800"
      }
    >
      <Prohibit aria-hidden className={blocked ? "size-4 text-red-600" : "size-4"} />
      <span>{blocked ? t("routing.blocked.unblock") : t("routing.blocked.block")}</span>
    </button>
  );
}
