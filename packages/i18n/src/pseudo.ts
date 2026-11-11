const PLACEHOLDER = /\{\w+\}/g;
const SCHEMA_KEY = "$schema";

/** 1つの文言を疑似ロケールに変換する。 */
export function pseudoText(text: string): string {
  const visible = text.replace(PLACEHOLDER, "").length;
  const pad = "～".repeat(Math.max(1, Math.round(visible * 0.4)));
  return `［${text}${pad}］`;
}

/** 辞書全体を疑似ロケールに変換する（$schemaはそのまま残す）。 */
export function pseudoMessages(source: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [key, key === SCHEMA_KEY ? value : pseudoText(value)]),
  );
}
