import { describe, expect, test } from "bun:test";
import type { Turn } from "@tekurobokun/protocol";
import { buildMessages, buildSystemPrompt, parseReply } from "./engine.ts";

describe("parseReply", () => {
  test("正しいJSONはそのまま", () => {
    expect(parseReply('{"say":"やあ。","emotion":"happy"}')).toEqual({
      say: "やあ。",
      emotion: "happy",
      wellFormed: true,
    });
  });

  test("前後の空白とsayの空白は落とす", () => {
    expect(parseReply('  {"say":" やあ。 ","emotion":"curious"}\n')).toEqual({
      say: "やあ。",
      emotion: "curious",
      wellFormed: true,
    });
  });

  test("範囲外の感情はneutralで、崩れとして数える", () => {
    expect(parseReply('{"say":"やあ。","emotion":"angry"}')).toEqual({
      say: "やあ。",
      emotion: "neutral",
      wellFormed: false,
    });
  });

  test("感情がなければneutral", () => {
    expect(parseReply('{"say":"やあ。"}')).toEqual({
      say: "やあ。",
      emotion: "neutral",
      wellFormed: false,
    });
  });

  test("コードブロックに囲まれたJSONは中身を読む（崩れとして数える）", () => {
    expect(parseReply('```json\n{"say":"やあ。","emotion":"happy"}\n```')).toEqual({
      say: "やあ。",
      emotion: "happy",
      wellFormed: false,
    });
  });

  test("JSONでなければ本文をsay、感情をneutral", () => {
    expect(parseReply("こんにちは。元気です。")).toEqual({
      say: "こんにちは。元気です。",
      emotion: "neutral",
      wellFormed: false,
    });
  });

  test("sayが空のJSONは本文をそのままsayにする", () => {
    const raw = '{"say":"","emotion":"happy"}';
    expect(parseReply(raw)).toEqual({ say: raw, emotion: "neutral", wellFormed: false });
  });

  test("JSONでない本文のコードブロックの記号は落とす", () => {
    expect(parseReply("```\nこんにちは\n```").say).toBe("こんにちは");
  });
});

describe("buildMessages", () => {
  const turn = (id: string, reply = true): Turn => ({
    id,
    at: "2026-11-14T10:00:00.000+09:00",
    device: "tablet",
    text: `q${id}`,
    ...(reply ? { reply: { say: `a${id}`, emotion: "happy", thinkingMs: 10 } } : {}),
  });

  test("システム、直近の往復、今回の発言の順", () => {
    const messages = buildMessages("SYS", [turn("1"), turn("2"), turn("3")], "now", 2);
    expect(messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "q2" },
      { role: "assistant", content: '{"say":"a2","emotion":"happy"}' },
      { role: "user", content: "q3" },
      { role: "assistant", content: '{"say":"a3","emotion":"happy"}' },
      { role: "user", content: "now" },
    ]);
  });

  test("返事のない発言は往復に含めない", () => {
    const messages = buildMessages("SYS", [turn("1"), turn("2", false)], "now", 4);
    expect(messages.map((m) => m.content)).toEqual([
      "SYS",
      "q1",
      '{"say":"a1","emotion":"happy"}',
      "now",
    ]);
  });

  test("往復数が0なら履歴を渡さない", () => {
    expect(buildMessages("SYS", [turn("1")], "now", 0)).toHaveLength(2);
  });
});

describe("buildSystemPrompt", () => {
  test("人格プロンプトのあとに返事の形式を付け、感情の一覧を埋める", async () => {
    const prompt = await buildSystemPrompt("あなたはテクロボくんです。");
    expect(prompt.startsWith("あなたはテクロボくんです。\n\n")).toBe(true);
    expect(prompt).toContain("neutral, happy, surprised, curious, troubled");
    expect(prompt).not.toContain("{emotions}");
  });

  test("人格プロンプトがなければ形式だけ", async () => {
    const prompt = await buildSystemPrompt(null);
    expect(prompt.startsWith("#")).toBe(true);
  });
});
