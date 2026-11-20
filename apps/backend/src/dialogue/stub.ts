// StubDialogueEngine：LLMなしで会話の流れを確かめるための実装（imple 10節のスタブ）。
// 決まった返事を順に返す。発言に特定の語が入ると、形式の崩れた出力やLLMの失敗、
// 禁止語を含む返事、検索（発言をそのまま検索語にする）、質問で終わる返事を再現する。
// 質問のループを防ぐ指示（antiLoop）が付いたときは、決まった意見の返事を返す。
// スタブの禁止語（filterWords）は、設定の禁止語に足して使う。
// 返事はJSONの文字列にしてからparseFirstReply・parseReplyを通し、本番と同じ検証を通す。

import type { Emotion, LlmAlias, Turn } from "@tekurobokun/protocol";
import type { SearchResult } from "../search/engine.ts";
import { sleep } from "../time.ts";
import {
  type DialogueEngine,
  type DialogueResult,
  type FirstReplyResult,
  LlmError,
  parseFirstReply,
  parseReply,
  type ReplyOptions,
} from "./engine.ts";
import stubData from "./stub_replies.json" with { type: "json" };

type StubReply = { say: string; emotion: Emotion };

export type StubData = {
  delayMs: number;
  replies: StubReply[];
  /** 発言にこの語が入ると、JSONでない出力を返す */
  malformedTrigger: string;
  malformedRaw: string;
  /** 発言にこの語が入ると、LLMの失敗を再現する */
  failTrigger: string;
  /** スタブのときだけ足す禁止語（W4-2で、禁止語の入力の差し替えを確かめる） */
  filterWords: string[];
  /** 発言にこの語が入ると、禁止語を含む返事（forbiddenOutputRaw）を返す */
  forbiddenOutputTrigger: string;
  forbiddenOutputRaw: string;
  /** 発言にこの語が入ると、発言を検索語にして前置き（searchPreSay）を返す */
  searchTrigger: string;
  searchPreSay: StubReply;
  /** 2回目の返事（検索できたとき・できなかったとき） */
  searchReply: StubReply;
  searchFailedReply: StubReply;
  /** 発言にこの語が入ると、質問で終わる返事を返す */
  questionTrigger: string;
  questionReply: StubReply;
  /** 質問のループを防ぐ指示が付いたときの返事 */
  antiLoopReply: StubReply;
};

export const DEFAULT_STUB_DATA = stubData as StubData;

export class StubDialogueEngine implements DialogueEngine {
  private next = 0;
  private alias: LlmAlias = "main";

  /** isUpがfalseを返す間は、LLMが落ちている状態を再現して失敗する。 */
  constructor(
    private readonly data: StubData = DEFAULT_STUB_DATA,
    private readonly isUp: () => boolean = () => true,
  ) {}

  activeModel(): LlmAlias {
    return this.alias;
  }

  setModel(alias: LlmAlias): void {
    this.alias = alias;
  }

  async reply(_history: Turn[], text: string, opts: ReplyOptions): Promise<FirstReplyResult> {
    const started = await this.begin(text);
    const raw = this.rawFor(text, opts);
    const { say, emotion, search } = parseFirstReply(raw);
    return { raw, say, emotion, search, thinkingMs: elapsed(started), model: this.alias };
  }

  async replyWithResults(
    _history: Turn[],
    text: string,
    _query: string,
    results: SearchResult[] | null,
    _opts: ReplyOptions,
  ): Promise<DialogueResult> {
    const started = await this.begin(text);
    const reply = results === null ? this.data.searchFailedReply : this.data.searchReply;
    const raw = JSON.stringify(reply);
    const { say, emotion } = parseReply(raw);
    return { raw, say, emotion, thinkingMs: elapsed(started), model: this.alias };
  }

  private async begin(text: string): Promise<number> {
    const started = performance.now();
    await sleep(this.data.delayMs);
    if (!this.isUp()) throw new LlmError("stub: llm is stopped");
    if (text.includes(this.data.failTrigger)) throw new LlmError("stub: simulated llm failure");
    return started;
  }

  private rawFor(text: string, opts: ReplyOptions): string {
    const d = this.data;
    if (text.includes(d.malformedTrigger)) return d.malformedRaw;
    if (text.includes(d.forbiddenOutputTrigger)) return d.forbiddenOutputRaw;
    if (text.includes(d.searchTrigger)) return JSON.stringify({ ...d.searchPreSay, search: text });
    if (opts.antiLoop) return JSON.stringify({ ...d.antiLoopReply, search: null });
    if (text.includes(d.questionTrigger))
      return JSON.stringify({ ...d.questionReply, search: null });
    const reply = d.replies[this.next++ % d.replies.length];
    return JSON.stringify({ ...reply, search: null });
  }
}

const elapsed = (started: number) => Math.round(performance.now() - started);
