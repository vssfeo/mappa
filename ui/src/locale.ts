/**
 * Locale shared by non-React modules (formatters, importers, error messages).
 * React components subscribe to the store instead; this tiny module avoids a
 * dependency cycle between the store and the translators.
 */

import { CATALOGS, isLocale, type Locale } from './locales/index.ts'

export { LOCALES, LOCALE_NAMES, isLocale } from './locales/index.ts'
export type { Locale } from './locales/index.ts'

let activeLocale: Locale = 'ru'

export type MessageParams = Record<string, string | number>

/** Replaces `{name}` placeholders after the template has been translated. */
const formatMessage = (template: string, params?: MessageParams) =>
  params
    ? template.replace(/\{(\w+)\}/g, (match, key: string) =>
        key in params ? String(params[key]) : match,
      )
    : template

export const setActiveLocale = (locale: Locale) => {
  activeLocale = locale
}

export const getLocale = (): Locale => activeLocale

/** Resolves an inline RU/EN pair through the additional catalogs. */
export const translateText = (
  locale: Locale,
  ru: string,
  en: string,
  params?: MessageParams,
): string => {
  const template =
    locale === 'ru' ? ru : locale === 'en' ? en : (CATALOGS[locale][en] ?? en)
  return formatMessage(template, params)
}

/** Inline translation for strings produced outside React. */
export const tr = (ru: string, en: string, params?: MessageParams): string =>
  translateText(activeLocale, ru, en, params)

export const isSupportedLocale = isLocale
