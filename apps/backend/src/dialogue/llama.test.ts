import { afterAll, describe, expect, test } from "bun:test";
import type { LlmConfig } from "../config.ts";
import { LlmError } from "./engine.ts";
import { LlamaDialogueEngine } from "./llama.ts";

// llama-serverの代わりに、/v1/chat/completionsに決まった応答を返すサーバーを立てる。
let respond: (body: Record<string, unknown>) => Response = () => new Response(null);
let lastBody: Record<string, unknown> = {};
const fake = Bun.serve({
  port: 0,
  fetch: async (req) => {
    lastBody = (await req.json()) as Record<string, unknown>;
    return respond(lastBody);
  },
});
afterAll(() => fake.stop(true));

const config = (over: Partial<LlmConfig> = {}): LlmConfig => ({
  baseUrl: `http://127.0.0.1:${fake.port}`,
  model: "test-model",
  contextTurns: 4,
  jsonSchema: true,
  maxTokens: 64,
  temperature: 0.5,
  timeoutMs: 2000,
  ...over,
});

const completion = (content: unknown) =>
  Response.json({ choices: [{ message: { role: "assistant", content } }] });

describe("LlamaDialogueEngine", () => {
  test("返事を検証して返し、考えた時間を測る", async () => {
    respond = () => completion('{"say":"やあ。","emotion":"happy"}');
    const result = await new LlamaDialogueEngine(config(), "SYS").reply([], "こんにちは");
    expect(result).toMatchObject({
      raw: '{"say":"やあ。","emotion":"happy"}',
      say: "やあ。",
      emotion: "happy",
    });
    expect(result.thinkingMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result.thinkingMs)).toBe(true);
  });

  test("JSONスキーマ制約と思考出力の停止を送る", async () => {
    respond = () => completion('{"say":"a","emotion":"neutral"}');
    await new LlamaDialogueEngine(config(), "SYS").reply([], "q");
    expect(lastBody.model).toBe("test-model");
    expect(lastBody.max_tokens).toBe(64);
    expect(lastBody.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(lastBody.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { schema: { required: ["say", "emotion"] } },
    });
    expect(lastBody.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "q" },
    ]);
  });

  test("jsonSchemaがfalseならresponse_formatを送らない", async () => {
    respond = () => completion('{"say":"a","emotion":"neutral"}');
    await new LlamaDialogueEngine(config({ jsonSchema: false }), "SYS").reply([], "q");
    expect(lastBody.response_format).toBeUndefined();
  });

  test("形式の崩れた返事は本文をsay、感情をneutralにする", async () => {
    respond = () => completion("はい、こんにちは。");
    const result = await new LlamaDialogueEngine(config(), "SYS").reply([], "q");
    expect(result).toMatchObject({
      raw: "はい、こんにちは。",
      say: "はい、こんにちは。",
      emotion: "neutral",
    });
  });

  test("HTTPのエラーはLlmError", async () => {
    respond = () => new Response("loading", { status: 503 });
    await expect(new LlamaDialogueEngine(config(), "SYS").reply([], "q")).rejects.toBeInstanceOf(
      LlmError,
    );
  });

  test("本文のない応答はLlmError", async () => {
    respond = () => Response.json({ choices: [] });
    await expect(new LlamaDialogueEngine(config(), "SYS").reply([], "q")).rejects.toBeInstanceOf(
      LlmError,
    );
  });

  test("つながらなければLlmError", async () => {
    const engine = new LlamaDialogueEngine(config({ baseUrl: "http://127.0.0.1:9" }), "SYS");
    await expect(engine.reply([], "q")).rejects.toBeInstanceOf(LlmError);
  });
});
