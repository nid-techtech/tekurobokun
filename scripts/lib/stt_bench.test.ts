import { describe, expect, test } from "bun:test";
import {
  characterErrorRate,
  characterErrors,
  editDistance,
  logprobRange,
  normalizeForCer,
  type SampleResult,
  summarize,
} from "./stt_bench.ts";

describe("editDistance", () => {
  test("挿入・削除・置換を1と数える", () => {
    expect(editDistance("", "")).toBe(0);
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("abc", "")).toBe(3);
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("今日は晴れ", "今日は雨")).toBe(2);
  });

  test("サロゲートペアの文字を1文字と数える", () => {
    expect(editDistance("𠮷野家", "吉野家")).toBe(1);
  });
});

describe("誤り率", () => {
  test("空白・句読点・記号と全角・半角の違いは数えない", () => {
    expect(normalizeForCer("こんにちは、 世界！")).toBe("こんにちは世界");
    expect(normalizeForCer("ＡＢＣ１２３")).toBe("ABC123");
    expect(characterErrorRate("こんにちは。", "こんにちは")).toBe(0);
  });

  test("誤りの数を正解の文字数で割る", () => {
    expect(characterErrors("今日は晴れです", "今日は雨です")).toEqual({
      distance: 2,
      refLength: 7,
    });
    expect(characterErrorRate("今日は晴れです", "今日は雨です")).toBeCloseTo(2 / 7);
  });

  test("何も出なければ1、出しすぎると1を超える", () => {
    expect(characterErrorRate("こんにちは", "")).toBe(1);
    expect(characterErrorRate("あい", "あいうえお")).toBe(1.5);
  });

  test("正解が空（無音）なら定義しない", () => {
    expect(characterErrorRate("", "ご視聴ありがとうございました")).toBeNull();
    expect(characterErrorRate("。", "")).toBeNull();
  });
});

const sample = (over: Partial<SampleResult>): SampleResult => ({
  file: "a.wav",
  reference: "",
  raw: "",
  text: "",
  discarded: null,
  logprobs: [],
  ms: 100,
  ...over,
});

describe("summarize", () => {
  test("発話の誤り率は、誤りの合計を文字数の合計で割る（短い録音に引っ張られない）", () => {
    const s = summarize([
      sample({ reference: "あいうえお", text: "あいうえお" }),
      sample({ reference: "かき", text: "" }),
    ]);
    expect(s.speechCount).toBe(2);
    expect(s.cer).toBeCloseTo(2 / 7);
    expect(s.speechDiscarded).toBe(0);
  });

  test("無音の録音で文が出た数と、発話を捨てた数と、理由別の数を数える", () => {
    const s = summarize([
      sample({ reference: "", raw: "ご視聴ありがとうございました", discarded: "hallucination" }),
      sample({ reference: "", raw: "ふーん", text: "ふーん" }),
      sample({ reference: "", raw: " ", discarded: "empty" }),
      sample({ reference: "こんにちは", raw: "こんにちは", discarded: "low_logprob" }),
    ]);
    expect(s.silentCount).toBe(3);
    expect(s.silentRecognized).toBe(1);
    expect(s.speechDiscarded).toBe(1);
    expect(s.discards).toEqual({ empty: 1, low_logprob: 1, hallucination: 1 });
  });

  test("avg_logprobの境目：発話は録音ごとの最大の最小、雑音は文が出たものの最大の最大", () => {
    expect(logprobRange([])).toBeNull();
    expect(logprobRange([-0.5, -0.1, -0.3])).toEqual({ min: -0.5, max: -0.1 });
    const s = summarize([
      sample({ reference: "こんにちは", raw: "こんにちは", logprobs: [-0.05] }),
      sample({ reference: "長い発話", raw: "長い。発話", logprobs: [-0.6, -0.12] }),
      sample({ reference: "", raw: "はい", logprobs: [-0.39] }),
      sample({ reference: "", raw: "ん", logprobs: [-0.85, -0.7] }),
      // VADが捨てた（文も区切りもない）
      sample({ reference: "", raw: "", logprobs: [] }),
    ]);
    expect(s.speechLogprobFloor).toBe(-0.12);
    expect(s.silentLogprobCeiling).toBe(-0.39);
    expect(summarize([sample({ reference: "", raw: "" })]).silentLogprobCeiling).toBeNull();
  });

  test("時間は中央値（偶数件は小さい側）・平均・最大", () => {
    const s = summarize([100, 400, 200, 300].map((ms) => sample({ ms })));
    expect(s.medianMs).toBe(200);
    expect(s.meanMs).toBe(250);
    expect(s.maxMs).toBe(400);
  });

  test("正解のある録音がなければ誤り率はnull", () => {
    expect(summarize([sample({})]).cer).toBeNull();
    expect(summarize([]).medianMs).toBeNull();
  });
});
