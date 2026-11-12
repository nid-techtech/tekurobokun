// 設定ファイルの読み込み（imple 6節）。
// config/{name}.default.json をGitで管理し、同名の {name}.local.json があれば項目ごとに上書きする。
// 上書きはオブジェクトを再帰的に合わせ、配列と値はまるごと置き換える。

import { fileURLToPath } from "node:url";
import type { ConsoleSettings } from "@tekurobokun/protocol";

/** リポジトリのルート（apps/backend/src から3つ上）。 */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const CONFIG_DIR = `${REPO_ROOT}config/`;

export type LlmConfig = {
  /** OpenAI互換APIの接続先（末尾の / なし）。`/v1/chat/completions`と`/health`を呼ぶ */
  baseUrl: string;
  model: string;
  /** LLMに渡す直近の往復数 */
  contextTurns: number;
  /** JSONスキーマ制約（response_format）を使うか */
  jsonSchema: boolean;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
};

export type TtsConfig = { baseUrl: string; speaker: number };

export type BackendConfig = {
  port: number;
  llm: LlmConfig;
  tts: TtsConfig;
  devices: { list: string[]; active: string };
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

/** 設定の形を確かめる。崩れていれば、どの項目かを示す例外を投げる。 */
export function parseBackendConfig(raw: unknown): BackendConfig {
  if (!isObj(raw)) throw new ConfigError("config: backend config must be an object");
  const s = (path: string) => pick(raw, path, isStr, "a string") as string;
  const n = (path: string) => pick(raw, path, isNonNeg, "a non-negative number") as number;
  const c = (path: string) => pick(raw, path, isCount, "a non-negative integer") as number;
  const url = (path: string) =>
    (pick(raw, path, isUrl, "an http(s) URL") as string).replace(/\/+$/, "");

  const list = pick(
    raw,
    "devices.list",
    (x) => Array.isArray(x) && x.every(isStr),
    "an array of strings",
  ) as string[];
  const active = s("devices.active");
  if (list.length > 0 && !list.includes(active)) {
    throw new ConfigError(`config: devices.active "${active}" is not in devices.list`);
  }

  return {
    port: pick(raw, "port", isPort, "a port number") as number,
    llm: {
      baseUrl: url("llm.baseUrl"),
      model: s("llm.model"),
      contextTurns: c("llm.contextTurns"),
      jsonSchema: pick(
        raw,
        "llm.jsonSchema",
        (x) => typeof x === "boolean",
        "a boolean",
      ) as boolean,
      maxTokens: c("llm.maxTokens"),
      temperature: n("llm.temperature"),
      timeoutMs: n("llm.timeoutMs"),
    },
    tts: { baseUrl: url("tts.baseUrl"), speaker: c("tts.speaker") },
    devices: { list, active },
    console: {
      autosendMs: n("console.autosendMs"),
      fontSizePx: n("console.fontSizePx"),
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
