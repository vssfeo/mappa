/**
 * Additional interface catalogs. Keys are the English source strings used by
 * `tx(ru, en)` and by the static key table in `i18n.ts`. Missing entries fall
 * back to English, so a partly translated locale never renders blank text.
 */

import { de } from './de.ts'
import { es } from './es.ts'
import { fr } from './fr.ts'

export const LOCALES = ['ru', 'en', 'de', 'fr', 'es'] as const

export type Locale = (typeof LOCALES)[number]

export const LOCALE_NAMES: Record<Locale, string> = {
  ru: 'Русский',
  en: 'English',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
}

export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (LOCALES as readonly string[]).includes(value)

export type Catalog = Record<string, string>

export const CATALOGS: Record<Exclude<Locale, 'ru' | 'en'>, Catalog> = {
  de,
  fr,
  es,
}
