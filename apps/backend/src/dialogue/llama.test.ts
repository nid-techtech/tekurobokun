import { afterAll, describe, expect, test } from "bun:test";
import type { LlmConfig } from "../config.ts";
import { LlmError, LlmTimeoutError, type PromptSet } from "./engine.ts";
import { LlamaDialogueEngine } from "./llama.ts";

// llama-serverの代わりに、/v1/chat/completionsに決まった応答を返すサーバーを立てる。
let respond: (body: Record<string, unknown>) => Response | Promise<Response> = () =>
  new Response(null);
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

const prompts: PromptSet = {
  persona: "SYS",
  firstFormat: "FIRST",
  finalFormat: "FINAL",
  antiLoop: "ANTI",
  results: "R {query} {results}",
  searchFailed: "F {query}",
};
const engine = (over: Partial<LlmConfig> = {}) =>
  new LlamaDialogueEngine({ llm: config(over), prompts });
const noLoop = { antiLoop: false };

const completion = (content: unknown) =>
  Response.json({ choices: [{ message: { role: "assistant", content } }] });

describe("LlamaDialogueEngine", () => {
  test("返事を検証して返し、考えた時間を測る", async () => {
    respond = () => completion('{"say":"やあ。","emotion":"happy"}');
    const result = await engine().reply([], "こんにちは", noLoop);
    expect(result).toMatchObject({
      raw: '{"say":"やあ。","emotion":"happy"}',
      say: "やあ。",
      emotion: "happy",
      search: null,
      model: "main",
    });
    expect(result.thinkingMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result.thinkingMs)).toBe(true);
  });

  test("JSONスキーマ制約と思考出力の停止を送る", async () => {
    respond = () => completion('{"say":"a","emotion":"neutral","search":null}');
    await engine().reply([], "q", noLoop);
    expect(lastBody.model).toBe("test-model");
    expect(lastBody.max_tokens).toBe(64);
    expect(lastBody.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(lastBody.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { schema: { required: ["say", "emotion", "search"] } },
    });
    expect(lastBody.messages).toEqual([
      { role: "system", content: "SYS\n\nFIRST" },
      { role: "user", content: "q" },
    ]);
  });

  test("1回目の検索語を返す。antiLoopなら指示を足す", async () => {
    respond = () => completion('{"say":"調べるね。","emotion":"curious","search":"長岡 花火"}');
    const result = await engine().reply([], "q", { antiLoop: true });
    expect(result).toMatchObject({ say: "調べるね。", search: "長岡 花火" });
    expect((lastBody.messages as { content: string }[])[0]?.content).toBe("SYS\n\nANTI\n\nFIRST");
  });

  test("2回目は結果を付け、searchのないスキーマで問い合わせる", async () => {
    respond = () => completion('{"say":"高さは333メートルです。","emotion":"happy"}');
    const result = await engine().replyWithResults(
      [],
      "東京タワーの高さは？",
      "東京タワー 高さ",
      [{ title: "T", url: "u", snippet: "333m" }],
      noLoop,
    );
    expect(result).toMatchObject({
      say: "高さは333メートルです。",
      emotion: "happy",
      model: "main",
    });
    expect(result).not.toHaveProperty("search");
    expect(lastBody.response_format).toMatchObject({
      json_schema: { schema: { required: ["say", "emotion"] } },
    });
    expect((lastBody.messages as { content: string }[])[0]?.content).toBe(
      "SYS\n\nFINAL\n\nR 東京タワー 高さ [1] T\n333m",
    );
    await engine().replyWithResults([], "q", "x", null, noLoop);
    expect((lastBody.messages as { content: string }[])[0]?.content).toBe("SYS\n\nFINAL\n\nF x");
  });

  test("別名ごとのモデルの値で問い合わせ、切り替えられる", async () => {
    respond = () => completion('{"say":"a","emotion":"neutral","search":null}');
    const e = new LlamaDialogueEngine({
      llm: config(),
      prompts,
      models: {
        main: { model: "big", maxTokens: 100, temperature: 0.7 },
        sub: { model: "small", maxTokens: 50, temperature: 0.3 },
      },
      alias: "main",
    });
    await e.reply([], "q", noLoop);
    expect(lastBody).toMatchObject({ model: "big", max_tokens: 100, temperature: 0.7 });
    e.setModel("sub");
    expect(e.activeModel()).toBe("sub");
    const result = await e.reply([], "q", noLoop);
    expect(lastBody).toMatchObject({ model: "small", max_tokens: 50, temperature: 0.3 });
    expect(result.model).toBe("sub");
  });

  test("時間切れはLlmTimeoutError", async () => {
    respond = async () => {
      await Bun.sleep(300);
      return completion("{}");
    };
    await expect(engine({ timeoutMs: 50 }).reply([], "q", noLoop)).rejects.toBeInstanceOf(
      LlmTimeoutError,
    );
  });

  test("jsonSchemaがfalseならresponse_formatを送らない", async () => {
    respond = () => completion('{"say":"a","emotion":"neutral"}');
    await engine({ jsonSchema: false }).reply([], "q", noLoop);
    expect(lastBody.response_format).toBeUndefined();
  });

  test("形式の崩れた返事は本文をsay、感情をneutralにする", async () => {
    respond = () => completion("はい、こんにちは。");
    const result = await engine().reply([], "q", noLoop);
    expect(result).toMatchObject({
      raw: "はい、こんにちは。",
      say: "はい、こんにちは。",
      emotion: "neutral",
    });
  });

  test("HTTPのエラーはLlmError", async () => {
    respond = () => new Response("loading", { status: 503 });
    await expect(engine().reply([], "q", noLoop)).rejects.toBeInstanceOf(LlmError);
  });

  test("本文のない応答はLlmError", async () => {
    respond = () => Response.json({ choices: [] });
    await expect(engine().reply([], "q", noLoop)).rejects.toBeInstanceOf(LlmError);
  });

  test("つながらなければLlmError", async () => {
    const e = engine({ baseUrl: "http://127.0.0.1:9" });
    const err = await e.reply([], "q", noLoop).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).not.toBeInstanceOf(LlmTimeoutError);
  });
});
