// WebSearcher：検索語→結果の抜粋（imple 3節・4節）。
// 実装はTavilyWebSearcher（Tavily Search APIをRESTで直接呼ぶ）とStubWebSearcher（決まった抜粋）。
// 失敗（無料枠の使い切り・時間切れ・通信など）は理由つきの例外で知らせ、
// ConversationSessionが結果なしで2回目の問い合わせをする。
// 今月の回数はSearchUsage（data/usage.json。月はJST）で数える。

export type SearchResult = { title: string; url: string; snippet: string };
export type SearchOutcome = { results: SearchResult[]; ms: number };

/**
 * 失敗の理由。
 * quota：無料枠・上限の使い切り（Tavilyの432・433）、rate_limited：短時間の要求の多さ（429・434）、
 * unauthorized：APIキーが無効（401）、no_api_key：APIキーが設定されていない、
 * timeout：時間切れ、network：つながらない、http：そのほかのHTTPのエラー、bad_response：応答の形が崩れている、
 * stub：スタブで再現した失敗
 */
export const SEARCH_FAILURES = [
  "quota",
  "rate_limited",
  "unauthorized",
  "no_api_key",
  "timeout",
  "network",
  "http",
  "bad_response",
  "stub",
] as const;
export type SearchFailure = (typeof SEARCH_FAILURES)[number];

/** 検索できなかったときの例外。msは失敗までにかかった時間。 */
export class SearchError extends Error {
  constructor(
    readonly reason: SearchFailure,
    message: string,
    readonly ms: number,
  ) {
    super(message);
  }
}

export type MonthCount = { month: string; count: number };

export interface WebSearcher {
  /** 結果の抜粋を返す。失敗はthrow（SearchError） */
  search(query: string): Promise<SearchOutcome>;
  /** 今月（JST）の検索回数 */
  monthCount(): MonthCount;
}
