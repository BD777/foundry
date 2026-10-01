import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { resources } from "./resources";

/**
 * Interface copy for the whole web app. Every visible string lives in
 * ./locales/<locale>/<namespace>.ts and reaches components through `t`
 * (`useTranslation` in components, `i18n.t` in plain helpers).
 */

export const locales = ["en", "zh-CN"] as const;
export type Locale = (typeof locales)[number];
/** A person's choice: one of the locales, or "" to follow the browser. */
export type LocalePreference = Locale | "";

const preferenceKey = "foundry.locale";

function isLocale(value: string | undefined | null): value is Locale {
  return locales.includes(value as Locale);
}

/** The browser's language, narrowed to one the interface is translated into. */
export function browserLocale(
  languages: readonly string[] = typeof navigator === "undefined"
    ? []
    : navigator.languages,
): Locale {
  for (const language of languages) {
    if (/^zh\b/i.test(language)) return "zh-CN";
    if (/^en\b/i.test(language)) return "en";
  }
  return "en";
}

export function resolveLocale(preference?: string | null): Locale {
  return isLocale(preference) ? preference : browserLocale();
}

/** The preference remembered in this browser, used before sign-in. */
export function storedLocalePreference(): LocalePreference {
  try {
    const stored = window.localStorage.getItem(preferenceKey);
    return isLocale(stored) ? stored : "";
  } catch {
    return "";
  }
}

export const i18n = i18next.createInstance();

void i18n.use(initReactI18next).init({
  resources,
  lng: resolveLocale(
    typeof window === "undefined" ? undefined : storedLocalePreference(),
  ),
  fallbackLng: "en",
  supportedLngs: [...locales],
  defaultNS: "common",
  ns: Object.keys(resources.en),
  initAsync: false,
  interpolation: { escapeValue: false },
});

/**
 * Show the interface in the person's language: their account's choice when
 * signed in, else what this browser remembers, else the browser's language.
 */
export function applyLocalePreference(
  preference: LocalePreference | undefined,
): Promise<unknown> {
  try {
    if (preference) window.localStorage.setItem(preferenceKey, preference);
    else if (preference === "") window.localStorage.removeItem(preferenceKey);
  } catch {
    // The account keeps the choice; this browser just will not remember it.
  }
  const locale = resolveLocale(preference || storedLocalePreference());
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  return i18n.language === locale
    ? Promise.resolve()
    : i18n.changeLanguage(locale);
}
