import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { I18nextProvider } from "react-i18next";
import { ErrorPage, NotFoundPage } from "./components/error-pages";
import { ApiError } from "./lib/api";
import { applyDir, createI18n } from "./lib/i18n";
import { type Prefs, readPrefs } from "./lib/prefs";
import { routeTree } from "./routeTree.gen";

export type RouterContext = { queryClient: QueryClient; prefs: Prefs };

/** One router, QueryClient and i18n instance per request on the server, one per tab in the browser. */
export function getRouter() {
  const prefs = readPrefs();
  const i18n = createI18n(prefs.locale);
  if (typeof window !== "undefined") i18n.on("languageChanged", applyDir);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
        refetchOnWindowFocus: false,
      },
    },
  });
  // The server mints the nonce per request (src/server.ts). The browser reads it back from the csp-nonce meta tag.
  const nonce = (
    globalThis as typeof globalThis & { __requestScope?: () => { nonce?: string } | undefined }
  ).__requestScope?.()?.nonce;
  const router = createRouter({
    ssr: nonce ? { nonce } : undefined,
    routeTree,
    context: { queryClient, prefs },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    defaultErrorComponent: ErrorPage,
    defaultNotFoundComponent: NotFoundPage,
    // biome-ignore lint/correctness/noComponentHookFactories: created once per router, which owns its own i18n instance
    Wrap: ({ children }) => <I18nextProvider i18n={i18n}>{children}</I18nextProvider>,
  });
  setupRouterSsrQueryIntegration({ router, queryClient });
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
