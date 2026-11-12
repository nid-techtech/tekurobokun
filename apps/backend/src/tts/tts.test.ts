import { describe, expect, test } from "bun:test";
import { encodeWav, splitSentences, TtsError, wavDurationMs } from "./engine.ts";
import { StubTtsEngine } from "./stub.ts";
import { VoicevoxTtsEngine } from "./voicevox.ts";

describe("splitSentences", () => {
  test("句点・感嘆符・疑問符で分ける", () => {
    expect(splitSentences("こんにちは。元気ですか？はい！")).toEqual([
      "こんにちは。",
      "元気ですか？",
      "はい！",
    ]);
  });

  test("終わりの記号が続いても1文、閉じかっこは前の文に付ける", () => {
    expect(splitSentences("えっ！？本当に。」そうなんだ")).toEqual([
      "えっ！？",
      "本当に。」",
      "そうなんだ",
    ]);
  });

  test("読点では分けず、改行では分ける", () => {
    expect(splitSentences("中にパソコンが入っていて、顔と声を担当しています\n次の行")).toEqual([
      "中にパソコンが入っていて、顔と声を担当しています",
      "次の行",
    ]);
  });

  test("記号だけの断片は前の文につなげ、空白だけは捨てる", () => {
    expect(splitSentences("  そうです。…  ")).toEqual(["そうです。…"]);
    expect(splitSentences("   ")).toEqual([]);
    expect(splitSentences("")).toEqual([]);
  });

  test("半角の記号でも分ける", () => {
    expect(splitSentences("Hello! How are you? Fine")).toEqual(["Hello!", "How are you?", "Fine"]);
  });
});

describe("wavDurationMs", () => {
  test("PCMのWAVの長さを返す", () => {
    expect(wavDurationMs(encodeWav(new Int16Array(24000), 24000))).toBe(1000);
    expect(wavDurationMs(encodeWav(new Int16Array(12000), 24000))).toBe(500);
  });

  test("WAVでなければnull", () => {
    expect(wavDurationMs(new TextEncoder().encode("not a wav file at all"))).toBeNull();
    expect(wavDurationMs(new Uint8Array(4))).toBeNull();
  });
});

describe("StubTtsEngine", () => {
  test("文の長さに応じたWAVを返す", async () => {
    const tts = new StubTtsEngine({ delayMs: 0 });
    const short = await tts.synthesize("はい。");
    const long = await tts.synthesize("中にパソコンが入っていて、顔と声を担当しています。");
    expect(wavDurationMs(short.wav)).toBeCloseTo(short.durationMs, 0);
    expect(long.durationMs).toBeGreaterThan(short.durationMs);
  });
});

describe("VoicevoxTtsEngine", () => {
  const config = { baseUrl: "http://voicevox.test", speaker: 3 };

  test("audio_queryの結果をsynthesisに渡し、WAVと長さを返す", async () => {
    const calls: { url: string; body: unknown; contentType: string | null }[] = [];
    const wav = encodeWav(new Int16Array(4800), 24000);
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, body: init?.body, contentType: headers.get("Content-Type") });
      if (url.includes("/audio_query")) return Response.json({ accent_phrases: [], speedScale: 1 });
      return new Response(wav, { headers: { "Content-Type": "audio/wav" } });
    }) as typeof fetch;

    const tts = new VoicevoxTtsEngine(config, 1000, fakeFetch);
    const speech = await tts.synthesize("こんにちは。");

    expect(speech.durationMs).toBe(200);
    expect(speech.wav).toEqual(wav);
    const [query, synthesis] = calls;
    expect(new URL(query?.url ?? "").searchParams.get("text")).toBe("こんにちは。");
    expect(new URL(query?.url ?? "").searchParams.get("speaker")).toBe("3");
    expect(new URL(synthesis?.url ?? "").pathname).toBe("/synthesis");
    expect(new URL(synthesis?.url ?? "").searchParams.get("speaker")).toBe("3");
    expect(JSON.parse(String(synthesis?.body))).toEqual({ accent_phrases: [], speedScale: 1 });
    expect(synthesis?.contentType).toBe("application/json");
  });

  test("エラーの応答・つながらないときはTtsError", async () => {
    const status500 = (async () => new Response("x", { status: 500 })) as unknown as typeof fetch;
    await expect(
      new VoicevoxTtsEngine(config, 1000, status500).synthesize("あ"),
    ).rejects.toBeInstanceOf(TtsError);
    const unreachable = (async () => {
      throw new TypeError("connection refused");
    }) as unknown as typeof fetch;
    await expect(
      new VoicevoxTtsEngine(config, 1000, unreachable).synthesize("あ"),
    ).rejects.toBeInstanceOf(TtsError);
  });

  test("WAVでない応答はTtsError", async () => {
    const notWav = (async (input: string | URL | Request) =>
      String(input).includes("/audio_query")
        ? Response.json({})
        : new Response("oops")) as unknown as typeof fetch;
    await expect(
      new VoicevoxTtsEngine(config, 1000, notWav).synthesize("あ"),
    ).rejects.toBeInstanceOf(TtsError);
  });
});
