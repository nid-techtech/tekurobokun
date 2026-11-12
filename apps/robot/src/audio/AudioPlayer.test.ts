import { describe, expect, test } from "bun:test";
import { type AudioBackend, AudioPlayer, type SpeechItem } from "./AudioPlayer";
import { decodeBase64 } from "./base64";

/** デコードと再生の終わりを外から進めるフェイク。 */
class FakeBackend implements AudioBackend {
  decodes: { bytes: number[]; resolve: (b: AudioBuffer) => void; reject: (e: Error) => void }[] =
    [];
  playing: { buffer: AudioBuffer; end: () => void; stopped: boolean }[] = [];
  level = 0.3;

  resume(): Promise<void> {
    return Promise.resolve();
  }
  decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
    return new Promise((resolve, reject) =>
      this.decodes.push({ bytes: [...new Uint8Array(bytes)], resolve, reject }),
    );
  }
  play(buffer: AudioBuffer, onEnded: () => void): () => void {
    const entry = { buffer, end: onEnded, stopped: false };
    this.playing.push(entry);
    return () => {
      entry.stopped = true;
    };
  }
  rms(): number {
    return this.level;
  }
  /** n番目のデコードを終える（バッファにはその番号を入れる）。 */
  decoded(n: number): void {
    this.decodes[n]?.resolve({ n } as unknown as AudioBuffer);
  }
}

const item = (index: number, last = false): SpeechItem => ({
  turnId: "t1",
  index,
  last,
  text: `文${index}`,
  wav: btoa(String.fromCharCode(index, 1, 2)),
});

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function setup() {
  const backend = new FakeBackend();
  const player = new AudioPlayer(backend);
  const started: number[] = [];
  const ended: number[] = [];
  player.onSentenceStart((s) => started.push(s.index));
  player.onSentenceEnd((s) => ended.push(s.index));
  return { backend, player, started, ended };
}

describe("AudioPlayer", () => {
  test("base64のWAVをデコードし、届いた順に1文ずつ再生する", async () => {
    const { backend, player, started, ended } = setup();
    player.enqueue(item(0));
    player.enqueue(item(1, true));
    expect(backend.decodes.map((d) => d.bytes)).toEqual([
      [0, 1, 2],
      [1, 1, 2],
    ]);

    // 2文目のデコードが先に終わっても、1文目から再生する。
    backend.decoded(1);
    await flush();
    expect(started).toEqual([]);
    backend.decoded(0);
    await flush();
    expect(started).toEqual([0]);
    expect(backend.playing).toHaveLength(1);

    backend.playing[0]?.end();
    await flush();
    expect(ended).toEqual([0]);
    expect(started).toEqual([0, 1]);
    backend.playing[1]?.end();
    await flush();
    expect(ended).toEqual([0, 1]);
    expect(player.playing).toBe(false);
  });

  test("再生中だけ振幅を返す", async () => {
    const { backend, player } = setup();
    expect(player.level()).toBe(0);
    player.enqueue(item(0, true));
    backend.decoded(0);
    await flush();
    expect(player.level()).toBe(0.3);
    backend.playing[0]?.end();
    await flush();
    expect(player.level()).toBe(0);
  });

  test("読めない音声は飛ばし、再生終了は知らせる", async () => {
    const { backend, player, started, ended } = setup();
    player.enqueue(item(0));
    player.enqueue(item(1, true));
    backend.decodes[0]?.reject(new Error("bad wav"));
    backend.decoded(1);
    await flush();
    expect(ended).toEqual([0]);
    expect(started).toEqual([1]);
  });

  test("stopで再生と列を捨て、再生終了は知らせない", async () => {
    const { backend, player, started, ended } = setup();
    player.enqueue(item(0));
    player.enqueue(item(1, true));
    backend.decoded(0);
    await flush();
    player.stop();
    expect(backend.playing[0]?.stopped).toBe(true);
    backend.decoded(1);
    backend.playing[0]?.end();
    await flush();
    expect(started).toEqual([0]);
    expect(ended).toEqual([]);
    expect(player.playing).toBe(false);

    // 止めたあとも、新しい文は再生できる。
    player.enqueue({ ...item(0, true), turnId: "t2" });
    backend.decoded(2);
    await flush();
    expect(started).toEqual([0, 0]);
  });
});

describe("decodeBase64", () => {
  test("バイト列に戻す", () => {
    expect([...new Uint8Array(decodeBase64("AQID"))]).toEqual([1, 2, 3]);
  });
});
