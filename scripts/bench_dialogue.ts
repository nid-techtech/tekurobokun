// 対話の比較のスクリプト（スペックシート「対話の比較」）。同じ質問のセットを接続先ごとに投げ、
// 考えた時間・形式の崩れ・検索の判断・自己認識の返事・複数ターンの台本の様子を一覧にする。
// 人格プロンプト（persona_self.md→persona.md）と返事の形式は、バックエンドと同じものを使う。
//
//   bun scripts/bench_dialogue.ts [--target 名前[,名前…]] [--only 区分[,区分…]] [--repeat N]
//                                 [--search none|stub|tavily] [--no-model-check]
//
//   --only    general（ふつうの質問）・search（検索の判断）・self（自己認識）・scripts（台本）。既定はすべて
//   --search  台本で検索語が出たときの2回目に渡す結果。none（既定）は検索の失敗として問い合わせる。
//             stubは決まった抜粋、tavilyは実際に検索する（data/usage.jsonの回数に数える）
//   --no-model-check  読み込み中のモデルを確かめない
//
// 接続先と質問は config/bench.default.json（config/bench.local.json で上書き）。
// 接続先ごとに baseUrl・model のほか、jsonSchema・maxTokens・temperature・contextTurns を変えられる。
// llama-serverの/v1/modelsのidに、接続先のmatch（なければmodel）が含まれなければ、そのモデルは
// 読み込まれていないものとして飛ばす（1つのllama-serverでモデルを入れ替えて流すため。開発機にないモデルも飛ぶ）。
// 結果は logs/bench/{日時}.md に書き、要約を表示する。

import { mkdirSync } from "node:fs";
import type { Emotion, Turn } from "@tekurobokun/protocol";
import {
  type LlmConfig,
  loadBackendConfig,
  loadJsonConfig,
  loadPersona,
  REPO_ROOT,
} from "../apps/backend/src/config.ts";
import { shouldAntiLoop } from "../apps/backend/src/dialogue/anti_loop.ts";
import { loadPromptSet, parseFirstReply } from "../apps/backend/src/dialogue/engine.ts";
import { LlamaDialogueEngine } from "../apps/backend/src/dialogue/llama.ts";
import type { SearchResult, WebSearcher } from "../apps/backend/src/search/engine.ts";
import { DEFAULT_STUB_SEARCH_DATA, StubWebSearcher } from "../apps/backend/src/search/stub.ts";
import { TavilyWebSearcher } from "../apps/backend/src/search/tavily.ts";
import { SearchUsage } from "../apps/backend/src/search/usage.ts";
import {
  type BenchConfig,
  type BenchTarget,
  judgeSearch,
  modelMatches,
  parseBenchConfig,
  questionType,
  type ScriptTurn,
  scriptStats,
  timeStats,
} from "./lib/dialogue_bench.ts";

const SECTIONS = ["general", "search", "self", "scripts"] as const;
type Section = (typeof SECTIONS)[number];
type SearchMode = "none" | "stub" | "tavily";

type Args = {
  targets: string[] | null;
  only: Section[];
  repeat: number;
  search: SearchMode;
  modelCheck: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    targets: null,
    only: [...SECTIONS],
    repeat: 1,
    search: "none",
    modelCheck: true,
  };
  const list = (v: string | undefined) => (v ?? "").split(",").filter((s) => s !== "");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repeat") args.repeat = Math.max(1, Number.parseInt(argv[++i] ?? "1", 10) || 1);
    else if (a === "--target") args.targets = list(argv[++i]);
    else if (a === "--only") {
      const only = list(argv[++i]);
      const bad = only.filter((s) => !(SECTIONS as readonly string[]).includes(s));
      if (bad.length > 0) {
        throw new Error(`--only: unknown ${bad.join(", ")} (${SECTIONS.join("|")})`);
      }
      args.only = only as Section[];
    } else if (a === "--search") {
      const mode = argv[++i];
      if (mode !== "none" && mode !== "stub" && mode !== "tavily") {
        throw new Error("--search must be none, stub or tavily");
      }
      args.search = mode;
    } else if (a === "--no-model-check") args.modelCheck = false;
    else throw new Error(`unknown option ${a}`);
  }
  return args;
}

/** 1問ずつ（履歴なし）の結果。 */
type Row = {
  question: string;
  thinkingMs: number | null;
  wellFormed: boolean;
  emotion: Emotion | "";
  say: string;
  search: string | null;
  raw: string | null;
  error: string | null;
};

