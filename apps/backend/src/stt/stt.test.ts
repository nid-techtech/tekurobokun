import { describe, expect, test } from "bun:test";
import { encodeWav } from "../tts/engine.ts";
import { SttError } from "./engine.ts";
import { STUB_MIN_SPEECH_MS, StubSpeechRecognizer, stubTranscript } from "./stub.ts";

const wavOf = (ms: number) => encodeWav(new Int16Array(Math.round(16 * ms)), 16000);

describe("StubSpeechRecognizer", () => {
  const utterances = ["a", "b", "c"];

  test("WAVの長さの1秒ごとに次の文を返す。短すぎれば空", () => {
    expect(stubTranscript(STUB_MIN_SPEECH_MS - 1, utterances)).toBe("");
    expect(stubTranscript(STUB_MIN_SPEECH_MS, utterances)).toBe("a");
    expect(stubTranscript(1500, utterances)).toBe("b");
    expect(stubTranscript(3200, utterances)).toBe("a");
    expect(stubTranscript(5000, [])).toBe("");
  });

  test("WAVを読んで文を返し、止めている間は失敗する", async () => {
    let up = true;
    const stt = new StubSpeechRecognizer({ utterances, delayMs: 0, isUp: () => up });
    expect((await stt.recognize(wavOf(2100))).text).toBe("c");
    expect((await stt.recognize(wavOf(100))).text).toBe("");
    expect(await stt.probe()).toBe(true);
    up = false;
    await expect(stt.recognize(wavOf(2100))).rejects.toBeInstanceOf(SttError);
    expect(await stt.probe()).toBe(false);
  });

  test("WAVでなければ失敗する", async () => {
    const stt = new StubSpeechRecognizer({ delayMs: 0 });
    await expect(stt.recognize(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(SttError);
  });

  test("既定の文の一覧がある", async () => {
    const stt = new StubSpeechRecognizer({ delayMs: 0 });
    expect((await stt.recognize(wavOf(1000))).text).not.toBe("");
  });
});
