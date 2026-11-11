import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AudioPlayer } from "./AudioPlayer";
import type { AudioSlotInfo } from "../config/config";

// bun:testの実行環境にはWeb Audio APIが存在しないため、最小限のフェイクで代替する。
class FakeAudioBufferSourceNode {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  connect(): void {}
  start(): void {}
  stop(): void {
    this.onended?.();
  }
}

class FakeAudioContext {
  destination = {};
  createBufferSource(): FakeAudioBufferSourceNode {
    return new FakeAudioBufferSourceNode();
  }
  decodeAudioData(_arrayBuffer: ArrayBuffer): Promise<unknown> {
    return Promise.resolve({});
  }
}

const ERROR_SOUND: AudioSlotInfo = { filePath: "/audio/error.wav", caption: "エラー" };
const SLOT_A: AudioSlotInfo = { filePath: "/audio/a.wav", caption: "A" };
const SLOT_B: AudioSlotInfo = { filePath: "/audio/b.wav", caption: "B" };

let originalAudioContext: unknown;
let originalFetch: typeof fetch;

beforeEach(() => {
  originalAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;
  originalFetch = globalThis.fetch;
  (globalThis as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  globalThis.fetch = (() =>
    Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) })) as unknown as typeof fetch;
});

afterEach(() => {
  (globalThis as { AudioContext: unknown }).AudioContext = originalAudioContext;
  globalThis.fetch = originalFetch;
});

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe("AudioPlayer", () => {
  test("再生開始時にonPlaybackStartがキャプション付きで呼ばれる", async () => {
    const player = new AudioPlayer(ERROR_SOUND);
    const captions: string[] = [];
    player.onPlaybackStart((caption) => captions.push(caption));

    player.play(SLOT_A);
    await flushMicrotasks();

    expect(captions).toEqual(["A"]);
  });

  test("読み込み中に別スロットへ切り替えると、先の再生は開始されない", async () => {
    const player = new AudioPlayer(ERROR_SOUND);
    const captions: string[] = [];
    player.onPlaybackStart((caption) => captions.push(caption));

    player.play(SLOT_A);
    player.play(SLOT_B); // Aの読み込み完了前に割り込み
    await flushMicrotasks();

    expect(captions).toEqual(["B"]);
  });

  test("EMPTYを渡すと専用エラー音声が再生される", async () => {
    const player = new AudioPlayer(ERROR_SOUND);
    const captions: string[] = [];
    player.onPlaybackStart((caption) => captions.push(caption));

    player.play("EMPTY");
    await flushMicrotasks();

    expect(captions).toEqual(["エラー"]);
  });
});