type ScriptResult = { name: string; turns: ScriptTurn[] };

type TargetResult = {
  target: BenchTarget;
  llm: LlmConfig;
  skipped: string | null;
  /** 読み込み中のモデル（/v1/modelsのid。確かめなかったらnull） */
  loaded: string[] | null;
  general: Row[];
  should: Row[];
  shouldNot: Row[];
  self: Row[];
  scripts: ScriptResult[];
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function isHealthy(baseUrl: string): Promise<boolean> {
  try {
    return (await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

/** llama-serverの/v1/modelsのid。取れなければnull。 */
async function loadedModels(baseUrl: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    const ids = (body.data ?? [])
      .map((d) => d.id)
      .filter((id): id is string => typeof id === "string");
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

async function askOnce(engine: LlamaDialogueEngine, question: string): Promise<Row> {
  try {
    const r = await engine.reply([], question, { antiLoop: false });
    return {
      question,
      thinkingMs: r.thinkingMs,
      wellFormed: parseFirstReply(r.raw ?? "").wellFormed,
      emotion: r.emotion,
      say: r.say,
      search: r.search,
      raw: r.raw,
      error: null,
    };
  } catch (e) {
    return {
      question,
      thinkingMs: null,
      wellFormed: false,
      emotion: "",
      say: "",
      search: null,
      raw: null,
      error: errorText(e),
    };
  }
}

async function askAll(
  engine: LlamaDialogueEngine,
  label: string,
  questions: string[],
): Promise<Row[]> {
  const rows: Row[] = [];
  for (const [i, q] of questions.entries()) {
    process.stdout.write(`  ${label} ${i + 1}/${questions.length}\r`);
    rows.push(await askOnce(engine, q));
  }
  return rows;
}

/** 台本を1つ流す。検索語が出たら、searcherの結果（なければ失敗）で2回目を問い合わせる。 */
async function runScript(
  engine: LlamaDialogueEngine,
  inputs: string[],
  searcher: WebSearcher | null,
  threshold: number,
  config: BenchConfig,
): Promise<ScriptTurn[]> {
  const history: Turn[] = [];
  const turns: ScriptTurn[] = [];
  for (const [i, input] of inputs.entries()) {
    const replies = history.flatMap((t) => (t.reply ? [t.reply.say] : []));
    const antiLoop = shouldAntiLoop(replies, threshold);
    const turn: Turn = {
      id: `bench-${i}`,
      at: new Date().toISOString(),
      source: "bench",
      via: "text",
      text: input,
    };
    let row: ScriptTurn;
    try {
      const first = await engine.reply(history, input, { antiLoop });
      let say = first.say;
      let emotion = first.emotion;
      let thinkingMs = first.thinkingMs;
      if (first.search !== null) {
        // バックエンドと同じく、調べた往復は前置きと検索語も履歴に載せる（buildMessagesが1回目として渡す）。
        turn.search = { query: first.search, preSay: first.say, searchMs: null, ok: null };
        let results: SearchResult[] | null = null;
        if (searcher) {
          try {
            results = (await searcher.search(first.search)).results;
          } catch {
            results = null;
          }
        }
        const second = await engine.replyWithResults(history, input, first.search, results, {
          antiLoop,
        });
        say = second.say;
        emotion = second.emotion;
        thinkingMs += second.thinkingMs;
      }
      turn.reply = { say, emotion, thinkingMs };
      row = {
        input,
        antiLoop,
        search: first.search,
        say,
        questionType: questionType(say, config.questionTypes),
        thinkingMs,
        error: null,
      };
    } catch (e) {
      row = {
        input,
        antiLoop,
        search: null,
        say: null,
        questionType: null,
        thinkingMs: null,
        error: errorText(e),
      };
    }
    history.push(turn);
    turns.push(row);
  }
  return turns;
}

// ===== 報告 =====

const cell = (s: string) => s.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
const ms = (v: number | null) => (v === null ? "-" : `${v}`);
const pct = (v: number | null) => (v === null ? "-" : `${Math.round(v * 100)}%`);
const form = (r: Row) => (r.error ? `失敗：${r.error}` : r.wellFormed ? "OK" : "崩れ");
const sayOf = (r: Row) => (r.error ? "" : r.wellFormed ? r.say : `${r.say}（生：${r.raw ?? ""}）`);

function singleRows(result: TargetResult): Row[] {
  return [...result.general, ...result.should, ...result.shouldNot, ...result.self];
}

function summaryLine(result: TargetResult): string {
  const { target, llm, skipped } = result;
  if (skipped) {
    return `| ${cell(target.name)} | ${cell(llm.model)} | ${cell(skipped)} | - | - | - | - | - | - | - | - | - |`;
  }
  const singles = singleRows(result);
  const errors = singles.filter((r) => r.error !== null).length;
  const malformed = singles.filter((r) => r.error === null && !r.wellFormed).length;
  const judged = judgeSearch([
    ...result.should.map((r) => ({ expected: true, search: r.search, error: r.error })),
    ...result.shouldNot.map((r) => ({ expected: false, search: r.search, error: r.error })),
  ]);
  const stats = scriptStats(result.scripts.flatMap((s) => s.turns));
  const sameType = result.scripts.reduce((n, s) => n + scriptStats(s.turns).sameTypeRuns, 0);
  const t = timeStats(singles.map((r) => r.thinkingMs));
  const frac = (x: { correct: number; total: number }) =>
    x.total === 0 ? "-" : `${x.correct}/${x.total}`;
  return `| ${cell(target.name)} | ${cell(llm.model)} | ${singles.length} | ${errors} | ${malformed} | ${frac(judged.should)} | ${frac(judged.shouldNot)} | ${pct(stats.questionRatio)} | ${sameType} | ${ms(t.median)} | ${ms(t.mean)} | ${ms(t.max)} |`;
}

function rowTable(lines: string[], rows: Row[], expected: boolean | null): void {
  lines.push("| # | 質問 | 考えた時間ms | 形式 | search | 判定 | emotion | say |");
  lines.push("|---|---|---|---|---|---|---|---|");
  rows.forEach((r, i) => {
    const judged =
      expected === null || r.error ? "-" : (r.search !== null) === expected ? "OK" : "NG";
    lines.push(
      `| ${i + 1} | ${cell(r.question)} | ${ms(r.thinkingMs)} | ${cell(form(r))} | ${cell(r.search ?? "")} | ${judged} | ${r.emotion} | ${cell(sayOf(r))} |`,
    );
  });
}

function report(results: TargetResult[], stamp: string, args: Args, threshold: number): string {
  const lines = [`# 対話の比較 ${stamp}`, ""];
  lines.push(
    `条件：区分=${args.only.join(",")}、くり返し=${args.repeat}、台本の検索=${args.search}、質問のループのしきい値=${threshold}`,
    "",
    "## 要約",
    "",
    "考えた時間は1問ずつの質問（ふつう・検索の判断・自己認識）の値。台本の「質問で終わった割合」と「同じ型の連続」は、台本すべての合計。",
    "",
  );
  lines.push(
    "| 接続先 | モデル | 件数 | 失敗 | 形式の崩れ | 検索すべき→した | 検索すべきでない→しなかった | 台本：質問で終わった割合 | 台本：同じ型の連続 | 中央値ms | 平均ms | 最大ms |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) lines.push(summaryLine(r));

  for (const r of results) {
    if (r.skipped) continue;
    const { target, llm } = r;
    lines.push("", `## ${target.name}`, "");
    lines.push(
      `${llm.baseUrl}、model=${llm.model}、読み込み中=${r.loaded ? r.loaded.join(", ") : "（確かめていない）"}、jsonSchema=${llm.jsonSchema}、maxTokens=${llm.maxTokens}、temperature=${llm.temperature}、contextTurns（台本）=${llm.contextTurns}`,
    );
    if (r.general.length > 0) {
      lines.push("", "### ふつうの質問", "");
      rowTable(lines, r.general, null);
    }
    if (r.should.length + r.shouldNot.length > 0) {
      lines.push("", "### 検索の判断（検索すべき）", "");
      rowTable(lines, r.should, true);
      lines.push("", "### 検索の判断（検索すべきでない）", "");
      rowTable(lines, r.shouldNot, false);
    }
    if (r.self.length > 0) {
      lines.push("", "### 自己認識", "");
      rowTable(lines, r.self, null);
    }
    for (const script of r.scripts) {
      const s = scriptStats(script.turns);
      lines.push("", `### 台本：${script.name}`, "");
      lines.push(
        `質問で終わった割合 ${pct(s.questionRatio)}（${s.questions}/${s.replies}）、同じ型の連続 ${s.sameTypeRuns}回、質問のループを防ぐ指示 ${s.antiLoops}回`,
        "",
      );
      lines.push("| # | 発言 | 指示 | search | 考えた時間ms | 質問の型 | 返事 |");
      lines.push("|---|---|---|---|---|---|---|");
      script.turns.forEach((t, i) => {
        const reply = t.error ? `失敗：${t.error}` : (t.say ?? "");
        lines.push(
          `| ${i + 1} | ${cell(t.input)} | ${t.antiLoop ? "あり" : ""} | ${cell(t.search ?? "")} | ${ms(t.thinkingMs)} | ${t.questionType ?? ""} | ${cell(reply)} |`,
        );
      });
    }
  }
  return `${lines.join("\n")}\n`;
}

// ===== 実行 =====

const args = parseArgs(process.argv.slice(2));
const backend = await loadBackendConfig();
const bench = parseBenchConfig(await loadJsonConfig("bench"));
const persona = await loadPersona();
for (const name of persona.missing) {
  console.warn(`warning: config/${name} is missing or has only headings; skipped`);
}
const prompts = await loadPromptSet(persona.text);
const threshold = backend.dialogue.questionLoopThreshold;
const repeat = <T>(items: T[]) => Array.from({ length: args.repeat }, () => items).flat();
const has = (s: Section) => args.only.includes(s);

const targets = bench.targets.filter((t) => args.targets === null || args.targets.includes(t.name));
if (targets.length === 0) throw new Error(`no target named ${args.targets?.join(", ")}`);

let searcher: WebSearcher | null = null;
if (args.search === "stub") {
  searcher = new StubWebSearcher({
    usage: new SearchUsage({ path: null }),
    data: { ...DEFAULT_STUB_SEARCH_DATA, delayMs: 0 },
    maxResults: backend.search.maxResults,
  });
} else if (args.search === "tavily") {
  const usage = new SearchUsage({ path: `${REPO_ROOT}data/usage.json` });
  await usage.load();
  searcher = new TavilyWebSearcher({ config: backend.search, usage });
}

const results: TargetResult[] = [];
for (const target of targets) {
  const { name: _name, match: _match, ...override } = target;
  const { models: _models, activeAlias: _alias, ...base } = backend.llm;
  const llm: LlmConfig = { ...base, ...override };
  llm.baseUrl = llm.baseUrl.replace(/\/+$/, "");
  const result: TargetResult = {
    target,
    llm,
    skipped: null,
    loaded: null,
    general: [],
    should: [],
    shouldNot: [],
    self: [],
    scripts: [],
  };
  results.push(result);
  console.log(`${target.name}: ${llm.baseUrl} (${llm.model})`);
  if (!(await isHealthy(llm.baseUrl))) {
    console.log("  skipped: /health did not respond");
    result.skipped = "/healthに応答なし";
    continue;
  }
  if (args.modelCheck) {
    result.loaded = await loadedModels(llm.baseUrl);
    if (result.loaded === null) {
      console.log("  warning: could not read /v1/models; running without the model check");
    } else if (!modelMatches(target, llm.model, result.loaded)) {
      console.log(`  skipped: loaded model is ${result.loaded.join(", ")}`);
      result.skipped = `別のモデルを読み込み中（${result.loaded.join(", ")}）`;
      continue;
    }
  }

  // 1問ずつは履歴なし、台本は設定の往復数。
  const single = new LlamaDialogueEngine({ llm: { ...llm, contextTurns: 0 }, prompts });
  const multi = new LlamaDialogueEngine({ llm, prompts });
  if (has("general")) result.general = await askAll(single, "general", repeat(bench.questions));
  if (has("search")) {
    result.should = await askAll(single, "search+", repeat(bench.search.should));
    result.shouldNot = await askAll(single, "search-", repeat(bench.search.shouldNot));
  }
  if (has("self")) result.self = await askAll(single, "self", repeat(bench.self));
  if (has("scripts")) {
    for (const script of repeat(bench.scripts)) {
      process.stdout.write(`  script ${script.name}\r`);
      result.scripts.push({
        name: script.name,
        turns: await runScript(multi, script.turns, searcher, threshold, bench),
      });
    }
  }
  console.log(`  ${summaryLine(result)}`);
}

const now = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString();
const stamp = now.slice(2, 19).replaceAll(/[-T:]/g, "");
const dir = `${REPO_ROOT}logs/bench/`;
mkdirSync(dir, { recursive: true });
const path = `${dir}${stamp}.md`;
await Bun.write(path, report(results, stamp, args, threshold));
console.log(`report: ${path}`);
