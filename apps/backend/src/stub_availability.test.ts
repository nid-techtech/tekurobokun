import { describe, expect, test } from "bun:test";
import { LlmError } from "./dialogue/engine.ts";
import { DEFAULT_STUB_DATA, StubDialogueEngine } from "./dialogue/stub.ts";
import { HealthMonitor } from "./health.ts";
import { SttError } from "./stt/engine.ts";
import { StubSpeechRecognizer } from "./stt/stub.ts";
import { StubAvailability } from "./stub_availability.ts";
import { TtsError } from "./tts/engine.ts";
import { StubTtsEngine } from "./tts/stub.ts";

describe("StubAvailability", () => {
  test("止めるとヘルスチェックが応答なしになり、戻すと応答ありに戻る", async () => {
    const av = new StubAvailability();
    const health = new HealthMonitor(
      { llm: av.probe("llm"), tts: av.probe("tts"), stt: av.probe("stt") },
      60_000,
    );
    await health.checkNow();
    expect(health.snapshot()).toMatchObject({ llm: true, tts: true, stt: true });

    expect(av.toggle("llm")).toBe(false);
    await health.checkNow();
    expect(health.snapshot()).toMatchObject({ llm: false, tts: true });

    av.toggle("llm");
    av.toggle("tts");
    await health.checkNow();
    expect(health.snapshot()).toMatchObject({ llm: true, tts: false });

    av.toggle("tts");
    av.toggle("stt");
    await health.checkNow();
    expect(health.snapshot()).toMatchObject({ llm: true, tts: true, stt: false });
    health.markSttDown();
    expect(health.snapshot().stt).toBe(false);
  });

  test("止めている間は、スタブのエンジンが失敗する", async () => {
    const av = new StubAvailability();
    const dialogue = new StubDialogueEngine({ ...DEFAULT_STUB_DATA, delayMs: 0 }, () =>
      av.isUp("llm"),
    );
    const tts = new StubTtsEngine({ delayMs: 0, isUp: () => av.isUp("tts") });
    const stt = new StubSpeechRecognizer({ delayMs: 0, isUp: () => av.isUp("stt") });
    av.toggle("llm");
    av.toggle("tts");
    av.toggle("stt");
    await expect(dialogue.reply([], "こんにちは")).rejects.toBeInstanceOf(LlmError);
    await expect(tts.synthesize("やあ。")).rejects.toBeInstanceOf(TtsError);
    await expect(stt.recognize(new Uint8Array(0))).rejects.toBeInstanceOf(SttError);
    av.toggle("llm");
    av.toggle("tts");
    expect((await dialogue.reply([], "こんにちは")).say).not.toBe("");
    expect((await tts.synthesize("やあ。")).durationMs).toBeGreaterThan(0);
  });
});
