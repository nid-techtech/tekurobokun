// 設定ファイルの読み込み（imple 6節）。
// config/{name}.default.json をGitで管理し、同名の {name}.local.json があれば項目ごとに上書きする。
// 上書きはオブジェクトを再帰的に合わせ、配列と値はまるごと置き換える。

import { fileURLToPath } from "node:url";
import {
  type ConsoleSettings,
  LLM_ALIASES,
  type LlmAlias,
  ROBOT_SOURCE,
} from "@tekurobokun/protocol";

/** リポジトリのルート（apps/backend/src から3つ上）。 */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const CONFIG_DIR = `${REPO_ROOT}config/`;

/** モデルの別名（main・sub）ごとの、モデル名と生成のパラメータ */
export type LlmModelConfig = {
  model: string;
  maxTokens: number;
  temperature: number;
};

/** LLMへの問い合わせの設定（いまの別名のモデルの値で解決したもの） */
export type LlmConfig = LlmModelConfig & {
  /** OpenAI互換APIの接続先（末尾の / なし）。`/v1/chat/completions`と`/health`を呼ぶ */
  baseUrl: string;
  /** LLMに渡す直近の往復数 */
  contextTurns: number;
  /** JSONスキーマ制約（response_format）を使うか */
  jsonSchema: boolean;
  timeoutMs: number;
};

export type SttConfig = {
  provider: "whisper" | "stub";
  timeoutMs: number;
  whisper: {
    /** whisper-serverの接続先（末尾の / なし）。`/inference`と`/health`を呼ぶ */
    url: string;
    /** 話す言語（whisperの言語コード。翻訳はしない） */
    language: string;
    /** 結果の全体がこのどれかと一致したら捨てる決まり文句 */
    hallucinations: string[];
    /** すべての区切りで`avg_logprob`がこれを下回ったら捨てる（0以下） */
    logprobThreshold: number;
  };
  /** 音声認識の比較（scripts/bench_stt.ts）の設定。モデルのファイルは、マシンごとに`*.local.json`で書く */
  bench: {
    /** whisper-serverの実行ファイルのパス（空なら、比較スクリプトに--exeで渡す） */
    executable: string;
    /** モデルのファイルを探すフォルダ（空なら、`file`をそのまま使う） */
    modelsDir: string;
    /** whisper-serverの起動に足す引数（-m・--host・--port・-lは比較スクリプトが付ける） */
    extraArgs: string[];
    /** 比較するモデル。fileはmodelsDirからの相対（絶対でもよい） */
    models: { name: string; file: string }[];
    /** VADのモデル（modelsDirからの相対か絶対）。指定があれば`--vad -vm`を付けて起動する。空ならVADなし */
    vadModel: string;
  };
};

export type SearchConfig = {
  provider: "tavily" | "stub";
  apiKey: string;
  maxResults: number;
  timeoutMs: number;
};

export type PairingConfig = {
  /** 登録コードの有効時間 */
  codeTtlMs: number;
  /** failureWindowMsの間にこの回数失敗したら、lockMsの間受け付けない */
  maxFailures: number;
  failureWindowMs: number;
  lockMs: number;
};

export type TtsConfig = { baseUrl: string; speaker: number };

