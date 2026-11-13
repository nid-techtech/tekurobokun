import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadFilterConfig,
  normalizeForFilter,
  parseFilterConfig,
  WordListFilter,
} from "./content_filter.ts";
import { DEFAULT_STUB_DATA, StubDialogueEngine } from "./dialogue/stub.ts";

const first = { say: "その話はやめておきましょう。", emotion: "troubled" as const };
const replies = [first, { say: "ほかの話をしませんか。", emotion: "neutral" as const }];

describe("normalizeForFilter", () => {
  test("全角・半角、大文字・小文字、空白の違いをなくし、カタカナとひらがなは区別する", () => {
    expect(normalizeForFilter("ＡＢＣ abc")).toBe("abcabc");
    expect(normalizeForFilter("バカ")).toBe("バカ");
    expect(normalizeForFilter("ﾊﾞｶ")).toBe("バカ");
    expect(normalizeForFilter("ば　か")).toBe("ばか");
  });
});

describe("WordListFilter", () => {
  const filter = () => new WordListFilter({ words: ["バカ", "NG Word"], replies });

  test("禁止語を含まなければ当たらない", () => {
    expect(filter().check("こんにちは")).toEqual({ hit: false });
    expect(filter().check("")).toEqual({ hit: false });
  });

  test("表記の揺れがあっても部分一致で当たり、定型の返事を返す", () => {
    for (const text of ["お前はバカだ", "ﾊﾞｶ", "バ カ", "これはng-word じゃない ngword"]) {
      expect(filter().check(text)).toEqual({ hit: true, replacement: replies[0] });
    }
  });

  test("カタカナの語は、ひらがなの普通の文には当たらない", () => {
    const f = new WordListFilter({ words: ["イク", "クソ"], replies });
    expect(f.check("いくつ作りましたか").hit).toBe(false);
    expect(f.check("やくそくします").hit).toBe(false);
    expect(f.check("イクぞ").hit).toBe(true);
  });

  test("定型の返事は当たるたびに順に使う", () => {
    const f = filter();
    expect(f.check("バカ").replacement).toEqual(replies[0]);
    expect(f.check("バカ").replacement).toEqual(replies[1]);
    expect(f.check("バカ").replacement).toEqual(replies[0]);
  });

  test("返した定型の返事を書き換えても、次の返事に影響しない", () => {
    const f = new WordListFilter({ words: ["バカ"], replies: [first] });
    const got = f.check("バカ").replacement;
    if (got) got.say = "書き換え";
    expect(f.check("バカ").replacement?.say).toBe(first.say);
  });

  test("空・空白だけの禁止語は無視する（すべての文に当たらないように）", () => {
    const f = new WordListFilter({ words: ["", "  "], replies });
    expect(f.check("こんにちは").hit).toBe(false);
  });

  test("禁止語が空なら、何にも当たらない", () => {
    expect(new WordListFilter({ words: [], replies }).check("ばか").hit).toBe(false);
  });

  test("スタブの、禁止語を含む返事は、スタブの禁止語に当たる", async () => {
    const f = new WordListFilter({ words: DEFAULT_STUB_DATA.filterWords, replies });
    const stub = new StubDialogueEngine({ ...DEFAULT_STUB_DATA, delayMs: 0 });
    const { say } = await stub.reply([], DEFAULT_STUB_DATA.forbiddenOutputTrigger);
    expect(f.check(say).hit).toBe(true);
    expect(f.check(DEFAULT_STUB_DATA.filterWords[0] ?? "").hit).toBe(true);
  });
});

describe("parseFilterConfig", () => {
  test("正しい形なら読み、返事の前後の空白を除く", () => {
    expect(
      parseFilterConfig({ words: ["a"], replies: [{ say: " やあ ", emotion: "happy" }] }),
    ).toEqual({ words: ["a"], replies: [{ say: "やあ", emotion: "happy" }] });
  });

  test("崩れていれば、どの項目かを示して投げる", () => {
    expect(() => parseFilterConfig(null)).toThrow("filter: config");
    expect(() => parseFilterConfig({ words: "a", replies })).toThrow("filter: words");
    expect(() => parseFilterConfig({ words: [1], replies })).toThrow("filter: words");
    expect(() => parseFilterConfig({ words: [], replies: [] })).toThrow("filter: replies");
    expect(() =>
      parseFilterConfig({ words: [], replies: [{ say: "", emotion: "happy" }] }),
    ).toThrow("replies[0].say");
    expect(() =>
      parseFilterConfig({ words: [], replies: [{ say: "a", emotion: "angry" }] }),
    ).toThrow("replies[0].emotion");
  });

  test("リポジトリのfilter.default.jsonは正しい形", async () => {
    const config = await loadFilterConfig(join(import.meta.dir, "../../../config/"));
    expect(config.replies.length).toBeGreaterThan(0);
  });

  test("filter.local.jsonがあれば項目ごとに上書きする", async () => {
    const dir = await mkdtemp(join(tmpdir(), "filter-"));
    try {
      await writeFile(join(dir, "filter.default.json"), JSON.stringify({ words: [], replies }));
      await writeFile(join(dir, "filter.local.json"), JSON.stringify({ words: ["ばか"] }));
      const config = await loadFilterConfig(`${dir}/`);
      expect(config).toEqual({ words: ["ばか"], replies });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
