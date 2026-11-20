// ConversationLog：会話ログ（imple 3節・7節）。
// logs/YYYY-MM-DD.jsonl（日付はJST）に、1回の発言につき1行のJSONを追記する。書いた行は書き換えない。
// LLMに渡す履歴を区切ったときも1行（kind: "history_cleared"）残す。
// 起動時は、当日のファイルの末尾から表示用の履歴を読み込む（LLMに渡す往復には使わない。区切りの行は飛ばす）。
// v5の行（kind・source・via・sttがなく、入力元がdevice）と、v7までの行（rawFirst・search・model・antiLoopがない）も読む。

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Emotion,
  type HistoryClearedReason,
  isEmotion,
  isLlmAlias,
  type LlmAlias,
  type Turn,
  type Via,
} from "@tekurobokun/protocol";
import { parseFirstReply } from "./dialogue/engine.ts";
import { toJstIso } from "./time.ts";

export type LogEntry = {
  /** 行の種類（v5の行にはなく、turnとして読む） */
  kind: "turn";
  /** 発言を受け付けた日時（ISO 8601、+09:00） */
  at: string;
  /** 入力元（robotかconsoleの名前。v5の行のdeviceを置き換える） */
  source: string;
  /** 機体のマイク（mic）か、consoleの文字（text） */
  via: Via;
  /** 来場者の発言（STTが失敗したときは空） */
  input: string;
  /** 機体のマイクのとき、STTにかかった時間（文字の発言・STTの失敗はnull） */
  stt: { ms: number } | null;
  /** LLMへの問い合わせから返事を得るまで。検索したときは1回目と2回目の合計（LLMに渡さなかったとき・失敗したときはnull） */
  thinkingMs: number | null;
  /** 最後に採用した問い合わせの生の出力（検索したときは2回目。LLMに渡さなかったとき、失敗したときはnull） */
  raw: string | null;
  /** 検索したときの1回目の生の出力（検索しなかったときはnull） */
  rawFirst: string | null;
  /** 検索（しなかったときはnull）。msは検索にかかった時間、urlsは結果のURL、okは検索できたか */
  search: LogSearch | null;
  /** 問い合わせたモデルの別名（LLMに渡さなかったときはnull） */
  model: LlmAlias | null;
  /** 質問のループを防ぐ指示を足したか */
  antiLoop: boolean;
  /** 採用した返事（失敗したときはnull） */
  say: string | null;
  emotion: Emotion | null;
  filtered: "none" | "input" | "output";
  error: "llm_unavailable" | "stt_unavailable" | null;
};

export type LogSearch = { query: string; ms: number | null; urls: string[]; ok: boolean };

/** LLMに渡す履歴を区切った行（だれも話さない時間での自動の区切りか、管理用APIのreset）。 */
export type ClearEntry = { kind: "history_cleared"; at: string; reason: HistoryClearedReason };

/** 会話ログの1行。 */
export type LogLine = LogEntry | ClearEntry;

/** 日時（+09:00のISO 8601）から、その日のファイル名（YYYY-MM-DD.jsonl）。 */
export function logFileName(at: string): string {
  return `${at.slice(0, 10)}.jsonl`;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrOrNull = (v: unknown) => v === null || typeof v === "string";

/** 検索の項目を読む（ない・nullならnull、形が違えばundefined）。 */
function readSearch(v: unknown): LogSearch | null | undefined {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) return undefined;
  const ok =
    typeof v.query === "string" &&
    (v.ms === null || typeof v.ms === "number") &&
    Array.isArray(v.urls) &&
    v.urls.every((u) => typeof u === "string") &&
    typeof v.ok === "boolean";
  return ok
    ? {
        query: v.query as string,
        ms: v.ms as number | null,
        urls: v.urls as string[],
        ok: v.ok as boolean,
      }
    : undefined;
}

/**
 * 発言の1行を読む。形が崩れていればnull（手で編集した行や、書きかけの行を飛ばす）。
 * 発言でない行（履歴の区切りなど）もnull。v5の行は、kindをturn、deviceをsource、viaをtext、sttをnullとして読む。
 */
