// 対話の比較（scripts/bench_dialogue.ts）の設定の読み込みと集計。
// 検索の判断（出すべき質問で出したか、出すべきでない質問で出さなかったか）、
// 複数ターンの台本の集計（質問で終わった割合、同じ型の質問が続いた回数）、考えた時間の要約。

import type { LlmConfig } from "../../apps/backend/src/config.ts";
import { endsWithQuestion } from "../../apps/backend/src/dialogue/anti_loop.ts";

/** 接続先。name・baseUrlのほかは、書かなければbackendのllmの値。matchは読み込み中のモデルの確かめに使う */
export type BenchTarget = { name: string; match?: string } & Partial<LlmConfig>;
export type BenchScript = { name: string; turns: string[] };
export type QuestionType = { name: string; pattern: string };

export type BenchConfig = {
  targets: BenchTarget[];
  /** 形式と時間を見る、ふつうの質問 */
  questions: string[];
  /** 検索の判断 */
  search: { should: string[]; shouldNot: string[] };
  /** 自己認識を問う質問 */
  self: string[];
  /** 複数ターンの台本 */
  scripts: BenchScript[];
  /** 質問の型（上から順に、最後の文が正規表現に合ったものにする。どれにも合わなければ「その他」） */
  questionTypes: QuestionType[];
};

const isStrArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** 設定の形を確かめる。崩れていれば、どの項目かを示す例外を投げる。 */
export function parseBenchConfig(raw: unknown): BenchConfig {
  const v = (raw ?? {}) as Record<string, unknown>;
  const fail = (path: string, expected: string) => {
    throw new Error(`bench config: ${path} must be ${expected}`);
  };
  const targets = v.targets;
  if (
    !Array.isArray(targets) ||
    !targets.every(
      (t) =>
        typeof t?.name === "string" &&
        typeof t?.baseUrl === "string" &&
        (t.match === undefined || typeof t.match === "string"),
    )
  ) {
    fail("targets", "an array of {name, baseUrl, match?}");
  }
  if (new Set((targets as BenchTarget[]).map((t) => t.name)).size !== (targets as []).length) {
    fail("targets", "an array with unique names");
  }
  if (!isStrArray(v.questions)) fail("questions", "an array of strings");
  const search = v.search as Record<string, unknown> | undefined;
  if (!isStrArray(search?.should)) fail("search.should", "an array of strings");
  if (!isStrArray(search?.shouldNot)) fail("search.shouldNot", "an array of strings");
  if (!isStrArray(v.self)) fail("self", "an array of strings");
  const scripts = v.scripts;
  if (
    !Array.isArray(scripts) ||
    !scripts.every((s) => typeof s?.name === "string" && isStrArray(s?.turns))
  ) {
    fail("scripts", "an array of {name, turns}");
  }
  const types = v.questionTypes;
  if (
    !Array.isArray(types) ||
    !types.every((t) => typeof t?.name === "string" && typeof t?.pattern === "string")
  ) {
    fail("questionTypes", "an array of {name, pattern}");
  }
  for (const t of types as QuestionType[]) {
    try {
      new RegExp(t.pattern, "u");
    } catch {
      fail(`questionTypes.${t.name}.pattern`, "a valid regular expression");
    }
  }
  return v as unknown as BenchConfig;
}

/** 読み込み中のモデルの名前（llama-serverの/v1/modelsのid）に、接続先のmatch（なければmodel）が含まれるか。 */
export function modelMatches(target: BenchTarget, model: string, loadedIds: string[]): boolean {
  const needle = (target.match ?? model).toLowerCase();
  return loadedIds.some((id) => id.toLowerCase().includes(needle));
}

/** 返事の最後の文（句点・感嘆符・疑問符で区切る）。 */
export function lastSentence(say: string): string {
  const sentences = say
    .trim()
    .split(/(?<=[。．.！!？?])/u)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return sentences.at(-1) ?? "";
}

export const OTHER_TYPE = "その他";

/** 質問で終わる返事の、質問の型（質問で終わらなければnull）。 */
export function questionType(say: string, types: QuestionType[]): string | null {
  if (!endsWithQuestion(say)) return null;
  const last = lastSentence(say);
  return types.find((t) => new RegExp(t.pattern, "u").test(last))?.name ?? OTHER_TYPE;
}

/** 台本の1ターンの結果。 */
export type ScriptTurn = {
  input: string;
  antiLoop: boolean;
  search: string | null;
  /** 返事（失敗したときはnull） */
  say: string | null;
  questionType: string | null;
  thinkingMs: number | null;
  error: string | null;
};

export type ScriptStats = {
  replies: number;
  /** 質問で終わった返事の数 */
  questions: number;
  /** 質問で終わった割合（返事がなければnull） */
  questionRatio: number | null;
  /** 続けて同じ型の質問で終わった回数（隣り合う2つの返事の組の数） */
  sameTypeRuns: number;
  /** 質問のループを防ぐ指示を足した数 */
  antiLoops: number;
};

export function scriptStats(turns: ScriptTurn[]): ScriptStats {
  const replied = turns.filter((t) => t.say !== null);
  const questions = replied.filter((t) => t.questionType !== null).length;
  let sameTypeRuns = 0;
  for (let i = 1; i < replied.length; i++) {
    const a = replied[i - 1]?.questionType ?? null;
    const b = replied[i]?.questionType ?? null;
    if (a !== null && a === b) sameTypeRuns++;
  }
  return {
    replies: replied.length,
    questions,
    questionRatio: replied.length === 0 ? null : questions / replied.length,
    sameTypeRuns,
    antiLoops: turns.filter((t) => t.antiLoop).length,
  };
}

/** 検索の判断の1件。 */
export type SearchJudgement = { expected: boolean; search: string | null; error: string | null };

/** 検索の判断の集計。正しかった数と、判断できた（失敗しなかった）数。 */
export function judgeSearch(rows: SearchJudgement[]): {
  should: { correct: number; total: number };
  shouldNot: { correct: number; total: number };
} {
  const count = (expected: boolean) => {
    const answered = rows.filter((r) => r.expected === expected && r.error === null);
    const correct = answered.filter((r) => (r.search !== null) === expected).length;
    return { correct, total: answered.length };
  };
  return { should: count(true), shouldNot: count(false) };
}

/** 時間の要約（中央値・平均・最大）。 */
export function timeStats(times: (number | null)[]): {
  median: number | null;
  mean: number | null;
  max: number | null;
} {
  const sorted = times.filter((t): t is number => t !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return { median: null, mean: null, max: null };
  return {
    median: sorted[Math.floor((sorted.length - 1) / 2)] ?? null,
    mean: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    max: sorted.at(-1) ?? null,
  };
}
