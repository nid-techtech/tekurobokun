import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { encodeWav } from "../tts/engine.ts";
import { SttError } from "./engine.ts";
import {
  discardReason,
  parseVerboseJson,
  phraseKey,
  stripEdges,
  type WhisperConfig,
  WhisperSpeechRecognizer,
} from "./whisper.ts";

const wav = encodeWav(new Int16Array(16000), 16000);

const whisperConfig = (url: string): WhisperConfig => ({
  url,
  language: "ja",
  hallucinations: ["ご視聴ありがとうございました", "チャンネル登録お願いします"],
  logprobThreshold: -0.3,
});

const seg = (text: string, avgLogprob: number | null = -0.1) => ({ text, avgLogprob });

describe("捨てる結果の判断", () => {
  const config = whisperConfig("http://x");

  test("前後の空白・句読点・記号を除いて空なら empty", () => {
    expect(stripEdges("  「こんにちは。」 ")).toBe("こんにちは");
    expect(discardReason(" 。…♪ ", [seg(" 。…♪ ")], config)).toBe("empty");
    expect(discardReason("", [], config)).toBe("empty");
  });

  test("すべての区切りで avg_logprob がしきい値を下回ったら low_logprob", () => {
    expect(discardReason("はい", [seg("はい", -0.6)], config)).toBe("low_logprob");
    expect(discardReason("はい。いいえ", [seg("はい", -0.8), seg("いいえ", -0.4)], config)).toBe(
      "low_logprob",
    );
    // 1つでもしきい値以上なら捨てない（長い発話の一部だけが不確かなとき）。しきい値ちょうども捨てない
    expect(discardReason("はい。いいえ", [seg("はい", -0.8), seg("いいえ", -0.1)], config)).toBe(
      null,
    );
    expect(discardReason("はい", [seg("はい", -0.3)], config)).toBe(null);
    // 値のない区切りは判断しない
    expect(discardReason("はい", [seg("はい", null)], config)).toBe(null);
  });

  test("avg_logprobは数のときだけ読む（nullや欠けはnull）", () => {
    expect(
      parseVerboseJson({
        text: "a",
        segments: [
          { text: "a", avg_logprob: -0.5 },
          { text: "b", avg_logprob: null },
          { text: "c" },
        ],
      }).segments,
    ).toEqual([
      { text: "a", avgLogprob: -0.5 },
      { text: "b", avgLogprob: null },
      { text: "c", avgLogprob: null },
    ]);
  });

  test("決まり文句と全体が一致したら hallucination。部分一致は捨てない", () => {
    expect(phraseKey(" ご視聴、ありがとう ございました。")).toBe("ご視聴ありがとうございました");
    expect(discardReason("ご視聴ありがとうございました。", [seg("x")], config)).toBe(
      "hallucination",
    );
    expect(discardReason(" チャンネル登録、お願いします！", [seg("x")], config)).toBe(
      "hallucination",
    );
    expect(discardReason("ご視聴ありがとうございましたって言うんだよ", [seg("x")], config)).toBe(
      null,
    );
  });

  test("verbose_jsonの形が違えば SttError", () => {
    expect(parseVerboseJson({ text: "a" })).toEqual({ text: "a", segments: [] });
    expect(() => parseVerboseJson(null)).toThrow(SttError);
    expect(() => parseVerboseJson({ segments: [] })).toThrow(SttError);
    expect(() => parseVerboseJson({ text: "a", segments: {} })).toThrow(SttError);
  });
});

