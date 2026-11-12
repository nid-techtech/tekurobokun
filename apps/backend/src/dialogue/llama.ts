// LlamaDialogueEngine：llama-serverのOpenAI互換API（/v1/chat/completions）で返事を得る。
// llama-serverは、response_formatの`{"type": "json_schema", "json_schema": {"schema": …}}`で
// 出力をJSONスキーマに制約できる（tools/server/README.mdで確認）。制約を使っても、
// 受け取った文字列は必ずparseReplyで検証する。

import type { Turn } from "@tekurobokun/protocol";
import type { LlmConfig } from "../config.ts";
import {
  buildMessages,
  type DialogueEngine,
  type DialogueResult,
  LlmError,
  parseReply,
  REPLY_SCHEMA,
} from "./engine.ts";

export class LlamaDialogueEngine implements DialogueEngine {
  constructor(
    private readonly config: LlmConfig,
    private readonly systemPrompt: string,
  ) {}

  /** 問い合わせの本文（モデル比較のスクリプトからも使う）。 */
  requestBody(history: Turn[], text: string): Record<string, unknown> {
    const { model, contextTurns, maxTokens, temperature, jsonSchema } = this.config;
    return {
      model,
      messages: buildMessages(this.systemPrompt, history, text, contextTurns),
      max_tokens: maxTokens,
      temperature,
      stream: false,
      // Qwen3などの思考出力を止める（対応しないテンプレートでは無視される）。
      chat_template_kwargs: { enable_thinking: false },
      ...(jsonSchema
        ? {
            response_format: {
              type: "json_schema",
              json_schema: { name: "reply", strict: true, schema: REPLY_SCHEMA },
            },
          }
        : {}),
    };
  }

  async reply(history: Turn[], text: string): Promise<DialogueResult> {
    const started = performance.now();
    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.requestBody(history, text)),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (e) {
      throw new LlmError(`llm request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new LlmError(`llm responded ${res.status}`);
    const body: unknown = await res.json().catch(() => null);
    const thinkingMs = Math.round(performance.now() - started);
    const content = readContent(body);
    if (content === null) throw new LlmError("llm response has no message content");
    return { raw: content, ...withoutFlag(parseReply(content)), thinkingMs };
  }
}

function readContent(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return null;
  const message = (choices[0] as { message?: { content?: unknown } } | undefined)?.message;
  return typeof message?.content === "string" ? message.content : null;
}

const withoutFlag = ({ say, emotion }: ReturnType<typeof parseReply>) => ({ say, emotion });
