// SearchUsage：今月の検索回数（imple 7節の`data/usage.json`）。
// 形は`{ month: "YYYY-MM", searchCount: number }`。月はJSTで、月が変われば0から数える。
// 数えるたびに一時ファイルに書いてから置き換える（書き込みは順に行う）。書けなくても検索は止めない。

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { toJstIso } from "../time.ts";
import type { MonthCount } from "./engine.ts";

export type SearchUsageOptions = {
  /** 保存先（nullならメモリだけで数える） */
  path: string | null;
  now?: () => Date;
  log?: (line: string) => void;
};

/** 日時（JST）の月（YYYY-MM）。 */
export const jstMonth = (date: Date) => toJstIso(date).slice(0, 7);

const MONTH_PATTERN = /^\d{4}-\d{2}$/;

export class SearchUsage {
  private month: string;
  private count = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(private readonly options: SearchUsageOptions) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
    this.month = jstMonth(this.now());
  }

  /** 保存したファイルを読む。ないか崩れていれば0から数える。 */
  async load(): Promise<void> {
    if (this.options.path === null) return;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.options.path, "utf8"));
    } catch {
      return; // まだない（初回）か、読めない
    }
    const v = raw as { month?: unknown; searchCount?: unknown };
    if (
      typeof v?.month === "string" &&
      MONTH_PATTERN.test(v.month) &&
      Number.isInteger(v.searchCount) &&
      (v.searchCount as number) >= 0
    ) {
      this.month = v.month;
      this.count = v.searchCount as number;
    } else {
      this.log(`warning: ${this.options.path} is malformed; counting from 0`);
    }
  }

  /** 今月の回数（保存した月が過ぎていれば0）。 */
  current(): MonthCount {
    const month = jstMonth(this.now());
    return { month, count: month === this.month ? this.count : 0 };
  }

  /** 1回数えて保存する。 */
  increment(): Promise<void> {
    const { month, count } = this.current();
    this.month = month;
    this.count = count + 1;
    return this.save();
  }

  private save(): Promise<void> {
    const path = this.options.path;
    if (path === null) return Promise.resolve();
    const text = `${JSON.stringify({ month: this.month, searchCount: this.count }, null, 2)}\n`;
    this.queue = this.queue.then(async () => {
      try {
        await mkdir(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        await writeFile(tmp, text, "utf8");
        await rename(tmp, path);
      } catch (e) {
        this.log(`usage write failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    return this.queue;
  }
}
