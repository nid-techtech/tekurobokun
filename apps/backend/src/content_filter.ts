// ContentFilter：入力と返事の禁止語の検査（imple 3節・4節、スペックシート2節）。
// 引っかかったら定型の返事に差し替える。入力が引っかかった場合は、LLMに渡さない（ConversationSession）。
//
// 禁止語リストと定型の返事は config/filter.default.json（＋filter.local.json）に書く。
// 照合は、全角・半角と大文字・小文字、空白の違いを無視した部分一致で行う（カタカナとひらがなは区別する）。
// 音声入力（ディクテーション）の表記の揺れでも抜けにくくするため。

import { type Emotion, isEmotion } from "@tekurobokun/protocol";
import { CONFIG_DIR, loadJsonConfig } from "./config.ts";

export type FilterReply = { say: string; emotion: Emotion };

export type FilterResult = { hit: boolean; replacement?: FilterReply };

export interface ContentFilter {
  check(text: string): FilterResult;
}

export type FilterConfig = {
  /** 禁止語。1語でも含めば差し替える */
  words: string[];
  /** 定型の返事。引っかかるたびに順に使う */
  replies: FilterReply[];
};

class FilterConfigError extends Error {}

/**
 * 照合のための正規化：NFKC（全角英数→半角、半角カナ→全角など）、小文字、空白の除去。
 * カタカナとひらがなは同一視しない（カタカナの語がひらがなの普通の文に当たるため。例：「イク」と「いくつ」）。
 */
export function normalizeForFilter(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

export class WordListFilter implements ContentFilter {
  private readonly words: string[];
  private next = 0;

  constructor(private readonly config: FilterConfig) {
    // 正規化すると空になる語（空白だけなど）は、すべての文に当たってしまうので除く。
    this.words = [...new Set(config.words.map(normalizeForFilter).filter((w) => w !== ""))];
  }

  /** 当たった禁止語（正規化したもの）。当たらなければnull。 */
  match(text: string): string | null {
    const normalized = normalizeForFilter(text);
    return this.words.find((w) => normalized.includes(w)) ?? null;
  }

  check(text: string): FilterResult {
    if (this.match(text) === null) return { hit: false };
    const { replies } = this.config;
    const reply = replies[this.next++ % replies.length];
    return { hit: true, replacement: reply ? { ...reply } : undefined };
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** 設定の形を確かめる。崩れていれば、どの項目かを示す例外を投げる。 */
export function parseFilterConfig(raw: unknown): FilterConfig {
  if (!isObj(raw)) throw new FilterConfigError("filter: config must be an object");
  const { words, replies } = raw;
  if (!Array.isArray(words) || !words.every((w) => typeof w === "string")) {
    throw new FilterConfigError("filter: words must be an array of strings");
  }
  if (!Array.isArray(replies) || replies.length === 0) {
    throw new FilterConfigError("filter: replies must be a non-empty array");
  }
  const parsed = replies.map((r, i) => {
    if (!isObj(r) || typeof r.say !== "string" || r.say.trim() === "") {
      throw new FilterConfigError(`filter: replies[${i}].say must be a non-empty string`);
    }
    if (!isEmotion(r.emotion)) {
      throw new FilterConfigError(`filter: replies[${i}].emotion must be one of the emotions`);
    }
    return { say: r.say.trim(), emotion: r.emotion };
  });
  return { words: [...words], replies: parsed };
}

export async function loadFilterConfig(dir = CONFIG_DIR): Promise<FilterConfig> {
  return parseFilterConfig(await loadJsonConfig("filter", dir));
}
