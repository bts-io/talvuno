import i18next, { type i18n as I18n } from "i18next";
import { initReactI18next } from "react-i18next";
import { dirFor, SUPPORTED_LOCALES } from "../../shared/i18n";
import en from "../../shared/locales/en.json";

const resources = { en: { translation: en } };

/** A fresh instance per router: on the server every request renders in its own language without shared state. */
export function createI18n(lng: string): I18n {
  const instance = i18next.createInstance();
  instance.use(initReactI18next).init({
    resources,
    lng,
    fallbackLng: "en",
    supportedLngs: SUPPORTED_LOCALES.map((l) => l.code),
    interpolation: { escapeValue: false },
    initAsync: false,
  });
  return instance;
}

/** Keeps <html dir lang> in step with the active language. */
export function applyDir(lng: string) {
  if (typeof document === "undefined") return;
  document.documentElement.dir = dirFor(lng);
  document.documentElement.lang = lng;
}
