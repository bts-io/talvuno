import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { announceIncoming } from "../lib/incoming-state";
import { announceCallFailure, backoffDelay, keysForEvent, parseLiveFrame } from "../lib/live";

export type LiveState = "connecting" | "open" | "closed";

/**
 * Holds the owner's live socket (GET /api/live) while the app is mounted and signed in. Each event
 * invalidates the TanStack Query keys it touches. On every reconnect all queries are invalidated, because
 * events sent while the socket was down are lost. Reconnects with backoff, and at once when the tab becomes
 * visible again or the network comes back.
 */
export function useLive(enabled = true): LiveState {
  const qc = useQueryClient();
  const [state, setState] = useState<LiveState>("connecting");

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    let ws: WebSocket | null = null;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    let everOpened = false;

    const connect = () => {
      clearTimeout(timer);
      if (stopped || ws) return;
      setState("connecting");
      const url = new URL("/api/live", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url);
      ws = socket;
      socket.onopen = () => {
        attempt = 0;
        setState("open");
        if (everOpened) void qc.invalidateQueries();
        everOpened = true;
        // Keeps proxies from closing an idle socket; the hub answers without waking from hibernation logic.
        ping = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send("ping"), 30_000);
      };
      socket.onmessage = (e) => {
        const event = parseLiveFrame(e.data);
        if (!event) return;
        announceCallFailure(event);
        announceIncoming(event);
        for (const queryKey of keysForEvent(event)) void qc.invalidateQueries({ queryKey });
      };
      socket.onclose = () => {
        clearInterval(ping);
        ws = null;
        if (stopped) return;
        setState("closed");
        timer = setTimeout(connect, backoffDelay(attempt++));
      };
    };

    const wake = () => {
      if (document.visibilityState === "visible" && !ws) {
        attempt = 0;
        connect();
      }
    };
    connect();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(ping);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      ws?.close(1000, "unmount");
    };
  }, [enabled, qc]);

  return state;
}
