/**
 * Run before signing out, while the session still works: drops this browser's push subscription (here and
 * on the server) and every saved draft, so the next person on a shared device gets neither notices nor text.
 * Each step is best effort and never blocks signing out.
 */
export async function cleanupBeforeSignOut(steps: {
  unsubscribe: () => Promise<void>;
  clearDrafts: () => void;
}): Promise<void> {
  try {
    // serviceWorker.ready never settles without a worker, so do not wait on it for long.
    await Promise.race([steps.unsubscribe(), new Promise<void>((resolve) => setTimeout(resolve, 4000))]);
  } catch {
    // Offline, no service worker or no subscription: nothing more to do.
  }
  try {
    steps.clearDrafts();
  } catch {
    // Storage blocked.
  }
}
