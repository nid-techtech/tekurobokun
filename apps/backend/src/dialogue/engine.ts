// DialogueEngine：LLMへの問い合わせと返事の検証（imple 3節・4節）。
// 実装はLlamaDialogueEngine（OpenAI互換API）とStubDialogueEngine（LLMなしの開発用）。
//
// 1回目（reply）は`{say, emotion, search}`を返す。`search`が検索語なら、`say`は調べる前の前置き。
// 2回目（replyWithResults）は、検索結果の抜粋（失敗ならnull）を付けて`{say, emotion}`を返す。
// 検索は1ターンに1回までのため、2回目のスキーマに`search`はない。
// システムプロンプトは、自己認識（persona_self.md）→人格（persona.md）→（antiLoopのとき）質問のループを
// 防ぐ指示→返事の形式→（2回目）調べた結果、の順に組み立てる。文面はこのフォルダの*.md（コードに日本語を
// 直書きしないため）。

import { EMOTIONS, type Emotion, isEmotion, type LlmAlias, type Turn } from "@tekurobokun/protocol";
import type { SearchResult } from "../search/engine.ts";

export type ReplyOptions = {
  /** 質問のループを防ぐ指示を足すか */
  antiLoop: boolean;
};

export type DialogueResult = {
  /** LLMの生の出力 */
  raw: string | null;
  say: string;
  emotion: Emotion;
  /** LLMへの問い合わせから返事を得るまでの時間 */
  thinkingMs: number;
  /** 問い合わせたときのモデルの別名 */
  model: LlmAlias;
};

export type FirstReplyResult = DialogueResult & {
  /** 検索語（調べないときはnull） */
  search: string | null;
};

/** LLMに届かない、または応答が読めないときの例外。 */
export class LlmError extends Error {}
/** LLMが時間内に返事をしなかったときの例外（管理用APIに`llm_timeout`を出す）。 */
export class LlmTimeoutError extends LlmError {}

export interface DialogueEngine {
  /** 1回目。LLMに届かない・応答が崩れて読めないときは例外を投げる。 */
  reply(history: Turn[], text: string, opts: ReplyOptions): Promise<FirstReplyResult>;
  /** 2回目。resultsがnullなら検索の失敗として答えさせる。 */
  replyWithResults(
    history: Turn[],
    text: string,
    query: string,
    results: SearchResult[] | null,
    opts: ReplyOptions,
  ): Promise<DialogueResult>;
  /** いまのモデルの別名 */
  activeModel(): LlmAlias;
  /** モデルの別名を切り替える（ランチャーが正→副に切り替えたとき、PUT /admin/llm-model） */
  setModel(alias: LlmAlias): void;
}

export type ParsedReply = {
  say: string;
  emotion: Emotion;
  /** 生の出力が、そのまま形式どおりのJSONとして読めたか（形式の崩れの集計に使う） */
  wellFormed: boolean;
};

export type ParsedFirstReply = ParsedReply & { search: string | null };

/** 2回目の返事のJSONスキーマ（llama-serverのresponse_formatに渡す）。 */
export const REPLY_SCHEMA = {
  type: "object",
  properties: {
    say: { type: "string", minLength: 1 },
    emotion: { type: "string", enum: [...EMOTIONS] },
  },
  required: ["say", "emotion"],
  additionalProperties: false,
} as const;

/** 1回目の返事のJSONスキーマ。searchは検索語かnull。 */
export const FIRST_REPLY_SCHEMA = {
  type: "object",
  properties: {
    say: { type: "string", minLength: 1 },
    emotion: { type: "string", enum: [...EMOTIONS] },
    search: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
  },
  required: ["say", "emotion", "search"],
  additionalProperties: false,
} as const;

/** 検索語の長さの上限（長すぎる語は切る） */
export const SEARCH_QUERY_MAX_CHARS = 100;
/** 2回目に渡す1件の抜粋の長さの上限（文脈の長さを抑える） */
export const SNIPPET_MAX_CHARS = 300;

type Obj = Record<string, unknown>;

function parseObject(text: string): Obj | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : null;
  } catch {
    return null;
  }
}

/** 最初の{から最後の}まで（コードブロックや前置きで囲まれたJSONを拾う）。 */
function innerBraces(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start !== -1 && end > start ? text.slice(start, end + 1) : "";
}

/** ```で囲まれていれば、中身だけにする。 */
function stripFences(text: string): string {
  const m = text.match(/^```[\w-]*\s*\n?([\s\S]*?)\n?```$/);
  return (m?.[1] ?? text).trim();
}

/** 生の出力を読み、オブジェクトと「そのままJSONとして読めたか」を返す。 */
function readObject(raw: string): { text: string; obj: Obj | null; strict: boolean } {
  const text = raw.trim();
  const strict = parseObject(text);
  return { text, obj: strict ?? parseObject(innerBraces(text)), strict: strict !== null };
}

/**
 * LLMの生の出力を`{say, emotion}`にする（2回目）。
 * 形式が崩れていれば本文を`say`、範囲外の感情は`neutral`として扱う（スペックシート2節）。
 */
