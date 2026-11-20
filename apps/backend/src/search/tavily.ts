// TavilyWebSearcher：Tavily Search APIをRESTで直接呼ぶ（依存を増やさないため、SDKは使わない）。
// APIの形は公式のリファレンス（docs.tavily.com、Search・Rate Limits・API Credits）で確かめた：
//   POST https://api.tavily.com/search、`Authorization: Bearer {APIキー}`、本文はJSON。
//   search_depth: "basic"は1回1クレジット。include_answer・include_raw_content・include_imagesは既定false。
//   応答は`results[]`（title・url・content・score）。エラーの本文は`{ detail: { error } }`。
//   401はAPIキーが無効、429は要求が多すぎる、432はキー・プランの上限超過、433は従量課金の上限超過、
//   434はFlexの容量超過。要求の項目に時間切れはないため、AbortSignalで打ち切る。
//
// 回数は、要求を送ったもののうち、受け付けずに断られた応答（401・429・432・433・434）を除いて数える
// （時間切れ・5xxは、クレジットを使った可能性があるため数える。無料枠に対して多めに数える側に倒す）。

import type { SearchConfig } from "../config.ts";
import {
  type MonthCount,
  SearchError,
  type SearchFailure,
  type SearchOutcome,
  type SearchResult,
  type WebSearcher,
} from "./engine.ts";
import type { SearchUsage } from "./usage.ts";

export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

/** 受け付けずに断られた（クレジットを使わない）とみなすステータスと、その理由。 */
const REJECTED: Record<number, SearchFailure> = {
  401: "unauthorized",
  429: "rate_limited",
  432: "quota",
  433: "quota",
  434: "rate_limited",
};

export type TavilyOptions = {
  config: Pick<SearchConfig, "apiKey" | "maxResults" | "timeoutMs">;
  usage: SearchUsage;
  /** 接続先（テストで差し替える） */
  url?: string;
};

export class TavilyWebSearcher implements WebSearcher {
  private readonly url: string;

  constructor(private readonly options: TavilyOptions) {
    this.url = options.url ?? TAVILY_SEARCH_URL;
  }

  /** 送る本文。 */
  requestBody(query: string): Record<string, unknown> {
    return {
      query,
      search_depth: "basic",
      max_results: this.options.config.maxResults,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    };
  }

  async search(query: string): Promise<SearchOutcome> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const { apiKey, timeoutMs } = this.options.config;
    if (apiKey === "") throw new SearchError("no_api_key", "search.apiKey is empty", 0);

    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(this.requestBody(query)),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = e instanceof Error && e.name === "TimeoutError";
      if (timedOut) void this.options.usage.increment();
      throw new SearchError(
        timedOut ? "timeout" : "network",
        `tavily request failed: ${e instanceof Error ? e.message : String(e)}`,
        elapsed(),
      );
    }

    const rejected = REJECTED[res.status];
    if (rejected) {
      throw new SearchError(
        rejected,
        `tavily responded ${res.status}: ${await errorText(res)}`,
        elapsed(),
      );
    }
    void this.options.usage.increment();
    if (!res.ok) {
      throw new SearchError(
        "http",
        `tavily responded ${res.status}: ${await errorText(res)}`,
        elapsed(),
      );
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      // 本文の読み込みの途中で時間切れになることもある。
      const timedOut = e instanceof Error && e.name === "TimeoutError";
      throw new SearchError(
        timedOut ? "timeout" : "bad_response",
        "tavily response is not JSON",
        elapsed(),
      );
    }
    const results = readResults(body, this.options.config.maxResults);
    if (results === null)
      throw new SearchError("bad_response", "tavily response has no results", elapsed());
    return { results, ms: elapsed() };
  }

  monthCount(): MonthCount {
    return this.options.usage.current();
  }
}

/** エラーの本文（`{ detail: { error } }`）の文。読めなければ空。 */
async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: { error?: unknown } };
    return typeof body?.detail?.error === "string" ? body.detail.error : "";
  } catch {
    return "";
  }
}

/** 応答の`results[]`を抜粋にする。形が崩れていればnull。崩れた項目は飛ばす。 */
export function readResults(body: unknown, max: number): SearchResult[] | null {
  if (typeof body !== "object" || body === null) return null;
  const items = (body as { results?: unknown }).results;
  if (!Array.isArray(items)) return null;
  const results: SearchResult[] = [];
  for (const item of items) {
    const v = item as { title?: unknown; url?: unknown; content?: unknown };
    if (typeof v?.url !== "string" || typeof v.content !== "string") continue;
    results.push({
      title: typeof v.title === "string" ? v.title.trim() : "",
      url: v.url,
      snippet: v.content.trim(),
    });
  }
  return results.slice(0, max);
}
