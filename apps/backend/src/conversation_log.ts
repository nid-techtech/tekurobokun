// ConversationLog：会話ログ（imple 3節・7節）。
// logs/YYYY-MM-DD.jsonl（日付はJST）に、1回の発言につき1行のJSONを追記する。書いた行は書き換えない。
// 起動時は、当日のファイルの末尾から表示用の履歴を読み込む（LLMに渡す往復には使わない）。

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Emotion, isEmotion, type Turn } from "@tekurobokun/protocol";
import { toJstIso } from "./time.ts";

export type LogEntry = {
  /** 発言を受け付けた日時（ISO 8601、+09:00） */
  at: string;
  /** 入力元の端末名 */
  device: string;
  /** 来場者の発言 */
  input: string;
  /** LLMへの問い合わせから返事を得るまで（LLMに渡さなかったとき・失敗したときはnull） */
  thinkingMs: number | null;
  /** LLMの生の出力（LLMに渡さなかったとき、失敗したときはnull） */
  raw: string | null;
  /** 採用した返事（失敗したときはnull） */
  say: string | null;
  emotion: Emotion | null;
  filtered: "none" | "input" | "output";
  error: "llm_unavailable" | null;
};

/** 日時（+09:00のISO 8601）から、その日のファイル名（YYYY-MM-DD.jsonl）。 */
export function logFileName(at: string): string {
  return `${at.slice(0, 10)}.jsonl`;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrOrNull = (v: unknown) => v === null || typeof v === "string";

/** 1行を読む。形が崩れていればnull（手で編集した行や、書きかけの行を飛ばす）。 */
export function parseLogLine(line: string): LogEntry | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  const ok =
    typeof v.at === "string" &&
    typeof v.device === "string" &&
    typeof v.input === "string" &&
    (v.thinkingMs === null || typeof v.thinkingMs === "number") &&
    isStrOrNull(v.raw) &&
    isStrOrNull(v.say) &&
    (v.emotion === null || isEmotion(v.emotion)) &&
    (v.filtered === "none" || v.filtered === "input" || v.filtered === "output") &&
    (v.error === null || v.error === "llm_unavailable");
  return ok ? (v as LogEntry) : null;
}

/** 表示用の履歴の1件にする。返事がなければ（LLMが失敗した発言）、発言だけを出す。 */
export function entryToTurn(entry: LogEntry, id: string): Turn {
  const turn: Turn = { id, at: entry.at, device: entry.device, text: entry.input };
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
  append(entry: LogEntry): Promise<void> {
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
      .filter((e): e is LogEntry => e !== null)
      .slice(-limit);
    return entries.map((e, i) => entryToTurn(e, `log-${name.slice(0, 10)}-${i}`));
  }
}