/** 偽のwhisper-server。受けた要求を残し、次に返す応答を差し替えられる。 */
type Received = { path: string; fields: Record<string, string>; file: File | null };
const received: Received[] = [];
let reply: () => Response | Promise<Response>;
let healthStatus = 200;
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/health") {
        return Response.json(
          healthStatus === 200 ? { status: "ok" } : { status: "loading model" },
          { status: healthStatus },
        );
      }
      if (req.method === "POST" && path === "/inference") {
        const form = await req.formData();
        const fields: Record<string, string> = {};
        let file: File | null = null;
        for (const [k, v] of form.entries()) {
          if (typeof v === "string") fields[k] = v;
          else if (k === "file") file = v;
        }
        received.push({ path, fields, file });
        return reply();
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

beforeEach(() => {
  received.length = 0;
  healthStatus = 200;
  reply = () =>
    Response.json({
      task: "transcribe",
      language: "japanese",
      text: " 東京タワーの高さは？",
      segments: [{ id: 0, text: " 東京タワーの高さは？", no_speech_prob: 0.02, avg_logprob: -0.2 }],
    });
});

describe("WhisperSpeechRecognizer（偽のwhisper-server）", () => {
  test("WAVをmultipartで/inferenceへ送り、日本語に固定して翻訳しない", async () => {
    const stt = new WhisperSpeechRecognizer({ whisper: whisperConfig(base), timeoutMs: 2000 });
    const r = await stt.recognize(wav);
    expect(r.text).toBe("東京タワーの高さは？");
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(received).toHaveLength(1);
    const { fields, file } = received[0] as Received;
    expect(fields).toMatchObject({
      language: "ja",
      translate: "false",
      response_format: "verbose_json",
      no_language_probabilities: "true",
    });
    // v1.9.5では働かない音声なしのしきい値は送らない
    expect(fields).not.toHaveProperty("no_speech_thold");
    expect(file).not.toBeNull();
    expect(Buffer.from(await (file as File).arrayBuffer()).equals(Buffer.from(wav))).toBe(true);
  });

  test("捨てた結果は空の文にし、理由を標準出力へ出して数える", async () => {
    const lines: string[] = [];
    const stt = new WhisperSpeechRecognizer({
      whisper: whisperConfig(base),
      timeoutMs: 2000,
      log: (l) => lines.push(l),
    });
    reply = () =>
      Response.json({
        text: "ご視聴ありがとうございました。",
        segments: [{ text: "ご視聴ありがとうございました。", avg_logprob: -0.1 }],
      });
    expect((await stt.recognize(wav)).text).toBe("");
    // 雑音の「はい」（W7-4）。v1.9.5ではno_speech_probがつねに0
    reply = () =>
      Response.json({
        text: " はい",
        segments: [{ text: " はい", no_speech_prob: 0, avg_logprob: -0.62 }],
      });
    expect((await stt.recognize(wav)).text).toBe("");
    // VADが音声の区間を見つけなかったときの応答（v1.9.5：textが空、segmentsが0件）
    reply = () =>
      Response.json({
        task: "transcribe",
        language: "japanese",
        duration: 3,
        text: "",
        segments: [],
      });
    expect((await stt.recognize(wav)).text).toBe("");
    expect(stt.discardCounts()).toEqual({ empty: 1, low_logprob: 1, hallucination: 1 });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("(hallucination)");
    expect(lines[0]).toContain("ご視聴ありがとうございました");
    expect(lines[1]).toContain("(low_logprob)");
    expect(lines[2]).toContain("(empty)");
    expect(lines[2]).toContain("empty 1, low_logprob 1, hallucination 1");

    // 比較スクリプト用の中身では、捨てる前の文と理由と、区切りごとのavg_logprobが分かる
    reply = () =>
      Response.json({
        text: "えー。うん",
        segments: [
          { text: "えー。", avg_logprob: -0.5 },
          { text: "うん", avg_logprob: -0.7 },
        ],
      });
    const t = await stt.transcribe(wav);
    expect(t).toMatchObject({
      text: "",
      raw: "えー。うん",
      discarded: "low_logprob",
      logprobs: [-0.5, -0.7],
    });
  });

  test("エラーの応答・形の違う応答・つながらない・時間切れは SttError", async () => {
    const stt = new WhisperSpeechRecognizer({ whisper: whisperConfig(base), timeoutMs: 300 });
    reply = () => Response.json({ error: "failed to read audio data" }, { status: 400 });
    await expect(stt.recognize(wav)).rejects.toThrow("whisper 400");
    reply = () => new Response("<html>", { headers: { "content-type": "text/html" } });
    await expect(stt.recognize(wav)).rejects.toBeInstanceOf(SttError);
    reply = () => Response.json({ segments: [] });
    await expect(stt.recognize(wav)).rejects.toBeInstanceOf(SttError);
    reply = () => new Promise((r) => setTimeout(() => r(Response.json({ text: "遅い" })), 1000));
    await expect(stt.recognize(wav)).rejects.toBeInstanceOf(SttError);

    const down = new WhisperSpeechRecognizer({
      whisper: whisperConfig("http://127.0.0.1:1"),
      timeoutMs: 300,
    });
    await expect(down.recognize(wav)).rejects.toBeInstanceOf(SttError);
    expect(await down.probe()).toBe(false);
  });

  test("probeは/healthが200のときだけtrue（モデルの読み込み中は503）", async () => {
    const stt = new WhisperSpeechRecognizer({ whisper: whisperConfig(base), timeoutMs: 2000 });
    expect(await stt.probe()).toBe(true);
    healthStatus = 503;
    expect(await stt.probe()).toBe(false);
  });
});
