import {
  ADMIN_EVENT_KINDS,
  type AdminEvent,
  type AdminEventKind,
  type AdminStatus,
  AUTH_REQUIRED_REASONS,
  type AuthRequiredReason,
  type ClientMessage,
  type ConsoleSettings,
  DEVICE_ROLES,
  type Device,
  type DeviceRole,
  EMOTIONS,
  type Emotion,
  type Health,
  HISTORY_CLEARED_REASONS,
  type HistoryClearedReason,
  type InputSourceRequest,
  LLM_ALIASES,
  type LlmAlias,
  type LlmModelRequest,
  type MicRequest,
  PAIR_FAILED_REASONS,
  type PairFailedReason,
  type PairingCode,
  type Reply,
  SESSION_STATES,
  type ServerMessage,
  type SessionState,
  type Turn,
  type TurnSearch,
  VIAS,
  type Via,
} from "./types.ts";

// 受け取ったメッセージを検証する。形が崩れていれば null を返す。
// 返す値は、型にある項目だけで組み立て直す（余分な項目は持ち込まない）。

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isNonNegNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
const isIndex = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isStrOrNull = (v: unknown): v is string | null => v === null || isStr(v);
const oneOf =
  <T>(list: readonly T[]) =>
  (v: unknown): v is T =>
    (list as readonly unknown[]).includes(v);

export const isEmotion = oneOf<Emotion>(EMOTIONS);
export const isSessionState = oneOf<SessionState>(SESSION_STATES);
export const isDeviceRole = oneOf<DeviceRole>(DEVICE_ROLES);
export const isLlmAlias = oneOf<LlmAlias>(LLM_ALIASES);
const isVia = oneOf<Via>(VIAS);
const isAuthReason = oneOf<AuthRequiredReason>(AUTH_REQUIRED_REASONS);
const isPairFailedReason = oneOf<PairFailedReason>(PAIR_FAILED_REASONS);
const isClearedReason = oneOf<HistoryClearedReason>(HISTORY_CLEARED_REASONS);
const isAdminEventKind = oneOf<AdminEventKind>(ADMIN_EVENT_KINDS);

