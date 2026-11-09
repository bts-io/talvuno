import { pickLocale } from "../../shared/i18n";

export type Theme = "light" | "dark" | "system";
export type Prefs = { locale: string; theme: Theme };

function readCookie(cookie: string, name: string): string | undefined {
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]!) : undefined;
}
const asTheme = (v: string | undefined | null): Theme => (v === "light" || v === "dark" ? v : "system");

/** Works on both sides: the server reads the request cookies (installed by src/server.ts), the browser its own. */
export function readPrefs(): Prefs {
  if (typeof window === "undefined") {
    const s = (
      globalThis as typeof globalThis & {
        __requestScope?: () => { cookie: string; acceptLanguage?: string } | undefined;
      }
    ).__requestScope?.();
    const cookie = s?.cookie ?? "";
    return {
      locale: pickLocale(readCookie(cookie, "locale"), s?.acceptLanguage),
      theme: asTheme(readCookie(cookie, "theme")),
    };
  }
  return {
    locale: pickLocale(readCookie(document.cookie, "locale"), navigator.language),
    theme: asTheme(readCookie(document.cookie, "theme")),
  };
}

export function writePref(name: "locale" | "theme", value: string) {
  try {
    // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is not available in every browser we support
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    // Cookies blocked: the choice lasts for this page only.
  }
}

const mq = () =>
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

export const resolvedTheme = (theme: Theme): "light" | "dark" =>
  theme === "system" ? (mq()?.matches ? "dark" : "light") : theme;

/** Paints `theme` on <html> and remembers it. */
export function applyTheme(theme: Theme) {
  writePref("theme", theme);
  const dark = resolvedTheme(theme) === "dark";
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}
