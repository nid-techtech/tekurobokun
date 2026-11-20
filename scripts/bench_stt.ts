// 音声認識の比較のスクリプト。録音のセットを、設定の`stt.bench.models`のモデルごとに
// `whisper-server`を起動し直して流し、認識結果・正解との文字の誤り率・かかった時間・
// 捨てた数（理由別）を一覧にする。捨てる決まり文句としきい値は、設定の`stt.whisper`のとおり。
//
//   bun scripts/bench_stt.ts [--model 名前] [--exe whisper-serverのパス] [--models-dir フォルダ]
//                            [--data 録音のフォルダ] [--timeout-ms 1回の上限] [--gpu-memory]
//                            [--no-vad] [--logprob-threshold しきい値]
//
// 録音のセット：`data/stt_bench/`に、16kHzモノラルのWAV（`名前.wav`）と、正解の文（`名前.txt`、UTF-8）を
// 同じ名前で置く。無音・雑音だけの録音は、`名前.txt`を空にする（何も出さないのが正しい）。
// 実行ファイルとモデルのフォルダは、設定`stt.bench`（`config/backend.local.json`）か、引数で渡す。
// `--timeout-ms`：1回の認識を待つ上限（初期値60000。本番の`stt.timeoutMs`より長く取り、遅いモデルも測れるようにする）。
// `--gpu-memory`：Windowsの性能カウンターで、専用GPUメモリの増え方を測る（大きい方のアダプターの値）。
// VAD：設定`stt.bench.vadModel`（`modelsDir`からの相対か絶対）があれば、`--vad -vm`を付けて起動する。
//   `--no-vad`でVADなしにする。VADのしきい値などは`stt.bench.extraArgs`（例：`["-vt", "0.6"]`）で渡す。
// `--logprob-threshold`：設定の`stt.whisper.logprobThreshold`の代わりに使うしきい値（0以下）。
// 結果は`logs/bench/{日時}_stt.md`に書き、要約を表示する。

import { mkdirSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { loadBackendConfig, REPO_ROOT } from "../apps/backend/src/config.ts";
import { WhisperSpeechRecognizer } from "../apps/backend/src/stt/whisper.ts";
import {
  characterErrorRate,
  logprobRange,
  type ModelSummary,
  normalizeForCer,
  type SampleResult,
  summarize,
} from "./lib/stt_bench.ts";

type Args = {
  model: string | null;
  exe: string | null;
  modelsDir: string | null;
  data: string;
  timeoutMs: number;
  gpuMemory: boolean;
  noVad: boolean;
  logprobThreshold: number | null;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    model: null,
    exe: null,
    modelsDir: null,
    data: `${REPO_ROOT}data/stt_bench`,
    timeoutMs: 60_000,
    gpuMemory: false,
    noVad: false,
    logprobThreshold: null,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model") args.model = argv[++i] ?? null;
    else if (argv[i] === "--exe") args.exe = argv[++i] ?? null;
    else if (argv[i] === "--models-dir") args.modelsDir = argv[++i] ?? null;
    else if (argv[i] === "--data") args.data = argv[++i] ?? args.data;
    else if (argv[i] === "--timeout-ms") {
      const v = Number.parseInt(argv[++i] ?? "", 10);
      if (!(v > 0)) throw new Error("--timeout-ms must be a positive integer");
      args.timeoutMs = v;
    } else if (argv[i] === "--gpu-memory") args.gpuMemory = true;
    else if (argv[i] === "--no-vad") args.noVad = true;
    else if (argv[i] === "--logprob-threshold") {
      const v = Number.parseFloat(argv[++i] ?? "");
      if (!(Number.isFinite(v) && v <= 0)) {
        throw new Error("--logprob-threshold must be a number of 0 or less");
      }
      args.logprobThreshold = v;
    } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

type Clip = { file: string; reference: string; wav: Uint8Array };

/** 録音と正解を読む。正解のファイル（.txt）がない録音は、警告して飛ばす。 */
async function loadClips(dir: string): Promise<Clip[]> {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith(".wav"))
      .sort();
  } catch {
    throw new Error(`録音のフォルダが読めません: ${dir}`);
  }
  const clips: Clip[] = [];
  for (const name of names) {
    const txt = Bun.file(join(dir, `${name.slice(0, -4)}.txt`));
    if (!(await txt.exists())) {
      console.warn(`warning: ${name} に正解（.txt）がないため飛ばします（無音なら空の.txtを置く）`);
      continue;
    }
    const reference = (await txt.text()).replace(/^﻿/, "").trim();
    clips.push({ file: name, reference, wav: await Bun.file(join(dir, name)).bytes() });
  }
  return clips;
}

