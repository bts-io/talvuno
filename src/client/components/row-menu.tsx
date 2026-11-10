import { DotsThreeVertical } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";

export type RowMenuItem = { key: string; label: string; onSelect: () => void; danger?: boolean };

const LONG_PRESS_MS = 500;

/**
 * Long-press handlers for a list row: after a half second the row's menu opens, and the click that ends the
 * press is swallowed so it does not also trigger the row's own tap.
 */
export function useLongPress(onLongPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    onPointerDown: () => {
      fired.current = false;
      cancel();
      timer.current = setTimeout(() => {
        fired.current = true;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onPointerMove: cancel,
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
    onClickCapture: (e: { stopPropagation: () => void }) => {
      if (!fired.current) return;
      fired.current = false;
      e.stopPropagation();
    },
  };
}

/** A "⋮" button and the small menu it opens. Closes on a pick, an outside tap or Escape. */
export function RowMenu({
  label,
  items,
  open,
  onOpenChange,
}: {
  label: string;
  items: RowMenuItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (!root.current?.contains(e.target as Node)) onOpenChange(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onOpenChange(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={root} className="relative shrink-0">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-navy-800"
      >
        <DotsThreeVertical aria-hidden className="size-5" weight="bold" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute end-0 top-full z-10 mt-1 min-w-40 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-navy-700 dark:bg-navy-900"
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              onClick={() => {
                onOpenChange(false);
                item.onSelect();
              }}
              className={`block w-full px-4 py-2 text-start text-sm hover:bg-slate-100 dark:hover:bg-navy-800 ${
                item.danger ? "text-red-600 dark:text-red-400" : ""
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