export type BackendConfig = {
  /** 公開用ポートの待ち受け先（本番は127.0.0.1。LANから試すときだけ0.0.0.0） */
  host: string;
  port: number;
  /** QRに入れる公開URL（末尾の / なし） */
  publicUrl: string;
  /** 管理用API（127.0.0.1だけで待ち受ける） */
  admin: { port: number };
  llm: LlmConfig & { models: Record<LlmAlias, LlmModelConfig>; activeAlias: LlmAlias };
  tts: TtsConfig;
  /** 入力元。consolesは設定のconsoleの名前、activeは起動時の入力元（robotかconsoleの名前） */
  inputSources: { consoles: string[]; active: string };
  pairing: PairingConfig;
  stt: SttConfig;
  search: SearchConfig;
  dialogue: { questionLoopThreshold: number };
  session: { idleResetMs: number };
  console: ConsoleSettings;
  /** 話し中のタイムアウトの余裕（送った音声の長さの合計に足す） */
  speakingGraceMs: number;
  healthIntervalMs: number;
  /** 入力ページに送る表示用の履歴の件数 */
  historyDisplayTurns: number;
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** baseに、overrideの項目を再帰的に上書きした新しい値を返す。 */
export function mergeConfig(base: unknown, override: unknown): unknown {
  if (!isObj(base) || !isObj(override)) return override === undefined ? base : override;
  const out: Obj = { ...base };
  for (const [key, value] of Object.entries(override)) out[key] = mergeConfig(base[key], value);
  return out;
}

/** default.jsonとlocal.json（あれば）を読み、合わせた値を返す。 */
export async function loadJsonConfig(name: string, dir = CONFIG_DIR): Promise<unknown> {
  const base: unknown = await Bun.file(`${dir}${name}.default.json`).json();
  const local = Bun.file(`${dir}${name}.local.json`);
  return (await local.exists()) ? mergeConfig(base, await local.json()) : base;
}

class ConfigError extends Error {}

function pick(v: Obj, path: string, check: (x: unknown) => boolean, expected: string): unknown {
  let cur: unknown = v;
  for (const key of path.split(".")) cur = isObj(cur) ? cur[key] : undefined;
  if (!check(cur)) throw new ConfigError(`config: ${path} must be ${expected}`);
  return cur;
}

const isStr = (x: unknown) => typeof x === "string";
const isNonNeg = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0;
const isPort = (x: unknown) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 65535;
const isCount = (x: unknown) => Number.isInteger(x) && (x as number) >= 0;
const isUrl = (x: unknown) => isStr(x) && /^https?:\/\/[^/]+/.test(x as string);
const isBoolean = (x: unknown) => typeof x === "boolean";
const isNonEmpty = (x: unknown) => isStr(x) && (x as string) !== "";
const oneOf = (list: readonly string[]) => (x: unknown) => list.includes(x as string);

/** 設定の形を確かめる。崩れていれば、どの項目かを示す例外を投げる。 */
export function parseBackendConfig(raw: unknown): BackendConfig {
  if (!isObj(raw)) throw new ConfigError("config: backend config must be an object");
  const s = (path: string) => pick(raw, path, isStr, "a string") as string;
  const n = (path: string) => pick(raw, path, isNonNeg, "a non-negative number") as number;
  const c = (path: string) => pick(raw, path, isCount, "a non-negative integer") as number;
  const url = (path: string) =>
    (pick(raw, path, isUrl, "an http(s) URL") as string).replace(/\/+$/, "");

  const b = (path: string) => pick(raw, path, isBoolean, "a boolean") as boolean;
  const port = (path: string) => pick(raw, path, isPort, "a port number") as number;

  const consoles = pick(
    raw,
    "inputSources.consoles",
    (x) => Array.isArray(x) && x.every(isNonEmpty),
    "an array of non-empty strings",
  ) as string[];
  if (consoles.includes(ROBOT_SOURCE)) {
    throw new ConfigError(`config: inputSources.consoles must not include "${ROBOT_SOURCE}"`);
  }
  if (new Set(consoles).size !== consoles.length) {
    throw new ConfigError("config: inputSources.consoles has duplicates");
  }
  const active = s("inputSources.active");
  if (active !== ROBOT_SOURCE && !consoles.includes(active)) {
    throw new ConfigError(
      `config: inputSources.active "${active}" must be "${ROBOT_SOURCE}" or one of inputSources.consoles`,
    );
  }

  const model = (alias: LlmAlias): LlmModelConfig => ({
    model: s(`llm.models.${alias}.model`),
    maxTokens: c(`llm.models.${alias}.maxTokens`),
    temperature: n(`llm.models.${alias}.temperature`),
  });
  const models = { main: model("main"), sub: model("sub") };
  const activeAlias = pick(
    raw,
    "llm.activeAlias",
    oneOf(LLM_ALIASES),
    `one of ${LLM_ALIASES.join(", ")}`,
  ) as LlmAlias;

  const adminPort = port("admin.port");
  const publicPort = port("port");
  if (adminPort !== 0 && adminPort === publicPort) {
    throw new ConfigError("config: admin.port must differ from port");
  }

  return {
    host: pick(raw, "host", isNonEmpty, "a non-empty string") as string,
    port: publicPort,
    publicUrl: url("publicUrl"),
    admin: { port: adminPort },
    llm: {
      baseUrl: url("llm.baseUrl"),
      ...models[activeAlias],
      contextTurns: c("llm.contextTurns"),
      jsonSchema: b("llm.jsonSchema"),
      timeoutMs: n("llm.timeoutMs"),
      models,
      activeAlias,
    },
    tts: { baseUrl: url("tts.baseUrl"), speaker: c("tts.speaker") },
    inputSources: { consoles, active },
    pairing: {
      codeTtlMs: n("pairing.codeTtlMs"),
      maxFailures: c("pairing.maxFailures"),
      failureWindowMs: n("pairing.failureWindowMs"),
      lockMs: n("pairing.lockMs"),
    },
    stt: {
      provider: pick(raw, "stt.provider", oneOf(["whisper", "stub"]), "whisper or stub") as
        | "whisper"
        | "stub",
      timeoutMs: n("stt.timeoutMs"),
      whisper: {
        url: url("stt.whisper.url"),
        language: pick(raw, "stt.whisper.language", isNonEmpty, "a non-empty string") as string,
        hallucinations: pick(
          raw,
          "stt.whisper.hallucinations",
          (x) => Array.isArray(x) && x.every(isNonEmpty),
          "an array of non-empty strings",
        ) as string[],
        logprobThreshold: pick(
          raw,
          "stt.whisper.logprobThreshold",
          (x) => typeof x === "number" && Number.isFinite(x) && x <= 0,
          "a number of 0 or less",
        ) as number,
      },
      bench: {
        executable: s("stt.bench.executable"),
        modelsDir: s("stt.bench.modelsDir"),
        extraArgs: pick(
          raw,
          "stt.bench.extraArgs",
          (x) => Array.isArray(x) && x.every(isStr),
          "an array of strings",
        ) as string[],
        models: pick(
          raw,
          "stt.bench.models",
          (x) =>
            Array.isArray(x) &&
            x.every((m) => isObj(m) && isNonEmpty(m.name) && isNonEmpty(m.file)) &&
            new Set(x.map((m: Obj) => m.name)).size === x.length,
          "an array of {name, file} with unique non-empty names",
        ) as { name: string; file: string }[],
        vadModel: s("stt.bench.vadModel"),
      },
    },
    search: {
      provider: pick(raw, "search.provider", oneOf(["tavily", "stub"]), "tavily or stub") as
        | "tavily"
        | "stub",
      apiKey: s("search.apiKey"),
      maxResults: c("search.maxResults"),
      timeoutMs: n("search.timeoutMs"),
    },
    dialogue: { questionLoopThreshold: c("dialogue.questionLoopThreshold") },
    session: { idleResetMs: n("session.idleResetMs") },
    console: {
      autosendMs: n("console.autosendMs"),
      fontSizePx: n("console.fontSizePx"),
      bottomInsetPx: n("console.bottomInsetPx"),
      prompt: {
        user: s("console.prompt.user"),
        host: s("console.prompt.host"),
        dir: s("console.prompt.dir"),
      },
    },
    speakingGraceMs: n("speakingGraceMs"),
    healthIntervalMs: n("healthIntervalMs"),
    historyDisplayTurns: c("historyDisplayTurns"),
  };
}

export async function loadBackendConfig(dir = CONFIG_DIR): Promise<BackendConfig> {
  return parseBackendConfig(await loadJsonConfig("backend", dir));
}

/** 人格プロンプト（config/persona.md）。なければnullを返す。 */
export async function loadPersona(dir = CONFIG_DIR): Promise<string | null> {
  const file = Bun.file(`${dir}persona.md`);
  return (await file.exists()) ? (await file.text()).trim() : null;
}