async function isUp(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

/** 専用GPUメモリの使用量（MB）。大きい方のアダプターの値。取れなければnull。 */
async function dedicatedGpuMb(): Promise<number | null> {
  if (process.platform !== "win32") return null;
  const command =
    "(Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Usage').CounterSamples | " +
    "ForEach-Object { $_.CookedValue } | Measure-Object -Maximum | ForEach-Object { $_.Maximum }";
  try {
    const proc = Bun.spawn(
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
      {
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    const out = (await new Response(proc.stdout).text()).trim();
    const bytes = Number.parseFloat(out);
    return Number.isFinite(bytes) ? Math.round(bytes / 1024 / 1024) : null;
  } catch {
    return null;
  }
}

type ModelRun = {
  name: string;
  file: string;
  results: SampleResult[];
  errors: { file: string; message: string }[];
  summary: ModelSummary;
  loadMs: number | null;
  gpuDeltaMb: number | null;
  skipped: string | null;
};

const skippedRun = (name: string, file: string, reason: string): ModelRun => ({
  name,
  file,
  results: [],
  errors: [],
  summary: summarize([]),
  loadMs: null,
  gpuDeltaMb: null,
  skipped: reason,
});

async function runModel(
  m: { name: string; file: string },
  exe: string,
  modelsDir: string,
  clips: Clip[],
  config: Awaited<ReturnType<typeof loadBackendConfig>>,
  gpuMemory: boolean,
  timeoutMs: number,
  logDir: string,
  vadPath: string | null,
): Promise<ModelRun> {
  const modelPath = isAbsolute(m.file) || modelsDir === "" ? m.file : join(modelsDir, m.file);
  if (!(await Bun.file(modelPath).exists())) {
    console.log(`  skipped: model file not found (${modelPath})`);
    return skippedRun(m.name, m.file, `モデルのファイルがない（${modelPath}）`);
  }
  const { url, language } = config.stt.whisper;
  const { hostname, port } = new URL(url);
  const logPath = join(logDir, `whisper_server_${m.name}.log`);
  const gpuBefore = gpuMemory ? await dedicatedGpuMb() : null;

  const started = performance.now();
  const server = Bun.spawn(
    [
      exe,
      "-m",
      modelPath,
      "--host",
      hostname,
      "--port",
      port,
      "-l",
      language,
      ...(vadPath === null ? [] : ["--vad", "-vm", vadPath]),
      ...config.stt.bench.extraArgs,
    ],
    { stdout: "ignore", stderr: Bun.file(logPath) },
  );
  try {
    // モデルの読み込みを待つ（大きいモデルとGPUの初期化で時間がかかる）
    let up = false;
    for (let waited = 0; waited < 180_000 && server.exitCode === null; waited += 500) {
      if (await isUp(url)) {
        up = true;
        break;
      }
      await Bun.sleep(500);
    }
    if (!up) {
      const why =
        server.exitCode !== null
          ? `起動直後に終了（終了コード ${server.exitCode}）`
          : "起動待ちの時間切れ";
      console.log(`  skipped: ${why}（ログ: ${logPath}）`);
      return skippedRun(m.name, m.file, `${why}。ログ: ${logPath}`);
    }
    const loadMs = Math.round(performance.now() - started);

    const recognizer = new WhisperSpeechRecognizer({
      whisper: config.stt.whisper,
      timeoutMs,
    });
    // 最初の1回は、GPUの準備などで遅くなるため、測らない
    const warm = clips[0];
    if (warm) await recognizer.transcribe(warm.wav).catch(() => undefined);

    let gpuMax = gpuMemory ? await dedicatedGpuMb() : null;
    const results: SampleResult[] = [];
    const errors: { file: string; message: string }[] = [];
    for (const [i, clip] of clips.entries()) {
      process.stdout.write(`  ${i + 1}/${clips.length}\r`);
      try {
        const t = await recognizer.transcribe(clip.wav);
        results.push({
          file: clip.file,
          reference: clip.reference,
          raw: t.raw,
          text: t.text,
          discarded: t.discarded,
          logprobs: t.logprobs,
          ms: t.ms,
        });
      } catch (e) {
        errors.push({ file: clip.file, message: e instanceof Error ? e.message : String(e) });
      }
      if (gpuMemory) {
        const now = await dedicatedGpuMb();
        if (now !== null) gpuMax = Math.max(gpuMax ?? 0, now);
      }
    }
    const gpuDeltaMb = gpuMax !== null && gpuBefore !== null ? gpuMax - gpuBefore : null;
    return {
      name: m.name,
      file: m.file,
      results,
      errors,
      summary: summarize(results),
      loadMs,
      gpuDeltaMb,
      skipped: null,
    };
  } finally {
    server.kill();
    await server.exited;
  }
}

const cell = (s: string) => s.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
const num = (v: number | null) => (v === null ? "-" : `${v}`);
const pct = (v: number | null) => (v === null ? "-" : `${(v * 100).toFixed(1)}%`);
const lp = (v: number | null) => (v === null ? "-" : v.toFixed(3));

function discardText(s: ModelSummary): string {
  return `${s.discards.empty} / ${s.discards.low_logprob} / ${s.discards.hallucination}`;
}

/** 録音ごとのavg_logprob（区切りが1つなら1つ、複数なら「最小〜最大」） */
function logprobCell(logprobs: readonly number[]): string {
  const range = logprobRange(logprobs);
  if (range === null) return "-";
  return range.min === range.max ? lp(range.min) : `${lp(range.min)}〜${lp(range.max)}`;
}

type Conditions = { vad: string; extraArgs: string[]; logprobThreshold: number };

function report(
  runs: ModelRun[],
  clips: Clip[],
  stamp: string,
  gpuMemory: boolean,
  cond: Conditions,
): string {
  const speech = clips.filter((c) => normalizeForCer(c.reference) !== "").length;
  const lines = [`# 音声認識の比較 ${stamp}`, ""];
  lines.push(
    `録音${clips.length}件（正解のある発話${speech}件、無音・雑音${clips.length - speech}件）。誤り率は、正解のある録音の「文字の誤りの合計 ÷ 正解の文字数の合計」（空白・句読点・記号と全角・半角の違いは数えない）。`,
    "",
    `条件：VAD ${cond.vad}、追加の引数 ${cond.extraArgs.length === 0 ? "なし" : `\`${cond.extraArgs.join(" ")}\``}、確からしさのしきい値（logprobThreshold）${cond.logprobThreshold}`,
    "",
    "## 要約",
    "",
    "「avg_logprob 発話の下端」は、発話の録音ごとの最大のうち最も低い値（これ以下のしきい値なら確からしさで発話を捨てない）。「雑音の上端」は、無音・雑音の録音で文が出たもの（VADを通り抜けたもの）の最大のうち最も高い値（これより大きいしきい値なら確からしさで捨てられる）。",
    "",
  );
  lines.push(
    `| モデル | 誤り率 | 中央値ms | 平均ms | 最大ms | 捨てた数（empty / low_logprob / hallucination） | 無音で文が出た | 発話を捨てた | avg_logprob 発話の下端 / 雑音の上端 | 読み込みms |${gpuMemory ? " GPUメモリ増分MB |" : ""}`,
  );
  lines.push(`|---|---|---|---|---|---|---|---|---|---|${gpuMemory ? "---|" : ""}`);
  for (const r of runs) {
    if (r.skipped) {
      lines.push(
        `| ${cell(r.name)} | ${cell(r.skipped)} | - | - | - | - | - | - | - | -${gpuMemory ? " | -" : ""} |`,
      );
      continue;
    }
    const s = r.summary;
    lines.push(
      `| ${cell(r.name)} | ${pct(s.cer)} | ${num(s.medianMs)} | ${num(s.meanMs)} | ${num(s.maxMs)} | ${discardText(s)} | ${s.silentRecognized}/${s.silentCount} | ${s.speechDiscarded}/${s.speechCount} | ${lp(s.speechLogprobFloor)} / ${lp(s.silentLogprobCeiling)} | ${num(r.loadMs)}${gpuMemory ? ` | ${num(r.gpuDeltaMb)}` : ""} |`,
    );
  }

  // 決まり文句の候補：無音・雑音の録音に対して、モデルが出した文
  const phantoms = new Map<string, Set<string>>();
  for (const r of runs) {
    for (const x of r.results) {
      if (normalizeForCer(x.reference) !== "" || x.raw.trim() === "") continue;
      const key = x.raw.trim();
      if (!phantoms.has(key)) phantoms.set(key, new Set());
      phantoms.get(key)?.add(r.name);
    }
  }
  lines.push("", "## 無音・雑音の録音に出た文（決まり文句の候補）", "");
  if (phantoms.size === 0) {
    lines.push("なし");
  } else {
    lines.push("| 文 | 出したモデル |", "|---|---|");
    for (const [text, models] of phantoms)
      lines.push(`| ${cell(text)} | ${[...models].join(", ")} |`);
  }

  for (const r of runs) {
    if (r.skipped) continue;
    lines.push("", `## ${r.name}`, "", `モデル: ${r.file}`, "");
    lines.push(
      "| 録音 | 正解 | 認識結果 | 誤り率 | ms | avg_logprob | 捨てた理由 |",
      "|---|---|---|---|---|---|---|",
    );
    for (const x of r.results) {
      const shown = x.discarded === null ? x.text : `（捨てた）${x.raw.trim()}`;
      lines.push(
        `| ${cell(x.file)} | ${cell(x.reference)} | ${cell(shown)} | ${pct(characterErrorRate(x.reference, x.text))} | ${x.ms} | ${logprobCell(x.logprobs)} | ${x.discarded ?? ""} |`,
      );
    }
    for (const e of r.errors) {
      lines.push(`| ${cell(e.file)} | | 失敗：${cell(e.message)} | | | | |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

const args = parseArgs(process.argv.slice(2));
const loaded = await loadBackendConfig();
const config = {
  ...loaded,
  stt: {
    ...loaded.stt,
    whisper: {
      ...loaded.stt.whisper,
      logprobThreshold: args.logprobThreshold ?? loaded.stt.whisper.logprobThreshold,
    },
  },
};
const bench = config.stt.bench;
const exe = args.exe ?? bench.executable;
const modelsDir = args.modelsDir ?? bench.modelsDir;
let vadPath: string | null = null;
if (!args.noVad && bench.vadModel !== "") {
  vadPath =
    isAbsolute(bench.vadModel) || modelsDir === ""
      ? bench.vadModel
      : join(modelsDir, bench.vadModel);
  if (!(await Bun.file(vadPath).exists())) {
    throw new Error(
      `VADのモデルが見つかりません: ${vadPath}（setup_whisper.ps1で取得するか、--no-vad で流す）`,
    );
  }
}
if (exe === "") {
  throw new Error(
    "whisper-serverの実行ファイルが未設定です（--exe か、config/backend.local.json の stt.bench.executable）",
  );
}
if (!(await Bun.file(exe).exists())) throw new Error(`whisper-serverが見つかりません: ${exe}`);
const models = bench.models.filter((m) => args.model === null || m.name === args.model);
if (models.length === 0) throw new Error(`stt.bench.models に ${args.model} がありません`);

const clips = await loadClips(args.data);
if (clips.length === 0)
  throw new Error(`録音がありません（${args.data}に 名前.wav と 名前.txt を置く）`);
if (await isUp(config.stt.whisper.url)) {
  throw new Error(
    `${config.stt.whisper.url} で whisper-server がすでに動いています。止めてから実行してください`,
  );
}

const now = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString();
const stamp = now.slice(2, 19).replaceAll(/[-T:]/g, "");
const logDir = `${REPO_ROOT}logs/bench/`;
mkdirSync(logDir, { recursive: true });

console.log(`VAD: ${vadPath ?? "なし"}、logprobThreshold: ${config.stt.whisper.logprobThreshold}`);
const runs: ModelRun[] = [];
for (const m of models) {
  console.log(`${m.name}: ${m.file}`);
  const run = await runModel(
    m,
    exe,
    modelsDir,
    clips,
    config,
    args.gpuMemory,
    args.timeoutMs,
    logDir,
    vadPath,
  );
  runs.push(run);
  if (!run.skipped) {
    const s = run.summary;
    console.log(
      `  誤り率 ${pct(s.cer)}、中央値 ${num(s.medianMs)}ms、捨てた ${discardText(s)}、無音で文が出た ${s.silentRecognized}/${s.silentCount}、発話を捨てた ${s.speechDiscarded}/${s.speechCount}、avg_logprob 発話の下端 ${lp(s.speechLogprobFloor)} / 雑音の上端 ${lp(s.silentLogprobCeiling)}${run.errors.length > 0 ? `、失敗 ${run.errors.length}` : ""}${run.gpuDeltaMb !== null ? `、GPUメモリ +${run.gpuDeltaMb}MB` : ""}`,
    );
  }
}

const path = `${logDir}${stamp}_stt.md`;
await Bun.write(
  path,
  report(runs, clips, stamp, args.gpuMemory, {
    vad: vadPath === null ? "なし" : `あり（${bench.vadModel}）`,
    extraArgs: bench.extraArgs,
    logprobThreshold: config.stt.whisper.logprobThreshold,
  }),
);
console.log(`report: ${path}`);
