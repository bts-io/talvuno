import { useCallback, useEffect, useRef, useState } from "react";

const PREFIX = "talvuno:draft:";

/** Draft keys are stored under one prefix so clearing them never touches other localStorage entries. */
export function draftStorageKey(key: string): string {
  return PREFIX + key;
}

type KeyValueStore = {
  readonly length?: number;
  key?(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function storage(): KeyValueStore | null {
  try {
    return (globalThis as { localStorage?: KeyValueStore }).localStorage ?? null;
  } catch {
    return null; // blocked by privacy settings
  }
}

export function readDraft(key: string): string {
  try {
    return storage()?.getItem(draftStorageKey(key)) ?? "";
  } catch {
    return "";
  }
}

/** An empty draft removes the entry, so abandoned conversations leave nothing behind. */
export function writeDraft(key: string, value: string): void {
  try {
    const s = storage();
    if (!s) return;
    if (value === "") s.removeItem(draftStorageKey(key));
    else s.setItem(draftStorageKey(key), value);
  } catch {
    // Storage full or blocked: the draft just is not kept.
  }
}

/** Removes every saved draft on this device (sign out). Other localStorage entries are left alone. */
export function clearAllDrafts(store: KeyValueStore | null = storage()): void {
  try {
    if (!store?.key || store.length === undefined) return;
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k?.startsWith(PREFIX)) keys.push(k);
    }
    for (const k of keys) store.removeItem(k);
  } catch {
    // Storage blocked: nothing was saved.
  }
}

export function clearDraft(key: string): void {
  writeDraft(key, "");
}

/**
 * A message draft kept on this device, one per `key` (use the conversation id, or the recipient number for a
 * new conversation). Returns `[draft, setDraft, clear]`. Server rendering and the first client render both
 * start empty, and the saved text appears right after mount, so hydration never mismatches. Writes are
 * debounced a little so typing does not hit localStorage on every key.
 */
export function useDraft(key: string): [string, (value: string) => void, () => void] {
  const [value, setValue] = useState("");
  const keyRef = useRef(key);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<{ key: string; value: string } | null>(null);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    if (pending.current) writeDraft(pending.current.key, pending.current.value);
    pending.current = null;
  }, []);

  // Leaving the conversation (or the page) must not lose what was typed in the last moments.
  useEffect(() => {
    keyRef.current = key;
    setValue(readDraft(key));
    return flush;
  }, [key, flush]);

  const set = useCallback(
    (next: string) => {
      setValue(next);
      pending.current = { key: keyRef.current, value: next };
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, 250);
    },
    [flush],
  );

  const clear = useCallback(() => {
    clearTimeout(timer.current);
    pending.current = null;
    setValue("");
    clearDraft(keyRef.current);
  }, []);

  return [value, set, clear];
}
