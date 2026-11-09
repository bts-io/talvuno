/**
 * Languages Talvuno ships. Only English exists today. The `dir` field and the plumbing around it (html dir,
 * logical CSS properties) are there so a right-to-left language can be added with a locale file alone.
 */
export const SUPPORTED_LOCALES = [{ code: "en", name: "English", dir: "ltr" }] as const satisfies readonly {
  code: string;
  name: string;
  dir: "ltr" | "rtl";
}[];

export type LocaleCode = (typeof SUPPORTED_LOCALES)[number]["code"];
export const DEFAULT_LOCALE: LocaleCode = "en";

/** Text direction for a locale. Unknown codes and every RTL script we do not ship fall back to the list. */
export function dirFor(code: string): "ltr" | "rtl" {
  const known = (SUPPORTED_LOCALES as readonly { code: string; dir: "ltr" | "rtl" }[]).find(
    (l) => l.code === code,
  );
  if (known) return known.dir;
  return ["ar", "fa", "he", "ur", "ps", "sd", "ug", "yi", "dv"].includes(code.slice(0, 2)) ? "rtl" : "ltr";
}

/** The best supported locale for a cookie value and an Accept-Language header. */
export function pickLocale(candidate: string | undefined, acceptLanguage?: string): LocaleCode {
  const codes = SUPPORTED_LOCALES.map((l) => l.code as string);
  if (candidate && codes.includes(candidate)) return candidate as LocaleCode;
  for (const part of (acceptLanguage ?? "").split(",")) {
    const code = part.trim().slice(0, 2).toLowerCase();
    if (codes.includes(code)) return code as LocaleCode;
  }
  return DEFAULT_LOCALE;
}
