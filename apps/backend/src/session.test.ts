import { describe, expect, test } from "bun:test";
import type { BroadcastMessage, Health, SpeechMessage, Turn } from "@tekurobokun/protocol";
import { type ContentFilter, WordListFilter } from "./content_filter.ts";
import type { LogEntry } from "./conversation_log.ts";
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
  options: {
    llm?: boolean;
    tts?: boolean;
    robot?: boolean;
    displayTurns?: number;
    filter?: ContentFilter;
  } = {},
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
    filter: options.filter,
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

  test("有効でない端末・空の発言・LLMかVOICEVOXが落ちているときは捨てる", async () => {
    const { session, emitted } = setup();
    expect(await session.handleUtterance("phone", "こんにちは")).toBe("inactive_device");
    expect(await session.handleUtterance("tablet", "   ")).toBe("empty");
    const llmDown = setup({ llm: false });
    expect(await llmDown.session.handleUtterance("tablet", "こんにちは")).toBe("llm_unavailable");
    const ttsDown = setup({ tts: false });
    expect(await ttsDown.session.handleUtterance("tablet", "こんにちは")).toBe("tts_unavailable");
    expect(emitted).toHaveLength(0);
    for (const down of [llmDown, ttsDown]) {
      expect(down.emitted).toHaveLength(0);
      expect(down.dialogue.calls).toHaveLength(0);
    }
  });

  test("落ちていたLLM・VOICEVOXが戻れば、また受け付ける", async () => {
    const { session, dialogue, health } = setup({ llm: false, tts: false });
    expect(await session.handleUtterance("tablet", "1")).toBe("llm_unavailable");
    health.value.llm = true;
    expect(await session.handleUtterance("tablet", "2")).toBe("tts_unavailable");
    health.value.tts = true;
    const done = session.handleUtterance("tablet", "3");
    dialogue.answer("a");
    expect(await done).toBe("accepted");
    expect(session.history().map((t) => t.text)).toEqual(["3"]);
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

  test("機体がいない・考え中にVOICEVOXが落ちたときは、返事のあとすぐ待機中", async () => {
    for (const ttsDownWhileThinking of [false, true]) {
      const { session, dialogue, tts, health } = setup({ robot: ttsDownWhileThinking });
      const done = session.handleUtterance("tablet", "こんにちは");
      if (ttsDownWhileThinking) health.value.tts = false;
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

describe("ConversationSession（禁止語）", () => {
  const canned = { say: "その話はやめておきましょう。", emotion: "troubled" as const };
  const filter = () => new WordListFilter({ words: ["バカ"], replies: [canned] });

  test("入力が禁止語に当たったら、LLMに渡さずに定型の返事を返事とする", async () => {
    const { session, dialogue, emitted } = setup({ filter: filter() });
    expect(await session.handleUtterance("tablet", "バカ")).toBe("accepted");
    expect(dialogue.calls).toHaveLength(0);
    expect(session.session).toBe("idle");
    expect(emitted.map((m) => m.type)).toEqual([
      "turn_started",
      "status",
      "turn_replied",
      "status",
    ]);
    expect(emitted[2]).toEqual({ type: "turn_replied", turnId: "t1", ...canned, thinkingMs: 0 });
    expect(session.history()[0]?.reply).toEqual({ ...canned, thinkingMs: 0 });
  });

  test("禁止語に当たった発言は、あとの往復でもLLMに渡さない", async () => {
    const { session, dialogue } = setup({ filter: filter() });
    const first = session.handleUtterance("tablet", "こんにちは");
    dialogue.answer("やあ。");
    await first;
    await session.handleUtterance("tablet", "バカ");
    const third = session.handleUtterance("tablet", "元気？");
    dialogue.answer("元気です。");
    await third;
    expect(dialogue.calls[1]?.history.map((t) => t.text)).toEqual(["こんにちは"]);
    // 表示用の履歴には残る
    expect(session.history().map((t) => t.text)).toEqual(["こんにちは", "バカ", "元気？"]);
  });

  test("LLMの返事が禁止語に当たったら、定型の返事に差し替える（考えた時間はそのまま）", async () => {
    const { session, dialogue, emitted } = setup({ filter: filter() });
    const done = session.handleUtterance("tablet", "何か言って");
    dialogue.answer("バカですね。");
    await done;
    expect(dialogue.calls).toHaveLength(1);
    expect(emitted.find((m) => m.type === "turn_replied")).toEqual({
      type: "turn_replied",
      turnId: "t1",
      ...canned,
      thinkingMs: 1200,
    });
  });

  test("差し替えた返事も、機体がいれば話す", async () => {
    const { session, tts } = setup({ filter: filter(), robot: true });
    await session.handleUtterance("tablet", "バカ");
    expect(session.session).toBe("speaking");
    expect(tts.calls).toEqual([canned.say]);
  });
});

describe("ConversationSession（会話ログ）", () => {
  const canned = { say: "その話はやめておきましょう。", emotion: "troubled" as const };
  function logged(options: Parameters<typeof setup>[0] = {}) {
    const entries: LogEntry[] = [];
    const s = setup(options);
    const session = new ConversationSession({
      dialogue: s.dialogue,
      tts: s.tts,
      filter: options.filter,
      devices: s.devices,
      health: s.health,
      emit: (m) => s.emitted.push(m),
      sendToRobot: (m) => s.speeches.push(m),
      displayTurns: 50,
      speakingGraceMs: 5000,
      now: () => new Date(s.clock.ms),
      timers: s.clock,
      newId: () => "t1",
      record: (e) => entries.push(e),
    });
    return { ...s, session, entries };
  }

  test("返事を得たら1行残す（imple 7節の手順3）", async () => {
    const { session, dialogue, entries } = logged();
    const done = session.handleUtterance("tablet", " こんにちは ");
    expect(entries).toHaveLength(0);
    dialogue.answer("やあ。");
    await done;
    expect(entries).toEqual([
      {
        at: "2026-11-14T10:02:11.000+09:00",
        device: "tablet",
        input: "こんにちは",
        thinkingMs: 1200,
        raw: "やあ。",
        say: "やあ。",
        emotion: "happy",
        filtered: "none",
        error: null,
      },
    ]);
  });

  test("禁止語の入力は、rawとthinkingMsをnull、sayを定型の返事で残す（手順5）", async () => {
    const filter = new WordListFilter({ words: ["バカ"], replies: [canned] });
    const { session, entries } = logged({ filter });
    await session.handleUtterance("tablet", "バカ");
    expect(entries[0]).toMatchObject({
      input: "バカ",
      thinkingMs: null,
      raw: null,
      ...canned,
      filtered: "input",
      error: null,
    });
  });

  test("禁止語の返事は、rawを生の出力のまま、sayを定型の返事で残す（手順6）", async () => {
    const filter = new WordListFilter({ words: ["バカ"], replies: [canned] });
    const { session, dialogue, entries } = logged({ filter });
    const done = session.handleUtterance("tablet", "何か言って");
    dialogue.answer("バカですね。");
    await done;
    expect(entries[0]).toMatchObject({
      thinkingMs: 1200,
      raw: "バカですね。",
      ...canned,
      filtered: "output",
    });
  });

  test("切り替えた端末からの発言は、その端末名で残す（手順8）", async () => {
    const { session, dialogue, devices, entries } = logged();
    devices.setActive("phone");
    const done = session.handleUtterance("phone", "スマホから");
    dialogue.answer("a");
    await done;
    expect(entries[0]?.device).toBe("phone");
  });

  test("LLMが落ちている状態で届いた発言、LLMの失敗は、error付きで残す（手順9）", async () => {
    const failedFields: Omit<LogEntry, "at" | "device" | "input"> = {
      thinkingMs: null,
      raw: null,
      say: null,
      emotion: null,
      filtered: "none",
      error: "llm_unavailable",
    };
    const down = logged({ llm: false });
    expect(await down.session.handleUtterance("tablet", "こんにちは")).toBe("llm_unavailable");
    expect(down.entries).toEqual([
      {
        at: "2026-11-14T10:02:11.000+09:00",
        device: "tablet",
        input: "こんにちは",
        ...failedFields,
      },
    ]);

    const failing = logged();
    const done = failing.session.handleUtterance("tablet", "こんにちは");
    failing.dialogue.fail();
    await done;
    expect(failing.entries[0]).toMatchObject(failedFields);
  });

  test("捨てた発言（考え中・別の端末・空・VOICEVOXが落ちている）は残さない（手順4・二重操作）", async () => {
    const { session, dialogue, entries } = logged();
    const first = session.handleUtterance("tablet", "1つ目");
    await session.handleUtterance("tablet", "1つ目");
    await session.handleUtterance("phone", "別の端末");
    dialogue.answer("a");
    await first;
    await session.handleUtterance("tablet", "  ");
    expect(entries).toHaveLength(1);
    const ttsDown = logged({ tts: false });
    await ttsDown.session.handleUtterance("tablet", "こんにちは");
    expect(ttsDown.entries).toHaveLength(0);
  });

  test("ログから戻した履歴は表示用だけで、LLMには渡さない（手順10）", async () => {
    const { session, dialogue } = logged();
    const restored: Turn[] = [
      {
        id: "log-1",
        at: "2026-11-14T10:00:00.000+09:00",
        device: "tablet",
        text: "前回の発言",
        reply: { say: "前回の返事", emotion: "neutral", thinkingMs: 900 },
      },
    ];
    session.restoreHistory(restored);
    expect(session.history()).toEqual(restored);
    const done = session.handleUtterance("tablet", "こんにちは");
    dialogue.answer("やあ。");
    await done;
    expect(dialogue.calls[0]?.history).toEqual([]);
    expect(session.history().map((t) => t.text)).toEqual(["前回の発言", "こんにちは"]);
  });
});
