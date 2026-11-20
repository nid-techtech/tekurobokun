import { describe, expect, test } from "bun:test";
import {
  characterErrorRate,
  characterErrors,
  editDistance,
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
      sample({ reference: "こんにちは", raw: "こんにちは", discarded: "no_speech" }),
    ]);
    expect(s.silentCount).toBe(3);
    expect(s.silentRecognized).toBe(1);
    expect(s.speechDiscarded).toBe(1);
    expect(s.discards).toEqual({ empty: 1, no_speech: 1, hallucination: 1 });
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
