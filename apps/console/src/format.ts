// 画面に出す値の書式（imple 7節「画面の項目とデータの対応」）。

import { intlLocale, m } from "@tekurobokun/i18n";

/** プロンプト行の時刻（時:分:秒、24時間制）。 */
export function formatClock(at: string | Date): string {
  const date = typeof at === "string" ? new Date(at) : at;
  return new Intl.DateTimeFormat(intlLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

/** 考えた時間（例：12s708ms）。 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const number = new Intl.NumberFormat(intlLocale(), { useGrouping: false });
  return m["shell.duration"]({
    seconds: number.format(Math.floor(total / 1000)),
    millis: number.format(total % 1000),
  });
}

/** 文字の進捗バー（例：[██░░░░░░░░]）。fractionは0〜1。 */
export function textBar(fraction: number, cells = 10): string {
  const filled = Math.min(cells, Math.max(0, Math.round(fraction * cells)));
  return `[${"█".repeat(filled)}${"░".repeat(cells - filled)}]`;
}
