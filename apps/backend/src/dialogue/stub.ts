// StubDialogueEngine：LLMなしで会話の流れを確かめるための実装（imple 10節のスタブ）。
// 決まった返事を順に返す。発言に特定の語が入ると、形式の崩れた出力やLLMの失敗、
// 禁止語を含む返事を再現する。スタブの禁止語（filterWords）は、設定の禁止語に足して使う。
// 返事はJSONの文字列にしてからparseReplyを通し、本番と同じ検証を通す。

import type { Emotion, Turn } from "@tekurobokun/protocol";
import { sleep } from "../time.ts";
import { type DialogueEngine, type DialogueResult, LlmError, parseReply } from "./engine.ts";
import stubData from "./stub_replies.json" with { type: "json" };

export type StubData = {
  delayMs: number;
  replies: { say: string; emotion: Emotion }[];
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
};

export const DEFAULT_STUB_DATA = stubData as StubData;

export class StubDialogueEngine implements DialogueEngine {
  private next = 0;

  /** isUpがfalseを返す間は、LLMが落ちている状態を再現して失敗する。 */
  constructor(
    private readonly data: StubData = DEFAULT_STUB_DATA,
    private readonly isUp: () => boolean = () => true,
  ) {}

  async reply(_history: Turn[], text: string): Promise<DialogueResult> {
    const started = performance.now();
    await sleep(this.data.delayMs);
    if (!this.isUp()) throw new LlmError("stub: llm is stopped");
    if (text.includes(this.data.failTrigger)) throw new LlmError("stub: simulated llm failure");
    const raw = this.rawFor(text);
    const { say, emotion } = parseReply(raw);
    return { raw, say, emotion, thinkingMs: Math.round(performance.now() - started) };
  }

  private rawFor(text: string): string {
    if (text.includes(this.data.malformedTrigger)) return this.data.malformedRaw;
    if (text.includes(this.data.forbiddenOutputTrigger)) return this.data.forbiddenOutputRaw;
    return JSON.stringify(this.data.replies[this.next++ % this.data.replies.length]);
  }
}
