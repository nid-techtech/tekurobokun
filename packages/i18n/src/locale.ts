import {
  baseLocale,
  getLocale,
  isLocale,
  type Locale,
  locales,
  setLocale,
} from "./paraglide/runtime.js";

/** 疑似ロケール。開発時だけ有効にし、公開版の言語には含めない。 */
export const PSEUDO_LOCALE = "ja-x-pseudo" satisfies Locale;

/** URLで疑似ロケールを指定するときの短い名前（`?locale=pseudo`）。 */
const QUERY_ALIASES: Record<string, Locale> = { pseudo: PSEUDO_LOCALE };

/** 公開版で使える言語（切り替えUIは、この数が2以上になったときだけ出す）。 */
export const publicLocales: readonly Locale[] = locales.filter((l) => l !== PSEUDO_LOCALE);

export function isAllowedLocale(value: unknown, dev: boolean): value is Locale {
  return isLocale(value) && (dev || value !== PSEUDO_LOCALE);
}

/**
 * ロケールを決める。優先順は、URLの`?locale=`、保持しているロケール
 * （Paraglideの判定：localStorage → ブラウザの言語 → 原文の言語）、原文の言語。
 * 使えないロケールは飛ばし、最後は原文の言語（ja）にフォールバックする。
 */
export function resolveLocale(input: { query: string | null; current: string; dev: boolean }): Locale {
  const fromQuery = input.query === null ? null : (QUERY_ALIASES[input.query] ?? input.query);
  if (isAllowedLocale(fromQuery, input.dev)) return fromQuery;
  if (isAllowedLocale(input.current, input.dev)) return input.current;
  return baseLocale;
}

/** `Intl`に渡すロケール。疑似ロケールは原文の言語で整形する。 */
export function intlLocale(locale: Locale = getLocale()): string {
  return locale === PSEUDO_LOCALE ? baseLocale : locale;
}

const listeners = new Set<(locale: Locale) => void>();

/** ロケールが変わったときに再描画する処理を登録する。戻り値で登録を外す。 */
export function onLocaleChange(listener: (locale: Locale) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function applyDocument(locale: Locale): void {
  // 書体はlocale.cssが:lang()で切り替える。
  document.documentElement.lang = locale;
}

/** ロケールを切り替える。ページは再読み込みせず、登録した処理で再描画する。 */
export function changeLocale(locale: Locale): void {
  void setLocale(locale, { reload: false });
  applyDocument(locale);
  for (const listener of listeners) listener(locale);
}

/** 起動時に1回呼ぶ。ロケールを決めて保持し、`<html lang>`に反映する。 */
export function initLocale(options: { dev: boolean }): Locale {
  const query = new URLSearchParams(window.location.search).get("locale");
  const locale = resolveLocale({ query, current: getLocale(), dev: options.dev });
  if (locale !== getLocale()) void setLocale(locale, { reload: false });
  applyDocument(locale);
  return locale;
}
