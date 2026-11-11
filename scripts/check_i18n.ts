// i18nの検査：ロケール間のキーの過不足とプレースホルダの一致、疑似ロケールの同期、
// UI内の日本語の直書き、未使用キー（警告）。存在しないキーの参照はtscが検出する。

import { pseudoMessages } from "../packages/i18n/src/pseudo.ts";
import { findInSource, formatFinding, listFiles, readText } from "./source_scan.ts";

const MESSAGES_DIR = "packages/i18n/messages";
const SOURCE_LOCALE = "ja";
const PSEUDO_LOCALE = "ja-x-pseudo";
const SCHEMA_KEY = "$schema";

/** ひらがな・カタカナ・漢字・全角の記号。 */
export const JAPANESE = /[　-ヿ㐀-鿿！-｠]+/;

type Dict = Record<string, string>;

export const placeholders = (text: string) =>
  [...text.matchAll(/\{(\w+)\}/g)]
    .map((x) => x[1])
    .sort()
    .join(",");

/** 原文の辞書と比べた、キーの過不足とプレースホルダの不一致。 */
export function compareDicts(locale: string, source: Dict, target: Dict): string[] {
  const problems: string[] = [];
  for (const [key, sourceText] of Object.entries(source)) {
    if (key === SCHEMA_KEY) continue;
    const text = target[key];
    if (text === undefined) problems.push(`${locale}: キーがない ${key}`);
    else if (placeholders(text) !== placeholders(sourceText)) {
      problems.push(`${locale}: プレースホルダが原文と違う ${key}`);
    }
  }
  for (const key of Object.keys(target)) {
    if (key !== SCHEMA_KEY && !(key in source)) problems.push(`${locale}: 原文にないキー ${key}`);
  }
  return problems;
}

/** ソースから参照されているキー（m["a.b"]）。 */
export function usedKeys(src: string): string[] {
  return [...src.matchAll(/\bm\[\s*["'`]([\w.]+)["'`]\s*\]/g)].map((x) => x[1] ?? "");
}

export async function checkI18n(): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const source: Dict = JSON.parse(await readText(`${MESSAGES_DIR}/${SOURCE_LOCALE}.json`));
  for (const file of listFiles(`${MESSAGES_DIR}/*.json`)) {
    const locale = file.slice(MESSAGES_DIR.length + 1, -".json".length);
    if (locale === SOURCE_LOCALE) continue;
    errors.push(...compareDicts(locale, source, JSON.parse(await readText(file))));
  }

  const pseudo: Dict = JSON.parse(await readText(`${MESSAGES_DIR}/${PSEUDO_LOCALE}.json`));
  if (JSON.stringify(pseudo) !== JSON.stringify(pseudoMessages(source))) {
    errors.push(
      `${PSEUDO_LOCALE}.json が ${SOURCE_LOCALE}.json と同期していない（packages/i18nで bun run compile を実行する）`,
    );
  }

  const used = new Set<string>();
  for (const file of listFiles("apps/*/src/**/*.{ts,html}", "apps/*/index.html")) {
    const src = await readText(file);
    for (const f of findInSource(file, src, JAPANESE)) {
      errors.push(`日本語の直書き ${formatFinding(f)}`);
    }
    for (const key of usedKeys(src)) used.add(key);
  }
  const unused = Object.keys(source).filter((key) => key !== SCHEMA_KEY && !used.has(key));
  if (unused.length > 0) warnings.push(`未使用キー ${unused.length}件: ${unused.join(", ")}`);

  return { errors, warnings };
}
