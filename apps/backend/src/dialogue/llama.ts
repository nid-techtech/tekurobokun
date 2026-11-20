// LlamaDialogueEngine：llama-serverのOpenAI互換API（/v1/chat/completions）で返事を得る。
// llama-serverは、response_formatの`{"type": "json_schema", "json_schema": {"schema": …}}`で
// 出力をJSONスキーマに制約できる（tools/server/README.mdで確認）。制約を使っても、
// 受け取った文字列は必ずparseFirstReply・parseReplyで検証する。
// モデルの別名（main・sub）ごとに、モデル名と生成のパラメータを持つ。接続先は1つ
// （ランチャーが正→副を同じポートで起動し直し、PUT /admin/llm-modelで別名を伝える）。

import type { LlmAlias, Turn } from "@tekurobokun/protocol";
import type { LlmConfig, LlmModelConfig } from "../config.ts";
import type { SearchResult } from "../search/engine.ts";
import {
  buildMessages,
  type DialogueEngine,
  type DialogueResult,
  FIRST_REPLY_SCHEMA,
  type FirstReplyResult,
  finalSystemPrompt,
  firstSystemPrompt,
  LlmError,
  LlmTimeoutError,
  type PromptSet,
  parseFirstReply,
  parseReply,
  REPLY_SCHEMA,
  type ReplyOptions,
} from "./engine.ts";

export type LlamaEngineOptions = {
  /** 接続先・往復数・時間切れと、別名の設定がないときのモデルの値 */
  llm: LlmConfig;
  /** 別名ごとのモデルの値（なければllmの値をどの別名にも使う。比較スクリプト） */
  models?: Record<LlmAlias, LlmModelConfig>;
  /** 起動時の別名（既定main） */
  alias?: LlmAlias;
  prompts: PromptSet;
};

type Schema = typeof FIRST_REPLY_SCHEMA | typeof REPLY_SCHEMA;

export class LlamaDialogueEngine implements DialogueEngine {
  private alias: LlmAlias;

  constructor(private readonly options: LlamaEngineOptions) {
    this.alias = options.alias ?? "main";
  }

  activeModel(): LlmAlias {
    return this.alias;
  }

  setModel(alias: LlmAlias): void {
    this.alias = alias;
  }

  /** いまの別名で解決したLLMの設定。 */
  config(): LlmConfig {
    const model = this.options.models?.[this.alias];
    return model ? { ...this.options.llm, ...model } : this.options.llm;
  }

  /** 問い合わせの本文（モデル比較のスクリプトからも使う）。 */
  requestBody(
    system: string,
    history: Turn[],
    text: string,
    schema: Schema,
  ): Record<string, unknown> {
    const { model, contextTurns, maxTokens, temperature, jsonSchema } = this.config();
    return {
      model,
      messages: buildMessages(system, history, text, contextTurns),
      max_tokens: maxTokens,
      temperature,
      stream: false,
      // Qwen3などの思考出力を止める（対応しないテンプレートでは無視される）。
      chat_template_kwargs: { enable_thinking: false },
      ...(jsonSchema
        ? {
            response_format: {
              type: "json_schema",
              json_schema: { name: "reply", strict: true, schema },
            },
          }
        : {}),
    };
  }

  /** 1回目の本文。 */
  firstRequestBody(history: Turn[], text: string, opts: ReplyOptions): Record<string, unknown> {
    const system = firstSystemPrompt(this.options.prompts, opts);
    return this.requestBody(system, history, text, FIRST_REPLY_SCHEMA);
  }

  async reply(history: Turn[], text: string, opts: ReplyOptions): Promise<FirstReplyResult> {
    const alias = this.alias;
    const { content, thinkingMs } = await this.complete(this.firstRequestBody(history, text, opts));
    const { say, emotion, search } = parseFirstReply(content);
    return { raw: content, say, emotion, search, thinkingMs, model: alias };
  }

  async replyWithResults(
    history: Turn[],
    text: string,
    query: string,
    results: SearchResult[] | null,
    opts: ReplyOptions,
  ): Promise<DialogueResult> {
    const alias = this.alias;
    const system = finalSystemPrompt(this.options.prompts, opts, query, results);
    const body = this.requestBody(system, history, text, REPLY_SCHEMA);
    const { content, thinkingMs } = await this.complete(body);
    const { say, emotion } = parseReply(content);
    return { raw: content, say, emotion, thinkingMs, model: alias };
  }

  private async complete(
    body: Record<string, unknown>,
  ): Promise<{ content: string; thinkingMs: number }> {
    const { baseUrl, timeoutMs } = this.config();
    const started = performance.now();
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Response;
    let parsed: unknown;
    try {
      res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw new LlmError(`llm responded ${res.status}`);
      parsed = await res.json().catch((e: unknown) => {
        if (signal.aborted) throw e;
        return null;
      });
    } catch (e) {
      if (e instanceof LlmError) throw e;
      if (signal.aborted) throw new LlmTimeoutError(`llm did not answer within ${timeoutMs}ms`);
      throw new LlmError(`llm request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const thinkingMs = Math.round(performance.now() - started);
    const content = readContent(parsed);
    if (content === null) throw new LlmError("llm response has no message content");
    return { content, thinkingMs };
  }
}

function readContent(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return null;
  const message = (choices[0] as { message?: { content?: unknown } } | undefined)?.message;
  return typeof message?.content === "string" ? message.content : null;
}