export function parseLogLine(line: string): LogEntry | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  if (v.kind !== undefined && v.kind !== "turn") return null;
  const source = typeof v.source === "string" ? v.source : v.device;
  const via = v.via === undefined ? "text" : v.via;
  const stt = v.stt === undefined ? null : v.stt;
  const rawFirst = v.rawFirst === undefined ? null : v.rawFirst;
  const search = readSearch(v.search);
  const model = v.model === undefined ? null : v.model;
  const antiLoop = v.antiLoop === undefined ? false : v.antiLoop;
  const ok =
    typeof v.at === "string" &&
    typeof source === "string" &&
    (via === "mic" || via === "text") &&
    (stt === null || (isObj(stt) && typeof stt.ms === "number")) &&
    typeof v.input === "string" &&
    (v.thinkingMs === null || typeof v.thinkingMs === "number") &&
    isStrOrNull(v.raw) &&
    isStrOrNull(rawFirst) &&
    search !== undefined &&
    (model === null || isLlmAlias(model)) &&
    typeof antiLoop === "boolean" &&
    isStrOrNull(v.say) &&
    (v.emotion === null || isEmotion(v.emotion)) &&
    (v.filtered === "none" || v.filtered === "input" || v.filtered === "output") &&
    (v.error === null || v.error === "llm_unavailable" || v.error === "stt_unavailable");
  if (!ok) return null;
  return {
    kind: "turn",
    at: v.at as string,
    source: source as string,
    via: via as Via,
    input: v.input as string,
    stt: stt as { ms: number } | null,
    thinkingMs: v.thinkingMs as number | null,
    raw: v.raw as string | null,
    rawFirst: rawFirst as string | null,
    search: search ?? null,
    model: model as LlmAlias | null,
    antiLoop: antiLoop as boolean,
    say: v.say as string | null,
    emotion: v.emotion as Emotion | null,
    filtered: v.filtered as LogEntry["filtered"],
    error: v.error as LogEntry["error"],
  };
}

/**
 * 表示用の履歴の1件にする。返事がなければ（LLMが失敗した発言）、発言だけを出す。
 * 検索した行は、検索の情報も戻す（前置きは1回目の生の出力から読む）。
 */
export function entryToTurn(entry: LogEntry, id: string): Turn {
  const turn: Turn = {
    id,
    at: entry.at,
    source: entry.source,
    via: entry.via,
    text: entry.input,
  };
  if (entry.search !== null) {
    const preSay = entry.rawFirst === null ? "" : parseFirstReply(entry.rawFirst).say;
    turn.search = {
      query: entry.search.query,
      preSay,
      searchMs: entry.search.ms,
      ok: entry.search.ok,
    };
  }
  if (entry.say !== null) {
    turn.reply = {
      say: entry.say,
      emotion: entry.emotion ?? "neutral",
      thinkingMs: entry.thinkingMs ?? 0,
    };
  }
  return turn;
}

export type ConversationLogOptions = {
  /** ログのディレクトリ（例：リポジトリのlogs/） */
  dir: string;
  now?: () => Date;
  /** 書き込みの失敗をターミナルに出す */
  log?: (line: string) => void;
};

export class ConversationLog {
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  /** 書き込みを順に行うための列（追記の順序を発言の順にそろえる） */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ConversationLogOptions) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  /** 1行を追記する。失敗しても会話は止めず、ターミナルに出す。 */
  append(entry: LogLine): Promise<void> {
    const path = join(this.options.dir, logFileName(entry.at));
    const line = `${JSON.stringify(entry)}\n`;
    this.queue = this.queue.then(async () => {
      try {
        await mkdir(this.options.dir, { recursive: true });
        await appendFile(path, line, "utf8");
      } catch (e) {
        this.log(`log write failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    return this.queue;
  }

  /** 当日（JST）のファイルの末尾から、表示用の履歴をlimit件まで読む（古い順）。 */
  async loadRecent(limit: number): Promise<Turn[]> {
    if (limit <= 0) return [];
    const name = logFileName(toJstIso(this.now()));
    let text: string;
    try {
      text = await readFile(join(this.options.dir, name), "utf8");
    } catch {
      return []; // 当日のファイルがまだない
    }
    const entries = text
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map(parseLogLine)
      // STTが失敗した行（文字がない）は、表示用の履歴に戻さない。
      .filter((e): e is LogEntry => e !== null && e.error !== "stt_unavailable")
      .slice(-limit);
    return entries.map((e, i) => entryToTurn(e, `log-${name.slice(0, 10)}-${i}`));
  }
}
