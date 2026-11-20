import { describe, expect, test } from "bun:test";
import { endsWithQuestion, shouldAntiLoop, trailingQuestions } from "./anti_loop.ts";

describe("質問のループの判定", () => {
  test("末尾が？・?なら質問。末尾の空白・閉じかっこは見ない", () => {
    expect(endsWithQuestion("好きですか？")).toBe(true);
    expect(endsWithQuestion("Really? ")).toBe(true);
    expect(endsWithQuestion("「本当？」")).toBe(true);
    expect(endsWithQuestion("好きです。")).toBe(false);
    expect(endsWithQuestion("何？と聞かれました。")).toBe(false);
  });

  test("末尾から続けて質問で終わった数を数える", () => {
    expect(trailingQuestions(["a？", "b。", "c？", "d？"])).toBe(2);
    expect(trailingQuestions(["a？", "b。"])).toBe(0);
    expect(trailingQuestions([])).toBe(0);
  });

  test("しきい値以上で指示を足す。0なら足さない", () => {
    expect(shouldAntiLoop(["a？", "b？"], 2)).toBe(true);
    expect(shouldAntiLoop(["a？"], 2)).toBe(false);
    expect(shouldAntiLoop(["a？", "b？"], 0)).toBe(false);
  });
});
