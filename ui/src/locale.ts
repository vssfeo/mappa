/**
 * Locale shared by non-React modules (formatters, importers, error messages).
 * React components subscribe to the store instead; this tiny module avoids a
 * dependency cycle between the store and the translators.
 */

export type Locale = 'ru' | 'en'

let activeLocale: Locale = 'ru'

export const setActiveLocale = (locale: Locale) => {
  activeLocale = locale
}

export const getLocale = (): Locale => activeLocale

/** Inline translation for strings produced outside React. */
export const tr = (ru: string, en: string): string =>
  activeLocale === 'en' ? en : ru
