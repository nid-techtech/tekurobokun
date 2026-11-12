// DialogueEngine：LLMへの問い合わせと返事の検証（imple 3節・4節）。
// 実装はLlamaDialogueEngine（OpenAI互換API）とStubDialogueEngine（LLMなしの開発用）。

import { EMOTIONS, type Emotion, isEmotion, type Turn } from "@tekurobokun/protocol";

export type DialogueResult = {
  /** LLMの生の出力 */
  raw: string | null;
  say: string;
  emotion: Emotion;
  /** LLMへの問い合わせから返事を得るまでの時間 */
  thinkingMs: number;
};

/** LLMに届かない、または応答が読めないときの例外。 */
export class LlmError extends Error {}

export interface DialogueEngine {
  /** 返事を得る。LLMに届かない・応答が崩れて読めないときは例外を投げる。 */
  reply(history: Turn[], text: string): Promise<DialogueResult>;
}

export type ParsedReply = {
  say: string;
  emotion: Emotion;
  /** 生の出力が、そのまま`{say, emotion}`のJSONとして読めたか（形式の崩れの集計に使う） */
  wellFormed: boolean;
};

/** 返事のJSONスキーマ（llama-serverのresponse_formatに渡す）。 */
export const REPLY_SCHEMA = {
  type: "object",
  properties: {
    say: { type: "string", minLength: 1 },
    emotion: { type: "string", enum: [...EMOTIONS] },
  },
  required: ["say", "emotion"],
  additionalProperties: false,
} as const;

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

/**
 * LLMの生の出力を`{say, emotion}`にする。
 * 形式が崩れていれば本文を`say`、範囲外の感情は`neutral`として扱う（スペックシート2節）。
 */
export function parseReply(raw: string): ParsedReply {
  const text = raw.trim();
  const strict = parseObject(text);
  const obj = strict ?? parseObject(innerBraces(text));
  if (obj && typeof obj.say === "string" && obj.say.trim() !== "") {
    const say = obj.say.trim();
    if (isEmotion(obj.emotion)) return { say, emotion: obj.emotion, wellFormed: strict !== null };
    return { say, emotion: "neutral", wellFormed: false };
  }
  return { say: stripFences(text), emotion: "neutral", wellFormed: false };
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

/** 返事の形式の指示（reply_format.md）を読み、人格プロンプトのあとに付けてシステムプロンプトにする。 */
export async function buildSystemPrompt(persona: string | null): Promise<string> {
  const format = await Bun.file(new URL("./reply_format.md", import.meta.url)).text();
  const formatText = format.replaceAll("{emotions}", EMOTIONS.join(", ")).trim();
  return persona ? `${persona.trim()}\n\n${formatText}` : formatText;
}