function toObj(raw: string | unknown): Obj | null {
  if (!isStr(raw)) return isObj(raw) ? raw : null;
  try {
    const v: unknown = JSON.parse(raw);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

function toReply(v: Obj): Reply | null {
  if (!isStr(v.say) || !isEmotion(v.emotion) || !isNonNegNum(v.thinkingMs)) return null;
  return { say: v.say, emotion: v.emotion, thinkingMs: v.thinkingMs };
}

function toSearch(v: unknown): TurnSearch | null {
  if (!isObj(v) || !isStr(v.query) || !isStr(v.preSay)) return null;
  if (!(v.searchMs === null || isNonNegNum(v.searchMs))) return null;
  if (!(v.ok === null || isBool(v.ok))) return null;
  return { query: v.query, preSay: v.preSay, searchMs: v.searchMs, ok: v.ok };
}

function toTurn(v: unknown): Turn | null {
  if (!isObj(v)) return null;
  if (!isStr(v.id) || !isStr(v.at) || !isStr(v.source) || !isVia(v.via) || !isStr(v.text)) {
    return null;
  }
  const turn: Turn = { id: v.id, at: v.at, source: v.source, via: v.via, text: v.text };
  if (v.reply !== undefined) {
    const reply = isObj(v.reply) ? toReply(v.reply) : null;
    if (!reply) return null;
    turn.reply = reply;
  }
  if (v.search !== undefined) {
    const search = toSearch(v.search);
    if (!search) return null;
    turn.search = search;
  }
  return turn;
}

function toHealth(v: unknown): Health | null {
  if (!isObj(v)) return null;
  if (v.backend !== true || !isBool(v.llm) || !isBool(v.tts) || !isBool(v.stt)) return null;
  if (!isBool(v.robot)) return null;
  return { backend: true, llm: v.llm, tts: v.tts, stt: v.stt, robot: v.robot };
}

function toSettings(v: unknown): ConsoleSettings | null {
  if (!isObj(v) || !isObj(v.prompt)) return null;
  const { prompt } = v;
  if (!isNonNegNum(v.autosendMs) || !isNonNegNum(v.fontSizePx) || !isNonNegNum(v.bottomInsetPx)) {
    return null;
  }
  if (!isNonNegNum(v.idleResetMs)) return null;
  if (!isStr(prompt.user) || !isStr(prompt.host) || !isStr(prompt.dir)) return null;
  return {
    autosendMs: v.autosendMs,
    fontSizePx: v.fontSizePx,
    bottomInsetPx: v.bottomInsetPx,
    prompt: { user: prompt.user, host: prompt.host, dir: prompt.dir },
    idleResetMs: v.idleResetMs,
  };
}

/** console・robot → backend のメッセージを検証する。 */
export function parseClientMessage(raw: string): ClientMessage | null {
  const v = toObj(raw);
  if (!v) return null;
  switch (v.type) {
    case "hello": {
      if (!isStrOrNull(v.token)) return null;
      if (v.role === "console") {
        return isStr(v.device)
          ? { type: "hello", role: "console", device: v.device, token: v.token }
          : null;
      }
      return v.role === "robot" ? { type: "hello", role: "robot", token: v.token } : null;
    }
    case "pair": {
      if (!isDeviceRole(v.role) || !isStr(v.code)) return null;
      if (v.device !== undefined && !isStr(v.device)) return null;
      return v.device === undefined
        ? { type: "pair", role: v.role, code: v.code }
        : { type: "pair", role: v.role, device: v.device, code: v.code };
    }
    case "utterance":
      return isStr(v.text) ? { type: "utterance", text: v.text } : null;
    case "playback_done":
      return isStr(v.turnId) && isIndex(v.index)
        ? { type: "playback_done", turnId: v.turnId, index: v.index }
        : null;
    case "listening":
      return isBool(v.active) ? { type: "listening", active: v.active } : null;
    case "voice":
      return isStr(v.wav) && isNonNegNum(v.durationMs)
        ? { type: "voice", wav: v.wav, durationMs: v.durationMs }
        : null;
    default:
      return null;
  }
}

/** backend → console・robot のメッセージを検証する。 */
export function parseServerMessage(raw: string): ServerMessage | null {
  const v = toObj(raw);
  if (!v) return null;
  switch (v.type) {
    case "welcome": {
      const settings = toSettings(v.settings);
      if (!settings || !Array.isArray(v.history)) return null;
      const history: Turn[] = [];
      for (const item of v.history) {
        const turn = toTurn(item);
        if (!turn) return null;
        history.push(turn);
      }
      return { type: "welcome", settings, history };
    }
    case "status": {
      const health = toHealth(v.health);
      if (!health || !isSessionState(v.session) || !isStr(v.inputSource) || !isBool(v.micPaused)) {
        return null;
      }
      return {
        type: "status",
        session: v.session,
        inputSource: v.inputSource,
        micPaused: v.micPaused,
        health,
      };
    }
    case "turn_started": {
      const turn = toTurn(v.turn);
      return turn ? { type: "turn_started", turn } : null;
    }
    case "turn_replied": {
      const reply = toReply(v);
      return reply && isStr(v.turnId) ? { type: "turn_replied", turnId: v.turnId, ...reply } : null;
    }
    case "turn_search_started":
      if (
        !isStr(v.turnId) ||
        !isStr(v.query) ||
        !isStr(v.preSay) ||
        !isEmotion(v.emotion) ||
        !isNonNegNum(v.thinkingMs)
      ) {
        return null;
      }
      return {
        type: "turn_search_started",
        turnId: v.turnId,
        query: v.query,
        preSay: v.preSay,
        emotion: v.emotion,
        thinkingMs: v.thinkingMs,
      };
    case "turn_search_done":
      return isStr(v.turnId) && isNonNegNum(v.searchMs) && isBool(v.ok)
        ? { type: "turn_search_done", turnId: v.turnId, searchMs: v.searchMs, ok: v.ok }
        : null;
    case "history_cleared":
      return isStr(v.at) && isClearedReason(v.reason)
        ? { type: "history_cleared", at: v.at, reason: v.reason }
        : null;
    case "speech":
      if (
        !isStr(v.turnId) ||
        !isIndex(v.index) ||
        !isBool(v.last) ||
        !isStr(v.text) ||
        !isEmotion(v.emotion) ||
        !isStr(v.wav)
      ) {
        return null;
      }
      return {
        type: "speech",
        turnId: v.turnId,
        index: v.index,
        last: v.last,
        text: v.text,
        emotion: v.emotion,
        wav: v.wav,
      };
    case "auth_required":
      return isAuthReason(v.reason) ? { type: "auth_required", reason: v.reason } : null;
    case "paired":
      return isStr(v.token) && v.token !== "" ? { type: "paired", token: v.token } : null;
    case "pair_failed":
      return isPairFailedReason(v.reason) ? { type: "pair_failed", reason: v.reason } : null;
    default:
      return null;
  }
}

// ===== 管理用API =====

function toDevice(v: unknown): Device | null {
  if (!isObj(v) || !isStr(v.id) || !isDeviceRole(v.role) || !isStr(v.name)) return null;
  if (!isStr(v.registeredAt) || !isBool(v.connected)) return null;
  return {
    id: v.id,
    role: v.role,
    name: v.name,
    registeredAt: v.registeredAt,
    connected: v.connected,
  };
}

function toAdminStatus(v: Obj): AdminStatus | null {
  const health = toHealth(v.health);
  if (!health || !isSessionState(v.session) || !isStr(v.inputSource) || !isBool(v.micPaused)) {
    return null;
  }
  if (!isLlmAlias(v.llmModel) || !isStr(v.publicUrl) || !Array.isArray(v.devices)) return null;
  const sc = v.searchCount;
  if (!isObj(sc) || !isStr(sc.month) || !isIndex(sc.count)) return null;
  const devices: Device[] = [];
  for (const item of v.devices) {
    const device = toDevice(item);
    if (!device) return null;
    devices.push(device);
  }
  return {
    session: v.session,
    inputSource: v.inputSource,
    micPaused: v.micPaused,
    health,
    llmModel: v.llmModel,
    searchCount: { month: sc.month, count: sc.count },
    devices,
    publicUrl: v.publicUrl,
  };
}

/** GET /admin/status の応答を検証する。 */
export function parseAdminStatus(raw: string | unknown): AdminStatus | null {
  const v = toObj(raw);
  return v ? toAdminStatus(v) : null;
}

/** POST /admin/pairing-codes の応答を検証する。 */
export function parsePairingCode(raw: string | unknown): PairingCode | null {
  const v = toObj(raw);
  if (!v || !isStr(v.code) || !isStr(v.expiresAt) || !isStr(v.qr)) return null;
  return { code: v.code, expiresAt: v.expiresAt, qr: v.qr };
}

/** WS /admin/events のメッセージを検証する。 */
export function parseAdminEvent(raw: string | unknown): AdminEvent | null {
  const v = toObj(raw);
  if (!v) return null;
  if (v.type === "status") {
    const status = toAdminStatus(v);
    return status ? { type: "status", ...status } : null;
  }
  if (v.type === "event") {
    if (!isStr(v.at) || !isAdminEventKind(v.kind) || !isStr(v.detail)) return null;
    return { type: "event", at: v.at, kind: v.kind, detail: v.detail };
  }
  return null;
}

/** PUT /admin/input-source の本文を検証する。 */
export function parseInputSourceRequest(raw: string | unknown): InputSourceRequest | null {
  const v = toObj(raw);
  return v && isStr(v.source) && v.source !== "" ? { source: v.source } : null;
}

/** PUT /admin/mic の本文を検証する。 */
export function parseMicRequest(raw: string | unknown): MicRequest | null {
  const v = toObj(raw);
  return v && isBool(v.paused) ? { paused: v.paused } : null;
}

/** PUT /admin/llm-model の本文を検証する。 */
export function parseLlmModelRequest(raw: string | unknown): LlmModelRequest | null {
  const v = toObj(raw);
  return v && isLlmAlias(v.alias) ? { alias: v.alias } : null;
}