export function parseReply(raw: string): ParsedReply {
  const { text, obj, strict } = readObject(raw);
  if (obj && typeof obj.say === "string" && obj.say.trim() !== "") {
    const say = obj.say.trim();
    if (isEmotion(obj.emotion)) return { say, emotion: obj.emotion, wellFormed: strict };
    return { say, emotion: "neutral", wellFormed: false };
  }
  return { say: stripFences(text), emotion: "neutral", wellFormed: false };
}

/** 検索語を整える。空・"null"などは調べないものとしてnull。 */
export function normalizeQuery(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const query = value.replaceAll(/\s+/g, " ").trim();
  if (query === "" || /^(null|none|undefined)$/i.test(query)) return null;
  return query.slice(0, SEARCH_QUERY_MAX_CHARS);
}

/**
 * LLMの生の出力を`{say, emotion, search}`にする（1回目）。
 * 崩れや範囲外の値は、v5と同じく本文を`say`、感情を`neutral`にし、`search`は`null`にする。
 */
export function parseFirstReply(raw: string): ParsedFirstReply {
  const parsed = parseReply(raw);
  const { obj, strict } = readObject(raw);
  const usable = obj !== null && typeof obj.say === "string" && isEmotion(obj.emotion);
  if (!usable) return { ...parsed, search: null };
  const searchValid = obj.search === null || typeof obj.search === "string";
  return {
    ...parsed,
    search: searchValid ? normalizeQuery(obj.search) : null,
    wellFormed: strict && parsed.wellFormed && searchValid,
  };
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/**
 * LLMに渡すメッセージ。システムに人格プロンプトと返事の形式、続けて直近の往復
 * （返事を得た発言だけ）、最後に今回の発言を置く。
 */
export function buildMessages(
  system: string,
  history: Turn[],
  text: string,
  contextTurns: number,
): ChatMessage[] {
  const answered = history.filter((t) => t.reply !== undefined);
  const recent = contextTurns > 0 ? answered.slice(-contextTurns) : [];
  const messages: ChatMessage[] = [{ role: "system", content: system }];
  for (const turn of recent) {
    messages.push({ role: "user", content: turn.text });
    const { say, emotion } = turn.reply ?? { say: "", emotion: "neutral" };
    messages.push({ role: "assistant", content: JSON.stringify({ say, emotion }) });
  }
  messages.push({ role: "user", content: text });
  return messages;
}

/** システムプロンプトの部品（文面は*.mdから読む）。 */
export type PromptSet = {
  /** 自己認識と人格（persona_self.md→persona.md。どちらもなければnull） */
  persona: string | null;
  /** 1回目の返事の形式 */
  firstFormat: string;
  /** 2回目の返事の形式 */
  finalFormat: string;
  /** 質問のループを防ぐ指示 */
  antiLoop: string;
  /** 調べた結果（{query}・{results}を埋める） */
  results: string;
  /** 検索の失敗（{query}を埋める） */
  searchFailed: string;
};

async function readPromptFile(name: string): Promise<string> {
  const text = await Bun.file(new URL(`./${name}`, import.meta.url)).text();
  return text.replaceAll("{emotions}", EMOTIONS.join(", ")).trim();
}

/** 人格プロンプトと、このフォルダの文面を読む。 */
export async function loadPromptSet(persona: string | null): Promise<PromptSet> {
  return {
    persona: persona?.trim() || null,
    firstFormat: await readPromptFile("reply_format.md"),
    finalFormat: await readPromptFile("reply_format_final.md"),
    antiLoop: await readPromptFile("anti_loop.md"),
    results: await readPromptFile("search_results.md"),
    searchFailed: await readPromptFile("search_failed.md"),
  };
}

const joinParts = (parts: (string | null | false)[]) =>
  parts.filter((p): p is string => typeof p === "string" && p !== "").join("\n\n");

/** 1回目のシステムプロンプト。 */
export function firstSystemPrompt(set: PromptSet, opts: ReplyOptions): string {
  return joinParts([set.persona, opts.antiLoop && set.antiLoop, set.firstFormat]);
}

/** 検索結果の抜粋を、番号つきの段落にする。 */
export function formatResults(results: SearchResult[]): string {
  return results
    .map((r, i) => {
      const snippet =
        r.snippet.length > SNIPPET_MAX_CHARS
          ? `${r.snippet.slice(0, SNIPPET_MAX_CHARS)}…`
          : r.snippet;
      return `[${i + 1}] ${r.title}\n${snippet}`;
    })
    .join("\n\n");
}

/** 2回目のシステムプロンプト。resultsがnull（検索の失敗）なら、分からないことは分からないと言う指示。 */
export function finalSystemPrompt(
  set: PromptSet,
  opts: ReplyOptions,
  query: string,
  results: SearchResult[] | null,
): string {
  // 結果が0件のときも、分からないことは分からないと言わせる。
  const failed = results === null || results.length === 0;
  const values: Record<string, string> = {
    query,
    results: failed ? "" : formatResults(results),
  };
  // 1回で置き換え、値は関数で返す（検索語・抜粋の中の「{query}」「$&」などを読み替えない）。
  const block = (failed ? set.searchFailed : set.results).replace(
    /\{(query|results)\}/g,
    (_, key: string) => values[key] ?? "",
  );
  return joinParts([set.persona, opts.antiLoop && set.antiLoop, set.finalFormat, block]);
}
