import { describe, expect, test } from "bun:test";
import type { Turn } from "@tekurobokun/protocol";
import {
  buildMessages,
  FIRST_REPLY_SCHEMA,
  finalSystemPrompt,
  firstSystemPrompt,
  formatResults,
  loadPromptSet,
  normalizeQuery,
  type PromptSet,
  parseFirstReply,
  parseReply,
  SNIPPET_MAX_CHARS,
} from "./engine.ts";

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
    source: "tablet",
    via: "text",
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

  test("調べた往復は、前置きと検索語の1回目を、最終の返事の前に渡す", () => {
    const searched: Turn = {
      ...turn("2"),
      search: {
        query: "東京タワー 高さ",
        preSay: "ちょっと調べてみるね。",
        searchMs: 900,
        ok: true,
      },
    };
    const messages = buildMessages("SYS", [turn("1"), searched], "now", 4);
    expect(messages.map((m) => m.content)).toEqual([
      "SYS",
      "q1",
      '{"say":"a1","emotion":"happy"}',
      "q2",
      '{"say":"ちょっと調べてみるね。","emotion":"curious","search":"東京タワー 高さ"}',
      '{"say":"a2","emotion":"happy"}',
      "now",
    ]);
  });

  test("往復数が0なら履歴を渡さない", () => {
    expect(buildMessages("SYS", [turn("1")], "now", 0)).toHaveLength(2);
  });
});

describe("parseFirstReply", () => {
  test("検索語を読む", () => {
    expect(
      parseFirstReply('{"say":"調べるね。","emotion":"curious","search":" 東京タワー  高さ "}'),
    ).toEqual({
      say: "調べるね。",
      emotion: "curious",
      search: "東京タワー 高さ",
      wellFormed: true,
    });
  });

  test("nullは調べない", () => {
    expect(parseFirstReply('{"say":"やあ。","emotion":"happy","search":null}')).toEqual({
      say: "やあ。",
      emotion: "happy",
      search: null,
      wellFormed: true,
    });
  });

  test("searchがない・型が違うときはnullで、崩れとして数える", () => {
    expect(parseFirstReply('{"say":"やあ。","emotion":"happy"}')).toMatchObject({
      search: null,
      wellFormed: false,
    });
    expect(parseFirstReply('{"say":"やあ。","emotion":"happy","search":3}')).toMatchObject({
      say: "やあ。",
      search: null,
      wellFormed: false,
    });
  });

  test("形式の崩れ・範囲外の感情ではsearchをnullにする", () => {
    expect(parseFirstReply("調べてみるね。")).toEqual({
      say: "調べてみるね。",
      emotion: "neutral",
      search: null,
      wellFormed: false,
    });
    expect(parseFirstReply('{"say":"やあ。","emotion":"angry","search":"x"}')).toMatchObject({
      emotion: "neutral",
      search: null,
      wellFormed: false,
    });
  });

  test("コードブロックの中のJSONは検索語も読む（崩れとして数える）", () => {
    const raw = '```json\n{"say":"a","emotion":"happy","search":"q"}\n```';
    expect(parseFirstReply(raw)).toMatchObject({ search: "q", wellFormed: false });
  });
});

describe("normalizeQuery", () => {
  test("空や「null」はnull、長すぎる語は切る", () => {
    expect(normalizeQuery("")).toBeNull();
    expect(normalizeQuery("  ")).toBeNull();
    expect(normalizeQuery("null")).toBeNull();
    expect(normalizeQuery("None")).toBeNull();
    expect(normalizeQuery(3)).toBeNull();
    expect(normalizeQuery("a".repeat(150))).toHaveLength(100);
  });
});

describe("FIRST_REPLY_SCHEMA", () => {
  test("searchも必須にする", () => {
    expect(FIRST_REPLY_SCHEMA.required).toEqual(["say", "emotion", "search"]);
  });
});

describe("システムプロンプト", () => {
  const set: PromptSet = {
    persona: "PERSONA",
    firstFormat: "FIRST",
    finalFormat: "FINAL",
    antiLoop: "ANTILOOP",
    results: "RESULTS {query}\n{results}",
    searchFailed: "FAILED {query}",
  };
  const lines = (...parts: string[]) => parts.join("\n\n");

  test("1回目は人格→形式。antiLoopなら間に指示を置く", () => {
    expect(firstSystemPrompt(set, { antiLoop: false })).toBe(lines("PERSONA", "FIRST"));
    expect(firstSystemPrompt(set, { antiLoop: true })).toBe(lines("PERSONA", "ANTILOOP", "FIRST"));
    expect(firstSystemPrompt({ ...set, persona: null }, { antiLoop: false })).toBe("FIRST");
  });

  test("2回目は形式のあとに結果を付ける（検索語・抜粋の中の記号は読み替えない）", () => {
    const prompt = finalSystemPrompt(set, { antiLoop: false }, "q$&", [
      { title: "T", url: "u", snippet: "S {query} $1" },
    ]);
    expect(prompt).toBe(lines("PERSONA", "FINAL", "RESULTS q$&\n[1] T\nS {query} $1"));
  });

  test("検索の失敗・0件は、失敗の指示を付ける", () => {
    expect(finalSystemPrompt(set, { antiLoop: true }, "q", null)).toBe(
      lines("PERSONA", "ANTILOOP", "FINAL", "FAILED q"),
    );
    expect(finalSystemPrompt(set, { antiLoop: false }, "q", [])).toBe(
      lines("PERSONA", "FINAL", "FAILED q"),
    );
  });

  test("長い抜粋は切る", () => {
    const text = formatResults([{ title: "T", url: "u", snippet: "あ".repeat(400) }]);
    expect(text).toBe(`[1] T\n${"あ".repeat(SNIPPET_MAX_CHARS)}…`);
  });

  test("文面のファイルを読み、感情の一覧を埋める", async () => {
    const loaded = await loadPromptSet("  あなたはテクロボくんです。 ");
    expect(loaded.persona).toBe("あなたはテクロボくんです。");
    expect(loaded.firstFormat).toContain("neutral, happy, surprised, curious, troubled");
    expect(loaded.firstFormat).toContain('"search"');
    expect(loaded.finalFormat).not.toContain('"search"');
    expect(loaded.results).toContain("{results}");
    expect(loaded.searchFailed).toContain("{query}");
    expect((await loadPromptSet(null)).persona).toBeNull();
  });
});
