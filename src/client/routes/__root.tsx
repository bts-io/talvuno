import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { dirFor } from "../../shared/i18n";
import { NotFoundPage } from "../components/error-pages";
import { UpdateToast } from "../components/update-toast";
import { registerServiceWorker } from "../lib/sw";
import type { RouterContext } from "../router";
import appCss from "../styles.css?url";

/* Paints the "system" theme before React runs; explicit light or dark is already on <html> from the cookie. */
const themeScript = `(function(){try{var m=document.cookie.match(/(?:^|; )theme=([^;]*)/);var t=m?m[1]:"system";var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);document.documentElement.style.colorScheme=d?"dark":"light"}catch(e){}})();`;

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content:
          "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content",
      },
      { name: "theme-color", content: "#01092a" },
      { name: "color-scheme", content: "light dark" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { title: "Talvuno" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico", sizes: "48x48" },
      { rel: "icon", href: "/icons/icon-192.png", type: "image/png", sizes: "192x192" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "manifest", href: "/manifest.webmanifest" },
    ],
    scripts: [{ children: themeScript }],
  }),
  component: RootComponent,
  notFoundComponent: NotFoundPage,
});

function RootComponent() {
  useEffect(() => {
    void registerServiceWorker();
  }, []);
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  const { prefs } = Route.useRouteContext();
  const dark = prefs.theme === "dark";
  return (
    <html
      lang={prefs.locale}
      dir={dirFor(prefs.locale)}
      className={dark ? "dark" : undefined}
      suppressHydrationWarning
    >
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <UpdateToast />
        <Scripts />
      </body>
    </html>
  );
}
