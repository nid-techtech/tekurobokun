import { describe, expect, test } from "bun:test";
import type { BroadcastMessage, Health, SpeechMessage, Turn } from "@tekurobokun/protocol";
import { InputDeviceRegistry } from "./devices.ts";
import { type DialogueEngine, type DialogueResult, LlmError } from "./dialogue/engine.ts";
import { ConversationSession, type Timers } from "./session.ts";
import { type Speech, splitSentences, type TtsEngine, TtsError } from "./tts/engine.ts";

/** 合成の結果を外から渡すまで待つTtsEngine。1文の長さは1000ms。 */
class ManualTts implements TtsEngine {
  calls: string[] = [];
  private pending: { resolve: (s: Speech) => void; reject: (e: Error) => void }[] = [];

  split(say: string): string[] {
    return splitSentences(say);
  }
  synthesize(sentence: string): Promise<Speech> {
    this.calls.push(sentence);
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  finish(): void {
    this.pending.shift()?.resolve({ wav: new Uint8Array([1, 2, 3]), durationMs: 1000 });
  }
  fail(): void {
    this.pending.shift()?.reject(new TtsError("down"));
  }
}

/** 手で進める時計とタイマー。 */
class ManualClock implements Timers {
  ms = Date.parse("2026-11-14T01:02:11.000Z");
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
  get pending(): number {
    return this.queue.length;
  }
  advance(ms: number): void {
    this.ms += ms;
    const due = this.queue.filter((t) => t.at <= this.ms);
    this.queue = this.queue.filter((t) => t.at > this.ms);
    for (const t of due) t.fn();
  }
}

/** 返事を外から渡すまで待つDialogueEngine。 */
class ManualDialogue implements DialogueEngine {
  calls: { history: Turn[]; text: string }[] = [];
  private pending: { resolve: (r: DialogueResult) => void; reject: (e: Error) => void }[] = [];

