// StubDialogueEngine：LLMなしで会話の流れを確かめるための実装（imple 10節のスタブ）。
// 決まった返事を順に返す。発言に特定の語が入ると、形式の崩れた出力やLLMの失敗を再現する。
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
};

export const DEFAULT_STUB_DATA = stubData as StubData;

export class StubDialogueEngine implements DialogueEngine {
  private next = 0;

  constructor(private readonly data: StubData = DEFAULT_STUB_DATA) {}

  async reply(_history: Turn[], text: string): Promise<DialogueResult> {
    const started = performance.now();
    await sleep(this.data.delayMs);
    if (text.includes(this.data.failTrigger)) throw new LlmError("stub: simulated llm failure");
    const raw = text.includes(this.data.malformedTrigger)
      ? this.data.malformedRaw
      : JSON.stringify(this.data.replies[this.next++ % this.data.replies.length]);
    const { say, emotion } = parseReply(raw);
    return { raw, say, emotion, thinkingMs: Math.round(performance.now() - started) };
  }
}
