import { describe, expect, test } from "bun:test";
import { CONFIG_DIR } from "../../apps/backend/src/config.ts";
import {
  judgeSearch,
  lastSentence,
  modelMatches,
  OTHER_TYPE,
  parseBenchConfig,
  type QuestionType,
  questionType,
  type ScriptTurn,
  scriptStats,
  timeStats,
} from "./dialogue_bench.ts";

const types: QuestionType[] = [
  { name: "好み", pattern: "好き" },
  { name: "理由", pattern: "なぜ|どうして" },
  { name: "もの", pattern: "何" },
];

const turn = (say: string | null, over: Partial<ScriptTurn> = {}): ScriptTurn => ({
  input: "x",
  antiLoop: false,
  search: null,
  say,
  questionType: say === null ? null : questionType(say, types),
  thinkingMs: 100,
  error: say === null ? "down" : null,
  ...over,
});

describe("bench.default.json", () => {
  test("リポジトリの設定が読め、Qwenの4つの枠がある", async () => {
    const config = parseBenchConfig(await Bun.file(`${CONFIG_DIR}bench.default.json`).json());
    expect(config.targets.map((t) => t.name)).toEqual([
      "qwen3-8b",
      "qwen3.5-9b",
      "qwen3.5-4b",
      "qwen3-4b",
    ]);
    expect(config.search.should.length).toBeGreaterThan(0);
    expect(config.search.shouldNot.length).toBeGreaterThan(0);
    expect(config.self.length).toBeGreaterThan(0);
    expect(config.scripts.every((s) => s.turns.length >= 3)).toBe(true);
  });

  test("形の崩れ・同じ名前・正しくない正規表現は例外", () => {
    const ok = {
      targets: [{ name: "a", baseUrl: "http://x" }],
      questions: [],
      search: { should: [], shouldNot: [] },
      self: [],
      scripts: [],
      questionTypes: [],
    };
    expect(() => parseBenchConfig(ok)).not.toThrow();
    expect(() => parseBenchConfig({ ...ok, targets: [...ok.targets, ...ok.targets] })).toThrow();
    expect(() => parseBenchConfig({ ...ok, search: { should: [] } })).toThrow();
    expect(() => parseBenchConfig({ ...ok, scripts: [{ name: "s" }] })).toThrow();
    expect(() =>
      parseBenchConfig({ ...ok, questionTypes: [{ name: "x", pattern: "(" }] }),
    ).toThrow();
  });
});

describe("modelMatches", () => {
  test("読み込み中のidに、match（なければmodel）が大文字小文字を問わず含まれるか", () => {
    const loaded = ["C:\\models\\Qwen3.5-9B-Q4_K_M.gguf"];
    expect(modelMatches({ name: "a" }, "qwen3.5-9b", loaded)).toBe(true);
    expect(modelMatches({ name: "a" }, "qwen3-8b", loaded)).toBe(false);
    expect(modelMatches({ name: "a", match: "Q4_K_M" }, "qwen3-8b", loaded)).toBe(true);
    // Qwen3-4BとQwen3.5-4Bを取り違えない
    expect(modelMatches({ name: "a" }, "qwen3-4b", ["Qwen3.5-4B-Q4_K_M.gguf"])).toBe(false);
  });
});

describe("質問の型", () => {
  test("最後の文で型を決める。質問で終わらなければnull", () => {
    expect(lastSentence("LEDはいいですね。何色が好き？")).toBe("何色が好き？");
    expect(questionType("LEDはいいですね。何色が好き？", types)).toBe("好み");
    expect(questionType("どうしてそう思うの？", types)).toBe("理由");
    expect(questionType("本当？", types)).toBe(OTHER_TYPE);
    expect(questionType("わたしは赤が好きです。", types)).toBeNull();
  });
});

describe("scriptStats", () => {
  test("質問で終わった割合と、続けて同じ型の質問で終わった回数を数える", () => {
    const stats = scriptStats([
      turn("赤が好き？"),
      turn("青も好き？"),
      turn("緑も好き？", { antiLoop: true }),
      turn("なるほど。"),
      turn(null),
      turn("なぜ？"),
    ]);
    expect(stats).toEqual({
      replies: 5,
      questions: 4,
      questionRatio: 0.8,
      sameTypeRuns: 2,
      antiLoops: 1,
    });
    expect(scriptStats([]).questionRatio).toBeNull();
  });
});

describe("judgeSearch", () => {
  test("出すべき質問で出したか、出すべきでない質問で出さなかったかを数える（失敗は数えない）", () => {
    expect(
      judgeSearch([
        { expected: true, search: "q", error: null },
        { expected: true, search: null, error: null },
        { expected: true, search: null, error: "down" },
        { expected: false, search: null, error: null },
      ]),
    ).toEqual({ should: { correct: 1, total: 2 }, shouldNot: { correct: 1, total: 1 } });
  });
});

describe("timeStats", () => {
  test("中央値・平均・最大。値がなければnull", () => {
    expect(timeStats([300, null, 100, 200])).toEqual({ median: 200, mean: 200, max: 300 });
    expect(timeStats([null])).toEqual({ median: null, mean: null, max: null });
  });
});
