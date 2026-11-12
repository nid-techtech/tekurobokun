import {
  type ClientMessage,
  type ConsoleSettings,
  EMOTIONS,
  type Emotion,
  type Health,
  type Reply,
  SESSION_STATES,
  type ServerMessage,
  type SessionState,
  type Turn,
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

export const isEmotion = (v: unknown): v is Emotion => (EMOTIONS as readonly unknown[]).includes(v);
export const isSessionState = (v: unknown): v is SessionState =>
  (SESSION_STATES as readonly unknown[]).includes(v);

function toObj(raw: string): Obj | null {
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

function toTurn(v: unknown): Turn | null {
  if (!isObj(v)) return null;
  if (!isStr(v.id) || !isStr(v.at) || !isStr(v.device) || !isStr(v.text)) return null;
  const turn: Turn = { id: v.id, at: v.at, device: v.device, text: v.text };
  if (v.reply !== undefined) {
    const reply = isObj(v.reply) ? toReply(v.reply) : null;
    if (!reply) return null;
    turn.reply = reply;
  }
  return turn;
}

function toHealth(v: unknown): Health | null {
  if (!isObj(v)) return null;
  if (v.backend !== true || !isBool(v.llm) || !isBool(v.tts) || !isBool(v.robot)) return null;
  return { backend: true, llm: v.llm, tts: v.tts, robot: v.robot };
}

function toSettings(v: unknown): ConsoleSettings | null {
  if (!isObj(v) || !isObj(v.prompt)) return null;
  const { prompt } = v;
  if (!isNonNegNum(v.autosendMs) || !isNonNegNum(v.fontSizePx) || !isNonNegNum(v.bottomInsetPx)) {
    return null;
  }
  if (!isStr(prompt.user) || !isStr(prompt.host) || !isStr(prompt.dir)) return null;
  return {
    autosendMs: v.autosendMs,
    fontSizePx: v.fontSizePx,
    bottomInsetPx: v.bottomInsetPx,
    prompt: { user: prompt.user, host: prompt.host, dir: prompt.dir },
  };
}

/** console・robot → backend のメッセージを検証する。 */
export function parseClientMessage(raw: string): ClientMessage | null {
  const v = toObj(raw);
  if (!v) return null;
  switch (v.type) {
    case "hello":
      if (v.role === "console") {
        return isStr(v.device) ? { type: "hello", role: "console", device: v.device } : null;
      }
      return v.role === "robot" ? { type: "hello", role: "robot" } : null;
    case "utterance":
      return isStr(v.text) ? { type: "utterance", text: v.text } : null;
    case "playback_done":
      return isStr(v.turnId) && isIndex(v.index)
        ? { type: "playback_done", turnId: v.turnId, index: v.index }
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
      if (!health || !isSessionState(v.session) || !isStr(v.activeDevice)) return null;
      return { type: "status", session: v.session, activeDevice: v.activeDevice, health };
    }
    case "turn_started": {
      const turn = toTurn(v.turn);
      return turn ? { type: "turn_started", turn } : null;
    }
    case "turn_replied": {
      const reply = toReply(v);
      return reply && isStr(v.turnId) ? { type: "turn_replied", turnId: v.turnId, ...reply } : null;
    }
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
    default:
      return null;
  }
}
