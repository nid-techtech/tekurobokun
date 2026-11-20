import { describe, expect, test } from "bun:test";
import type { Health, ListeningMessage, StatusMessage, VoiceMessage } from "@tekurobokun/protocol";
import configDefault from "../config/config.default.json";
import { LevelSegmenter } from "./LevelSegmenter";
import { type ListenConditions, shouldListen } from "./listenGate";
import { RESULT_TIMEOUT_MS, type Timers, VoiceCapture } from "./VoiceCapture";
import type { VoiceDetector, VoiceEvents } from "./VoiceDetector";
import { durationMsOf, encodeWav16 } from "./wav";

describe("encodeWav16", () => {
  test("16kHzモノラル16bitのWAVにし、範囲外の値は切り詰める", () => {
    const wav = encodeWav16(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    const view = new DataView(wav.buffer);
    const tag = (o: number) => String.fromCharCode(...wav.subarray(o, o + 4));
    expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(12);
    const samples = [0, 1, 2, 3, 4, 5].map((i) => view.getInt16(44 + i * 2, true));
    expect(samples).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
    expect(durationMsOf(new Float32Array(24_000))).toBe(1500);
  });
});

/** 16kHzで20msの塊 */
const frame = (level: number) => new Float32Array(320).fill(level);

describe("LevelSegmenter", () => {
  const options = { silenceMs: 100, minSpeechMs: 60, preSpeechPadMs: 40, levelThreshold: 0.1 };

  function run(levels: number[]) {
    const events: string[] = [];
    const ends: Float32Array[] = [];
    const seg = new LevelSegmenter(options, {
      onSpeechStart: () => events.push("start"),
      onMisfire: () => events.push("misfire"),
      onSpeechEnd: (a) => {
        events.push("end");
        ends.push(a);
      },
    });
    for (const l of levels) seg.push(frame(l));
    return { seg, events, ends };
  }

  test("しきい値以上が続けば始まり、無音が続けば区切る。前の音と末尾の無音を含める", () => {
    // 無音3つ（前の音は2つまで）→声4つ→無音5つ（100msで区切り）
    const { events, ends } = run([0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0, 0, 0, 0, 0]);
    expect(events).toEqual(["start", "end"]);
    expect(ends[0]?.length).toBe(320 * (2 + 4 + 5));
  });

  test("短い音は声とみなさず、何も知らせない", () => {
    const { events } = run([0.5, 0.5, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0]);
    expect(events).toEqual([]);
  });

  test("止めるときは、submitなら話し途中を渡し、そうでなければ黙って捨てる", () => {
    const a = run([0.5, 0.5, 0.5, 0.5]);
    a.seg.end(true);
    expect(a.events).toEqual(["start", "end"]);
    const b = run([0.5, 0.5, 0.5, 0.5]);
    b.seg.end(false);
    expect(b.events).toEqual(["start"]);
    b.seg.push(frame(0.5));
    expect(b.events).toEqual(["start"]);
  });
});

const health = (h: Partial<Health> = {}): Health => ({
  backend: true,
  llm: true,
  tts: true,
  stt: true,
  robot: true,
  ...h,
});
const status = (over: Partial<StatusMessage> = {}): StatusMessage => ({
  type: "status",
  session: "idle",
  inputSource: "robot",
  micPaused: false,
  health: health(),
  ...over,
});

describe("shouldListen", () => {
  const base: ListenConditions = {
    paired: true,
    connected: true,
    status: status(),
    awaitingResult: false,
    playing: false,
    playbackEndedAt: 0,
    nowMs: 10_000,
    halfDuplexGraceMs: 500,
  };

  test("待機中・聞き取り中で、入力元がrobot、マイクが一時停止でなく、すべて応答していれば聞く", () => {
    expect(shouldListen(base)).toBe(true);
    expect(shouldListen({ ...base, status: status({ session: "listening" }) })).toBe(true);
  });

  test("ほかの条件では聞かない", () => {
    const cases: Partial<ListenConditions>[] = [
      { paired: false },
      { connected: false },
      { status: null },
      { status: status({ inputSource: "tablet" }) },
      { status: status({ micPaused: true }) },
      { status: status({ health: health({ stt: false }) }) },
      { status: status({ health: health({ llm: false }) }) },
      { status: status({ health: health({ tts: false }) }) },
      { status: status({ session: "thinking" }) },
      { status: status({ session: "searching" }) },
      { status: status({ session: "speaking" }) },
      { awaitingResult: true },
      { playing: true },
      { playbackEndedAt: 9_600 },
    ];
    for (const c of cases) expect(shouldListen({ ...base, ...c })).toBe(false);
    expect(shouldListen({ ...base, playbackEndedAt: 9_500 })).toBe(true);
  });
});

class ManualClock implements Timers {
  ms = 0;
  private queue: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 0;
  set(fn: () => void, ms: number): unknown {
    const id = ++this.nextId;
    this.queue.push({ at: this.ms + ms, fn, id });
    return id;
  }
  clear(handle: unknown): void {
    this.queue = this.queue.filter((t) => t.id !== handle);
  }
  advance(ms: number): void {
    this.ms += ms;
    const due = this.queue.filter((t) => t.at <= this.ms);
    this.queue = this.queue.filter((t) => t.at > this.ms);
    for (const t of due) t.fn();
  }
}

/** 開始・停止を記録し、できごとを外から起こせる検出部。 */
class FakeDetector implements VoiceDetector {
  calls: string[] = [];
  constructor(readonly events: VoiceEvents) {}
  async start(): Promise<void> {
    this.calls.push("start");
  }
  async pause(submit: boolean): Promise<void> {
    this.calls.push(submit ? "pause(submit)" : "pause");
    if (submit) this.events.onSpeechEnd(new Float32Array(1600));
  }
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function setup() {
  const clock = new ManualClock();
  const sent: (ListeningMessage | VoiceMessage)[] = [];
  let detector: FakeDetector | null = null;
  const voice = new VoiceCapture({
    createDetector: (events) => {
      detector = new FakeDetector(events);
      return detector;
    },
    send: (m) => sent.push(m),
    maxUtteranceMs: 15_000,
    halfDuplexGraceMs: 500,
    timers: clock,
    now: () => clock.ms,
    log: () => {},
  });
  const d = detector as unknown as FakeDetector;
  const link = (s: Partial<StatusMessage> = {}) =>
    voice.setLink({ paired: true, connected: true, status: status(s) });
  return { voice, clock, sent, detector: d, link };
}

describe("VoiceCapture", () => {
  test("聞ける間だけ検出部を動かし、声でlistening、区切りでvoiceを送り、結果が届くまで止める", async () => {
    const { voice, sent, detector, link } = setup();
    link();
    await flush();
    expect(detector.calls).toEqual(["start"]);
    expect(voice.active).toBe(true);

    voice.onSpeechStart();
    expect(sent).toEqual([{ type: "listening", active: true }]);
    link({ session: "listening" });
    voice.onSpeechEnd(new Float32Array(16_000));
    expect(sent[1]).toMatchObject({ type: "voice", durationMs: 1000 });
    const wav = atob((sent[1] as VoiceMessage).wav);
    expect(wav.slice(0, 4)).toBe("RIFF");
    await flush();
    expect(detector.calls).toEqual(["start", "pause"]);

    // 文字にしている間（聞き取り中のまま）は聞かない。考え中・話し中も聞かない
    link({ session: "listening" });
    link({ session: "thinking" });
    link({ session: "speaking" });
    await flush();
    expect(detector.calls).toEqual(["start", "pause"]);
    link({ session: "idle" });
    await flush();
    expect(detector.calls).toEqual(["start", "pause", "start"]);
  });

  test("STTの結果が空（聞き取り中から待機中）なら、すぐまた聞く", async () => {
    const { voice, detector, link } = setup();
    link();
    voice.onSpeechStart();
    link({ session: "listening" });
    voice.onSpeechEnd(new Float32Array(8000));
    link({ session: "idle" });
    await flush();
    expect(detector.calls).toEqual(["start", "pause", "start"]);
  });

  test("再生中と、終わってから余裕の時間は聞かない（半二重）", async () => {
    const { voice, clock, detector, link } = setup();
    link();
    voice.setPlaying(true);
    await flush();
    expect(detector.calls).toEqual(["start", "pause"]);
    voice.setPlaying(false);
    clock.advance(499);
    await flush();
    expect(detector.calls).toHaveLength(2);
    clock.advance(1);
    await flush();
    expect(detector.calls).toEqual(["start", "pause", "start"]);
  });

  test("話している途中で聞けなくなったら、listening: falseを送って止める", async () => {
    const { voice, sent, detector, link } = setup();
    link();
    voice.onSpeechStart();
    link({ micPaused: true });
    await flush();
    expect(sent).toEqual([
      { type: "listening", active: true },
      { type: "listening", active: false },
    ]);
    expect(detector.calls).toEqual(["start", "pause"]);
    link({ inputSource: "tablet" });
    link({ health: health({ stt: false }) });
    await flush();
    expect(detector.calls).toEqual(["start", "pause"]);
  });

  test("取り消しでlistening: false。動かしていない間のできごとは無視する", async () => {
    const { voice, sent, link } = setup();
    voice.onSpeechStart();
    expect(sent).toEqual([]);
    link();
    voice.onSpeechStart();
    voice.onMisfire();
    voice.onMisfire();
    expect(sent).toEqual([
      { type: "listening", active: true },
      { type: "listening", active: false },
    ]);
  });

  test("最大の長さに達したら、そこまでを送る", async () => {
    const { voice, clock, sent, detector, link } = setup();
    link();
    voice.onSpeechStart();
    clock.advance(15_000);
    await flush();
    expect(detector.calls).toEqual(["start", "pause(submit)"]);
    expect(sent.map((m) => m.type)).toEqual(["listening", "voice"]);
  });

  test("結果が届かなければ、時間をおいてまた聞く", async () => {
    const { voice, clock, detector, link } = setup();
    link();
    voice.onSpeechStart();
    voice.onSpeechEnd(new Float32Array(1600));
    await flush();
    expect(detector.calls).toEqual(["start", "pause"]);
    clock.advance(RESULT_TIMEOUT_MS);
    await flush();
    expect(detector.calls).toEqual(["start", "pause", "start"]);
  });

  test("設定の既定値（imple 6節）", () => {
    expect(configDefault.voice).toMatchObject({
      detector: "silero",
      silenceMs: 800,
      maxUtteranceMs: 15_000,
      halfDuplexGraceMs: 500,
    });
  });
});
