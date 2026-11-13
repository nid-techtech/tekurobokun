import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConversationLog,
  entryToTurn,
  type LogEntry,
  logFileName,
  parseLogLine,
} from "./conversation_log.ts";

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  at: "2026-11-14T10:02:11.000+09:00",
  device: "tablet",
  input: "こんにちは",
  thinkingMs: 1200,
  raw: '{"say":"やあ。","emotion":"happy"}',
  say: "やあ。",
  emotion: "happy",
  filtered: "none",
  error: null,
  ...over,
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "conversation-log-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** JSTで2026-11-14 10:30の時計。UTCではまだ前日にならない時刻と、なる時刻を試す。 */
const at = (iso: string) => () => new Date(iso);

describe("logFileName", () => {
  test("JSTの日付のファイル名にする（UTCで前日の時刻でも、JSTの日付）", () => {
    expect(logFileName("2026-11-14T08:59:59.000+09:00")).toBe("2026-11-14.jsonl");
  });
});

describe("ConversationLog", () => {
  test("1回の発言につき1行を、日ごとのファイルに順に追記する", async () => {
    const log = new ConversationLog({ dir: join(dir, "logs") });
    const a = entry({ input: "1" });
    const b = entry({ input: "2", filtered: "input", raw: null, thinkingMs: null });
    const c = entry({ at: "2026-11-15T00:00:01.000+09:00", input: "3" });
    // 待たずに続けて書いても、順序は崩れない
    void log.append(a);
    void log.append(b);
    await log.append(c);
    const day1 = await readFile(join(dir, "logs", "2026-11-14.jsonl"), "utf8");
    expect(day1.split("\n")).toEqual([JSON.stringify(a), JSON.stringify(b), ""]);
    const day2 = await readFile(join(dir, "logs", "2026-11-15.jsonl"), "utf8");
    expect(day2).toBe(`${JSON.stringify(c)}\n`);
  });

  test("書いた行の項目はimple 7節のとおり", async () => {
    const log = new ConversationLog({ dir });
    await log.append(entry());
    const line = (await readFile(join(dir, "2026-11-14.jsonl"), "utf8")).trim();
    expect(Object.keys(JSON.parse(line))).toEqual([
      "at",
      "device",
      "input",
      "thinkingMs",
      "raw",
      "say",
      "emotion",
      "filtered",
      "error",
    ]);
  });

  test("書き込みに失敗しても例外を投げず、ターミナルに出す", async () => {
    const file = join(dir, "not-a-dir");
    await writeFile(file, "");
    const lines: string[] = [];
    const log = new ConversationLog({ dir: file, log: (l) => lines.push(l) });
    await log.append(entry());
    expect(lines[0]).toStartWith("log write failed:");
  });

  test("起動時は、当日（JST）のファイルの末尾から表示用の履歴を読む", async () => {
    const log = new ConversationLog({ dir, now: at("2026-11-14T01:30:00.000Z") });
    for (let i = 1; i <= 5; i++) await log.append(entry({ input: `${i}` }));
    const turns = await log.loadRecent(3);
    expect(turns.map((t) => t.text)).toEqual(["3", "4", "5"]);
    expect(turns[0]).toEqual({
      id: expect.any(String),
      at: "2026-11-14T10:02:11.000+09:00",
      device: "tablet",
      text: "3",
      reply: { say: "やあ。", emotion: "happy", thinkingMs: 1200 },
    });
    expect(new Set(turns.map((t) => t.id)).size).toBe(3);
  });

  test("UTCでは前日の時刻（JSTの朝）でも、JSTの当日のファイルを読む", async () => {
    const log = new ConversationLog({ dir, now: at("2026-11-13T23:30:00.000Z") });
    await log.append(entry({ at: "2026-11-14T08:00:00.000+09:00" }));
    expect(await log.loadRecent(50)).toHaveLength(1);
  });

  test("当日のファイルがなければ空。前日のファイルは読まない", async () => {
    const log = new ConversationLog({ dir, now: at("2026-11-15T01:00:00.000Z") });
    await log.append(entry());
    expect(await log.loadRecent(50)).toEqual([]);
    expect(await new ConversationLog({ dir: join(dir, "none") }).loadRecent(50)).toEqual([]);
  });

  test("崩れた行・空行は飛ばす。件数が0なら読まない", async () => {
    await writeFile(
      join(dir, "2026-11-14.jsonl"),
      `${JSON.stringify(entry({ input: "a" }))}\r\n{broken\n\n${JSON.stringify({ at: 1 })}\n${JSON.stringify(entry({ input: "b" }))}`,
    );
    const log = new ConversationLog({ dir, now: at("2026-11-14T01:30:00.000Z") });
    expect((await log.loadRecent(50)).map((t) => t.text)).toEqual(["a", "b"]);
    expect(await log.loadRecent(0)).toEqual([]);
  });
});

describe("parseLogLine・entryToTurn", () => {
  test("正しい行は読み、項目の型が違えばnull", () => {
    expect(parseLogLine(JSON.stringify(entry()))).toEqual(entry());
    expect(parseLogLine(JSON.stringify(entry({ emotion: "angry" as never })))).toBeNull();
    expect(parseLogLine(JSON.stringify(entry({ filtered: "x" as never })))).toBeNull();
    expect(parseLogLine("[]")).toBeNull();
  });

  test("LLMが失敗した行は、返事のない発言にする", () => {
    const failed = entry({
      thinkingMs: null,
      raw: null,
      say: null,
      emotion: null,
      error: "llm_unavailable",
    });
    expect(entryToTurn(failed, "x")).toEqual({
      id: "x",
      at: failed.at,
      device: "tablet",
      text: "こんにちは",
    });
  });

  test("LLMに渡さなかった（禁止語の入力）行は、考えた時間を0として返事を出す", () => {
    const filtered = entry({ thinkingMs: null, raw: null, filtered: "input" });
    expect(entryToTurn(filtered, "x").reply).toEqual({
      say: "やあ。",
      emotion: "happy",
      thinkingMs: 0,
    });
  });
});
