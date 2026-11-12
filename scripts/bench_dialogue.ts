// モデル比較のスクリプト。同じ質問のセットを接続先ごとに投げ、考えた時間、形式の崩れの数、
// 返事を一覧にする。質問は1つずつ履歴なしで投げ、人格プロンプトと返事の形式はバックエンドと同じものを使う。
//
//   bun scripts/bench_dialogue.ts [--repeat N] [--target 名前]
//
// 接続先と質問は config/bench.default.json（config/bench.local.json で上書き）。
// 接続先ごとに baseUrl・model のほか、jsonSchema・maxTokens・temperature を変えられる。
// 結果は logs/bench/{日時}.md に書き、要約を表示する。

import { mkdirSync } from "node:fs";
import {
  type LlmConfig,
  loadBackendConfig,
  loadJsonConfig,
  loadPersona,
  REPO_ROOT,
} from "../apps/backend/src/config.ts";
import { buildSystemPrompt, parseReply } from "../apps/backend/src/dialogue/engine.ts";
import { LlamaDialogueEngine } from "../apps/backend/src/dialogue/llama.ts";

type Target = { name: string } & Partial<LlmConfig>;
type BenchConfig = { targets: Target[]; questions: string[] };

type Row = {
  question: string;
  thinkingMs: number | null;
  wellFormed: boolean;
  emotion: string;
  say: string;
  raw: string | null;
  error: string | null;
};

function parseArgs(argv: string[]): { repeat: number; target: string | null } {
  let repeat = 1;
  let target: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repeat") repeat = Math.max(1, Number.parseInt(argv[++i] ?? "1", 10) || 1);
    else if (argv[i] === "--target") target = argv[++i] ?? null;
  }
  return { repeat, target };
}

function parseBenchConfig(raw: unknown): BenchConfig {
  const v = raw as Partial<BenchConfig>;
  const targetsOk =
    Array.isArray(v.targets) &&
    v.targets.every((t) => typeof t?.name === "string" && typeof t?.baseUrl === "string");
  if (!targetsOk) throw new Error("bench config: targets must have name and baseUrl");
  if (!Array.isArray(v.questions) || !v.questions.every((q) => typeof q === "string")) {
    throw new Error("bench config: questions must be an array of strings");
  }
  return v as BenchConfig;
}

async function isHealthy(baseUrl: string): Promise<boolean> {
  try {
    return (await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

async function runTarget(llm: LlmConfig, system: string, questions: string[]): Promise<Row[]> {
  const engine = new LlamaDialogueEngine({ ...llm, contextTurns: 0 }, system);
  const rows: Row[] = [];
  for (const [i, question] of questions.entries()) {
    process.stdout.write(`  ${i + 1}/${questions.length}\r`);
    try {
      const result = await engine.reply([], question);
      const parsed = parseReply(result.raw ?? "");
      rows.push({
        question,
        thinkingMs: result.thinkingMs,
        wellFormed: parsed.wellFormed,
        emotion: result.emotion,
        say: result.say,
        raw: result.raw,
        error: null,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      rows.push({
        question,
        thinkingMs: null,
        wellFormed: false,
        emotion: "",
        say: "",
        raw: null,
        error,
      });
    }
  }
  return rows;
}

function stats(rows: Row[]) {
  const times = rows
    .map((r) => r.thinkingMs)
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b);
  const median = times.length === 0 ? null : (times[Math.floor((times.length - 1) / 2)] ?? null);
  const mean =
    times.length === 0 ? null : Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  return {
    total: rows.length,
    errors: rows.filter((r) => r.error !== null).length,
    malformed: rows.filter((r) => r.error === null && !r.wellFormed).length,
    median,
    mean,
    max: times.at(-1) ?? null,
  };
}

const cell = (s: string) => s.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
const ms = (v: number | null) => (v === null ? "-" : `${v}`);

function report(
  results: { target: Target; llm: LlmConfig; rows: Row[]; skipped: string | null }[],
  stamp: string,
): string {
  const lines = [`# モデル比較 ${stamp}`, "", "## 要約", ""];
  lines.push("| 接続先 | モデル | 件数 | 失敗 | 形式の崩れ | 中央値ms | 平均ms | 最大ms |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const { target, llm, rows, skipped } of results) {
    if (skipped) {
      lines.push(
        `| ${cell(target.name)} | ${cell(llm.model)} | - | ${cell(skipped)} | - | - | - | - |`,
      );
      continue;
    }
    const s = stats(rows);
    lines.push(
      `| ${cell(target.name)} | ${cell(llm.model)} | ${s.total} | ${s.errors} | ${s.malformed} | ${ms(s.median)} | ${ms(s.mean)} | ${ms(s.max)} |`,
    );
  }
  for (const { target, llm, rows } of results) {
    if (rows.length === 0) continue;
    lines.push("", `## ${target.name}`, "");
    lines.push(
      `${llm.baseUrl}、model=${llm.model}、jsonSchema=${llm.jsonSchema}、maxTokens=${llm.maxTokens}、temperature=${llm.temperature}`,
      "",
    );
    lines.push("| # | 質問 | 考えた時間ms | 形式 | emotion | say |");
    lines.push("|---|---|---|---|---|---|");
    rows.forEach((r, i) => {
      const form = r.error ? `失敗：${r.error}` : r.wellFormed ? "OK" : "崩れ";
      const say = r.error ? "" : r.wellFormed ? r.say : `${r.say}（生：${r.raw ?? ""}）`;
      lines.push(
        `| ${i + 1} | ${cell(r.question)} | ${ms(r.thinkingMs)} | ${cell(form)} | ${r.emotion} | ${cell(say)} |`,
      );
    });
  }
  return `${lines.join("\n")}\n`;
}

const args = parseArgs(process.argv.slice(2));
const backend = await loadBackendConfig();
const bench = parseBenchConfig(await loadJsonConfig("bench"));
const persona = await loadPersona();
if (persona === null) console.warn("warning: config/persona.md not found; using reply format only");
const system = await buildSystemPrompt(persona);
const questions = Array.from({ length: args.repeat }, () => bench.questions).flat();
const targets = bench.targets.filter((t) => args.target === null || t.name === args.target);
if (targets.length === 0) throw new Error(`no target named ${args.target}`);

const results = [];
for (const target of targets) {
  const { name: _name, ...override } = target;
  const llm: LlmConfig = { ...backend.llm, ...override };
  llm.baseUrl = llm.baseUrl.replace(/\/+$/, "");
  console.log(`${target.name}: ${llm.baseUrl} (${llm.model})`);
  if (!(await isHealthy(llm.baseUrl))) {
    console.log("  skipped: /health did not respond");
    results.push({ target, llm, rows: [], skipped: "/healthに応答なし" });
    continue;
  }
  const rows = await runTarget(llm, system, questions);
  const s = stats(rows);
  console.log(
    `  ${s.total} questions, errors ${s.errors}, malformed ${s.malformed}, median ${ms(s.median)}ms, mean ${ms(s.mean)}ms, max ${ms(s.max)}ms`,
  );
  results.push({ target, llm, rows, skipped: null });
}

const now = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString();
const stamp = now.slice(2, 19).replaceAll(/[-T:]/g, "");
const dir = `${REPO_ROOT}logs/bench/`;
mkdirSync(dir, { recursive: true });
const path = `${dir}${stamp}.md`;
await Bun.write(path, report(results, stamp));
console.log(`report: ${path}`);
