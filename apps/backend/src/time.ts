// 日時の表し方。会話の日時はJST（+09:00）のISO 8601で持つ（imple 7節）。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 例：2026-11-14T10:02:11.123+09:00 */
export function toJstIso(date: Date): string {
  return `${new Date(date.getTime() + JST_OFFSET_MS).toISOString().slice(0, -1)}+09:00`;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