  reply(history: Turn[], text: string): Promise<DialogueResult> {
    this.calls.push({ history, text });
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  answer(say: string): void {
    this.pending.shift()?.resolve({ raw: say, say, emotion: "happy", thinkingMs: 1200 });
  }
  fail(): void {
    this.pending.shift()?.reject(new LlmError("down"));
  }
}

function setup(
  options: { llm?: boolean; tts?: boolean; robot?: boolean; displayTurns?: number } = {},
) {
  const dialogue = new ManualDialogue();
  const tts = new ManualTts();
  const clock = new ManualClock();
  const devices = new InputDeviceRegistry(["tablet", "phone"], "tablet");
  const health = {
    value: {
      backend: true,
      llm: options.llm ?? true,
      tts: options.tts ?? true,
      robot: options.robot ?? false,
    } as Health,
    snapshot() {
      return { ...this.value };
    },
    markLlmDown() {
      this.value.llm = false;
    },
    markTtsDown() {
      this.value.tts = false;
    },
  };
  const emitted: BroadcastMessage[] = [];
  const speeches: SpeechMessage[] = [];
  let id = 0;
  const session = new ConversationSession({
    dialogue,
    tts,
    devices,
    health,
    emit: (m) => emitted.push(m),
    sendToRobot: (m) => speeches.push(m),
    displayTurns: options.displayTurns ?? 50,
    speakingGraceMs: 5000,
    now: () => new Date(clock.ms),
    timers: clock,
    newId: () => `t${++id}`,
  });
  return { session, dialogue, tts, clock, devices, health, emitted, speeches };
}

/** 機体ありで発言し、返事を得て話し中に入ったところまで進める。 */
async function speakingSetup(say = "1文目。2文目！3文目") {
  const s = setup({ robot: true });
  const done = s.session.handleUtterance("tablet", "こんにちは");
  s.dialogue.answer(say);
  expect(await done).toBe("accepted");
  return s;
}

const lastStatus = (emitted: BroadcastMessage[]) =>
  emitted.filter((m) => m.type === "status").at(-1);

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("ConversationSession", () => {
  test("発言→考え中→返事→待機中", async () => {
    const { session, dialogue, emitted } = setup();
    const done = session.handleUtterance("tablet", "  こんにちは ");
    expect(session.session).toBe("thinking");
    expect(emitted).toEqual([
      {
        type: "turn_started",
        turn: {
          id: "t1",
          at: "2026-11-14T10:02:11.000+09:00",
          device: "tablet",
          text: "こんにちは",
        },
      },
      expect.objectContaining({ type: "status", session: "thinking", activeDevice: "tablet" }),
    ]);

    dialogue.answer("やあ。");
    expect(await done).toBe("accepted");
    expect(session.session).toBe("idle");
    expect(emitted.slice(2)).toEqual([
      { type: "turn_replied", turnId: "t1", say: "やあ。", emotion: "happy", thinkingMs: 1200 },
      expect.objectContaining({ type: "status", session: "idle" }),
    ]);
    expect(session.history()).toEqual([
      {
        id: "t1",
        at: "2026-11-14T10:02:11.000+09:00",
        device: "tablet",
        text: "こんにちは",
        reply: { say: "やあ。", emotion: "happy", thinkingMs: 1200 },
      },
    ]);
  });

  test("考え中の発言は捨て、何も送らず記録しない", async () => {
    const { session, dialogue, emitted } = setup();
    const first = session.handleUtterance("tablet", "1つ目");
    const count = emitted.length;
    expect(await session.handleUtterance("tablet", "2つ目")).toBe("busy");
    expect(emitted).toHaveLength(count);
    expect(dialogue.calls).toHaveLength(1);
    dialogue.answer("a");
    await first;
    expect(session.history().map((t) => t.text)).toEqual(["1つ目"]);
  });

  test("有効でない端末・空の発言・LLMが落ちているときは捨てる", async () => {
    const { session, emitted } = setup();
    expect(await session.handleUtterance("phone", "こんにちは")).toBe("inactive_device");
    expect(await session.handleUtterance("tablet", "   ")).toBe("empty");
    const down = setup({ llm: false });
    expect(await down.session.handleUtterance("tablet", "こんにちは")).toBe("llm_unavailable");
    expect(emitted).toHaveLength(0);
    expect(down.emitted).toHaveLength(0);
  });

  test("切り替えた端末から受け付ける", async () => {
    const { session, dialogue, devices } = setup();
    devices.setActive("phone");
    const done = session.handleUtterance("phone", "スマホから");
    dialogue.answer("a");
    expect(await done).toBe("accepted");
    expect(session.history()[0]?.device).toBe("phone");
  });

  test("LLMが失敗したら、llmをfalseにして待機中へ戻る", async () => {
    const { session, dialogue, health, emitted } = setup();
    const done = session.handleUtterance("tablet", "こんにちは");
    dialogue.fail();
    await done;
    expect(session.session).toBe("idle");
    expect(health.value.llm).toBe(false);
    expect(emitted.at(-1)).toMatchObject({
      type: "status",
      session: "idle",
      health: { llm: false },
    });
    expect(emitted.some((m) => m.type === "turn_replied")).toBe(false);
    expect(session.history()[0]?.reply).toBeUndefined();
  });

  test("直近の履歴をDialogueEngineに渡す", async () => {
    const { session, dialogue } = setup();
    for (const text of ["1", "2"]) {
      const done = session.handleUtterance("tablet", text);
      await tick();
      dialogue.answer(`re${text}`);
      await done;
    }
    expect(dialogue.calls[1]?.history.map((t) => [t.text, t.reply?.say])).toEqual([["1", "re1"]]);
  });

  test("表示用の履歴は設定の件数まで", async () => {
    const { session, dialogue } = setup({ displayTurns: 2 });
    for (const text of ["1", "2", "3"]) {
      const done = session.handleUtterance("tablet", text);
      dialogue.answer("a");
      await done;
    }
    expect(session.history().map((t) => t.text)).toEqual(["2", "3"]);
  });

  test("historyは写しを返す", async () => {
    const { session, dialogue } = setup();
    const done = session.handleUtterance("tablet", "a");
    dialogue.answer("b");
    await done;
    const copy = session.history();
    (copy[0] as Turn).text = "changed";
    expect(session.history()[0]?.text).toBe("a");
  });
});

describe("ConversationSession（話し中）", () => {
  test("機体がいれば話し中に入り、1文ずつ合成して送り、最後のplayback_doneで待機中", async () => {
    const { session, tts, emitted, speeches } = await speakingSetup();
    expect(session.session).toBe("speaking");
    expect(emitted.slice(-2)).toEqual([
      expect.objectContaining({ type: "turn_replied", turnId: "t1" }),
      expect.objectContaining({ type: "status", session: "speaking" }),
    ]);

    // 1文目を合成して送ると、機体の再生を待たずに2文目の合成に入る。
    expect(tts.calls).toEqual(["1文目。"]);
    tts.finish();
    await tick();
    expect(speeches.map((s) => [s.index, s.last, s.text])).toEqual([[0, false, "1文目。"]]);
    expect(speeches[0]).toMatchObject({ turnId: "t1", emotion: "happy", wav: "AQID" });
    expect(tts.calls).toEqual(["1文目。", "2文目！"]);

    // 途中の文の再生終了では待機中に戻らない。
    session.handlePlaybackDone("t1", 0);
    expect(session.session).toBe("speaking");

    tts.finish();
    await tick();
    tts.finish();
    await tick();
    expect(speeches.map((s) => [s.index, s.last])).toEqual([
      [0, false],
      [1, false],
      [2, true],
    ]);

    session.handlePlaybackDone("other", 2);
    expect(session.session).toBe("speaking");
    session.handlePlaybackDone("t1", 2);
    expect(session.session).toBe("idle");
    expect(lastStatus(emitted)).toMatchObject({ session: "idle" });
  });

  test("話し中の発言は捨てる", async () => {
    const { session, dialogue } = await speakingSetup();
    expect(await session.handleUtterance("tablet", "割り込み")).toBe("busy");
    expect(dialogue.calls).toHaveLength(1);
  });

  test("機体がいない・VOICEVOXが落ちているときは、返事のあとすぐ待機中", async () => {
    for (const options of [{ robot: false }, { robot: true, tts: false }]) {
      const { session, dialogue, tts } = setup(options);
      const done = session.handleUtterance("tablet", "こんにちは");
      dialogue.answer("やあ。");
      await done;
      expect(session.session).toBe("idle");
      expect(tts.calls).toHaveLength(0);
    }
  });

  test("機体が切断したら、すぐ待機中に戻り、合成の続きは送らない", async () => {
    const { session, tts, speeches, emitted } = await speakingSetup();
    tts.finish();
    await tick();
    session.robotDisconnected();
    expect(session.session).toBe("idle");
    expect(lastStatus(emitted)).toMatchObject({ session: "idle" });
    tts.finish();
    await tick();
    expect(speeches).toHaveLength(1);
    expect(tts.calls).toHaveLength(2);
  });

  test("送った音声の長さ＋余裕を過ぎてもplayback_doneが来なければ待機中", async () => {
    const { session, tts, clock } = await speakingSetup("1文目。2文目。");
    tts.finish();
    await tick();
    clock.advance(300); // 2文目の合成に300msかかった
    tts.finish();
    await tick();
    // 機体は1文目を受け取った時刻から2秒かけて再生する見込み。そこから余裕の5秒まで待つ。
    clock.advance(1700 + 5000 - 1);
    expect(session.session).toBe("speaking");
    clock.advance(1);
    expect(session.session).toBe("idle");
  });

  test("playback_doneで戻ったら、タイムアウトのタイマーは消える", async () => {
    const { session, tts, clock } = await speakingSetup("1文だけ。");
    tts.finish();
    await tick();
    expect(clock.pending).toBe(1);
    session.handlePlaybackDone("t1", 0);
    expect(clock.pending).toBe(0);
  });

  test("合成に失敗したら、ttsをfalseにして待機中", async () => {
    const { session, tts, health, emitted } = await speakingSetup();
    tts.fail();
    await tick();
    expect(session.session).toBe("idle");
    expect(health.value.tts).toBe(false);
    expect(lastStatus(emitted)).toMatchObject({ session: "idle", health: { tts: false } });
  });

  test("読み上げる文がない返事は、話し中に入らない", async () => {
    const { session } = await speakingSetup("   ");
    expect(session.session).toBe("idle");
  });
});
