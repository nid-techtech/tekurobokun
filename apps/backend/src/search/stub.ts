// StubWebSearcher：Tavilyなしの開発用（imple 10節）。
// どの検索語でも決まった抜粋を返す。検索語に決まった語が入ると、失敗（エラー・無料枠の使い切り）を再現する。
// 抜粋と語はstub_results.json（日本語の文字をコードに直書きしないため）。
// 回数は本物と同じく数える（月ごとに数えられることをスタブで確かめるため）。

import { sleep } from "../time.ts";
import {
  type MonthCount,
  SearchError,
  type SearchOutcome,
  type SearchResult,
  type WebSearcher,
} from "./engine.ts";
import stubData from "./stub_results.json" with { type: "json" };
import type { SearchUsage } from "./usage.ts";

export type StubSearchData = {
  delayMs: number;
  results: SearchResult[];
  /** 検索語にこの語が入ると、検索のエラーを再現する */
  failTrigger: string;
  /** 検索語にこの語が入ると、無料枠の使い切りを再現する */
  quotaTrigger: string;
};

export const DEFAULT_STUB_SEARCH_DATA = stubData as StubSearchData;

export type StubSearchOptions = {
  usage: SearchUsage;
  data?: StubSearchData;
  maxResults?: number;
};

export class StubWebSearcher implements WebSearcher {
  private readonly data: StubSearchData;

  constructor(private readonly options: StubSearchOptions) {
    this.data = options.data ?? DEFAULT_STUB_SEARCH_DATA;
  }

  async search(query: string): Promise<SearchOutcome> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    await sleep(this.data.delayMs);
    if (query.includes(this.data.quotaTrigger)) {
      throw new SearchError("quota", "stub: simulated quota exceeded", elapsed());
    }
    if (query.includes(this.data.failTrigger)) {
      void this.options.usage.increment();
      throw new SearchError("stub", "stub: simulated search failure", elapsed());
    }
    void this.options.usage.increment();
    const max = this.options.maxResults ?? this.data.results.length;
    return { results: this.data.results.slice(0, max).map((r) => ({ ...r })), ms: elapsed() };
  }

  monthCount(): MonthCount {
    return this.options.usage.current();
  }
}
