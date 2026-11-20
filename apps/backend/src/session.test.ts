import { describe, expect, test } from "bun:test";
import type {
  BroadcastMessage,
  Health,
  LlmAlias,
  SpeechMessage,
  Turn,
} from "@tekurobokun/protocol";
import { type ContentFilter, WordListFilter } from "./content_filter.ts";
import type { ClearEntry, LogEntry } from "./conversation_log.ts";
import {
  type DialogueEngine,
  type DialogueResult,
  type FirstReplyResult,
  LlmError,
  LlmTimeoutError,
  type ReplyOptions,
} from "./dialogue/engine.ts";
import { InputSourceRegistry } from "./input_sources.ts";
import { SearchError, type SearchResult, type WebSearcher } from "./search/engine.ts";
import { ConversationSession, DEFAULT_LISTENING_TIMEOUT_MS, type Timers } from "./session.ts";
import { type Recognition, type SpeechRecognizer, SttError } from "./stt/engine.ts";
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

/** 文字にした結果を外から渡すまで待つSpeechRecognizer。 */
class ManualStt implements SpeechRecognizer {
  calls: Uint8Array[] = [];
  private pending: { resolve: (r: Recognition) => void; reject: (e: Error) => void }[] = [];

  recognize(wav: Uint8Array): Promise<Recognition> {
    this.calls.push(wav);
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  async probe(): Promise<boolean> {
    return true;
  }
  answer(text: string, ms = 700): void {
    this.pending.shift()?.resolve({ text, ms });
  }
  fail(): void {
    this.pending.shift()?.reject(new SttError("down"));
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

/** 結果を外から渡すまで待つWebSearcher。 */
class ManualSearcher implements WebSearcher {
  queries: string[] = [];
  private pending: {
    resolve: (r: { results: SearchResult[]; ms: number }) => void;
    reject: (e: Error) => void;
  }[] = [];

  search(query: string): Promise<{ results: SearchResult[]; ms: number }> {
    this.queries.push(query);
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  monthCount() {
    return { month: "2026-11", count: this.queries.length };
  }
  answer(results: SearchResult[] = [{ title: "T", url: "https://a.example", snippet: "S" }]) {
    this.pending.shift()?.resolve({ results, ms: 900 });
  }
  fail(): void {
    this.pending.shift()?.reject(new SearchError("quota", "used up", 300));
  }
}

/** 返事を外から渡すまで待つDialogueEngine。 */
class ManualDialogue implements DialogueEngine {
  calls: { history: Turn[]; text: string }[] = [];
  private pending: {
    resolve: (r: FirstReplyResult) => void;
    reject: (e: Error) => void;
  }[] = [];
  private alias: LlmAlias = "main";

  activeModel(): LlmAlias {
    return this.alias;
  }
  setModel(alias: LlmAlias): void {
    this.alias = alias;
  }
  options: ReplyOptions[] = [];
  /** 2回目の問い合わせ（検索語と結果） */
  finals: { text: string; query: string; results: SearchResult[] | null }[] = [];
  private pendingFinal: {
    resolve: (r: DialogueResult) => void;
    reject: (e: Error) => void;
  }[] = [];

  reply(history: Turn[], text: string, opts: ReplyOptions): Promise<FirstReplyResult> {
    this.calls.push({ history, text });
    this.options.push(opts);
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  replyWithResults(
    history: Turn[],
    text: string,
    query: string,
    results: SearchResult[] | null,
    opts: ReplyOptions,
  ): Promise<DialogueResult> {
    this.calls.push({ history, text });
    this.options.push(opts);
    this.finals.push({ text, query, results });
    return new Promise((resolve, reject) => this.pendingFinal.push({ resolve, reject }));
  }
  answer(say: string, search: string | null = null): void {
    this.pending.shift()?.resolve({
      raw: search === null ? say : `first:${say}`,
      say,
      emotion: search === null ? "happy" : "curious",
      thinkingMs: 1200,
      search,
      model: this.alias,
    });
  }
  answerFinal(say: string): void {
    this.pendingFinal.shift()?.resolve({
      raw: `final:${say}`,
      say,
      emotion: "happy",
      thinkingMs: 800,
      model: this.alias,
    });
  }
  fail(error: Error = new LlmError("down")): void {
    this.pending.shift()?.reject(error);
  }
  failFinal(): void {
    this.pendingFinal.shift()?.reject(new LlmError("down"));
  }
}

function setup(
  options: {
    llm?: boolean;
    tts?: boolean;
    stt?: boolean;
    robot?: boolean;
    /** 起動時の入力元（既定tablet） */
    active?: string;
    displayTurns?: number;
    filter?: ContentFilter;
  } = {},
) {
  const dialogue = new ManualDialogue();
  const tts = new ManualTts();
  const stt = new ManualStt();
  const searcher = new ManualSearcher();
  const clock = new ManualClock();
  const sources = new InputSourceRegistry(["tablet", "phone"], options.active ?? "tablet");
  const health = {
    value: {
      backend: true,
      llm: options.llm ?? true,
      tts: options.tts ?? true,
      stt: options.stt ?? true,
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
    markSttDown() {
      this.value.stt = false;
    },
  };
  const emitted: BroadcastMessage[] = [];
  const speeches: SpeechMessage[] = [];
  let id = 0;
  const timeouts: number[] = [];
  const session = new ConversationSession({
    dialogue,
    filter: options.filter,
    tts,
    stt,
    searcher,
    sources,
    health,
    emit: (m) => emitted.push(m),
    sendToRobot: (m) => speeches.push(m),
    displayTurns: options.displayTurns ?? 50,
    speakingGraceMs: 5000,
    now: () => new Date(clock.ms),
    timers: clock,
    newId: () => `t${++id}`,
    onLlmTimeout: () => timeouts.push(clock.ms),
  });
  return {
    session,
    dialogue,
    tts,
    stt,
    searcher,
    clock,
    sources,
    health,
    emitted,
    speeches,
    timeouts,
  };
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
          source: "tablet",
          via: "text",
          text: "こんにちは",
        },
      },
      expect.objectContaining({ type: "status", session: "thinking", inputSource: "tablet" }),
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
        source: "tablet",
        via: "text",
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
    const { session, dialogue, sources } = setup();
    sources.setActive("phone");
    const done = session.handleUtterance("phone", "スマホから");
    dialogue.answer("a");
    expect(await done).toBe("accepted");
    expect(session.history()[0]?.source).toBe("phone");
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
    const clears: ClearEntry[] = [];
    const s = setup(options);
    const session = new ConversationSession({
      dialogue: s.dialogue,
      tts: s.tts,
      stt: s.stt,
      searcher: s.searcher,
      filter: options.filter,
      sources: s.sources,
      health: s.health,
      emit: (m) => s.emitted.push(m),
      sendToRobot: (m) => s.speeches.push(m),
      displayTurns: 50,
      speakingGraceMs: 5000,
      now: () => new Date(s.clock.ms),
      timers: s.clock,
      newId: () => "t1",
      record: (e) => (e.kind === "turn" ? entries.push(e) : clears.push(e)),
    });
    return { ...s, session, entries, clears };
  }

  test("返事を得たら1行残す（imple 7節の手順3）", async () => {
    const { session, dialogue, entries } = logged();
    const done = session.handleUtterance("tablet", " こんにちは ");
    expect(entries).toHaveLength(0);
    dialogue.answer("やあ。");
    await done;
    expect(entries).toEqual([
      {
        kind: "turn",
        at: "2026-11-14T10:02:11.000+09:00",
        source: "tablet",
        via: "text",
        input: "こんにちは",
        stt: null,
        thinkingMs: 1200,
        raw: "やあ。",
        rawFirst: null,
        search: null,
        model: "main",
        antiLoop: false,
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
    const { session, dialogue, sources, entries } = logged();
    sources.setActive("phone");
    const done = session.handleUtterance("phone", "スマホから");
    dialogue.answer("a");
    await done;
    expect(entries[0]?.source).toBe("phone");
  });

  test("LLMが落ちている状態で届いた発言、LLMの失敗は、error付きで残す（手順9）", async () => {
    const failedFields: Omit<LogEntry, "kind" | "at" | "source" | "via" | "input" | "stt"> = {
      thinkingMs: null,
      raw: null,
      rawFirst: null,
      search: null,
      model: null,
      antiLoop: false,
      say: null,
      emotion: null,
      filtered: "none",
      error: "llm_unavailable",
    };
    const down = logged({ llm: false });
    expect(await down.session.handleUtterance("tablet", "こんにちは")).toBe("llm_unavailable");
    expect(down.entries).toEqual([
      {
        kind: "turn",
        at: "2026-11-14T10:02:11.000+09:00",
        source: "tablet",
        via: "text",
        input: "こんにちは",
        stt: null,
        ...failedFields,
      },
    ]);

    const failing = logged();
    const done = failing.session.handleUtterance("tablet", "こんにちは");
    failing.dialogue.fail();
    await done;
    expect(failing.entries[0]).toMatchObject({ ...failedFields, model: "main" });
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
        source: "tablet",
        via: "text",
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

describe("ConversationSession（機体のマイク）", () => {
  const wav = new Uint8Array([1, 2, 3, 4]);
  const statuses = (emitted: BroadcastMessage[]) =>
    emitted.filter((m) => m.type === "status").map((m) => m.type === "status" && m.session);
  /** 文字にした結果を受け取ってから、返事を求めるところまで進める */
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  function robotSetup(options: Parameters<typeof setup>[0] = {}) {
    const entries: LogEntry[] = [];
    const clears: ClearEntry[] = [];
    const s = setup({ active: "robot", robot: true, ...options });
    let id = 0;
    const session = new ConversationSession({
      dialogue: s.dialogue,
      tts: s.tts,
      stt: s.stt,
      searcher: s.searcher,
      sources: s.sources,
      health: s.health,
      emit: (m) => s.emitted.push(m),
      sendToRobot: (m) => s.speeches.push(m),
      displayTurns: 50,
      speakingGraceMs: 5000,
      now: () => new Date(s.clock.ms),
      timers: s.clock,
      newId: () => `v${++id}`,
      record: (e) => (e.kind === "turn" ? entries.push(e) : clears.push(e)),
    });
    return { ...s, session, entries, clears };
  }

  test("listening→聞き取り中→voice→STT→考え中→返事→話し中。(mic)の発言として残す", async () => {
    const { session, stt, dialogue, emitted, entries, clock } = robotSetup();
    session.handleListening(true);
    expect(session.session).toBe("listening");
    expect(session.status()).toMatchObject({ inputSource: "robot", micPaused: false });
    clock.advance(1500);
    const done = session.handleVoice(wav);
    expect(stt.calls).toEqual([wav]);
    // 文字にしている間は聞き取り中のまま。取り消しも、2つ目の声も受け付けない
    session.handleListening(false);
    expect(session.session).toBe("listening");
    expect(await session.handleVoice(wav)).toBe("busy");
    stt.answer(" こんにちは ", 640);
    await settle();
    expect(session.session).toBe("thinking");
    expect(dialogue.calls[0]?.text).toBe("こんにちは");
    dialogue.answer("やあ。");
    expect(await done).toBe("accepted");
    expect(session.session).toBe("speaking");
    expect(statuses(emitted)).toEqual(["listening", "thinking", "speaking"]);
    const started = emitted.find((m) => m.type === "turn_started");
    expect(started).toMatchObject({
      turn: {
        source: "robot",
        via: "mic",
        text: "こんにちは",
        at: "2026-11-14T10:02:12.500+09:00",
      },
    });
    expect(entries).toEqual([
      {
        kind: "turn",
        at: "2026-11-14T10:02:12.500+09:00",
        source: "robot",
        via: "mic",
        input: "こんにちは",
        stt: { ms: 640 },
        thinkingMs: 1200,
        raw: "やあ。",
        rawFirst: null,
        search: null,
        model: "main",
        antiLoop: false,
        say: "やあ。",
        emotion: "happy",
        filtered: "none",
        error: null,
      },
    ]);
  });

  test("listeningなしでvoiceが届いても、聞き取り中にしてから文字にする", async () => {
    const { session, stt, dialogue, emitted } = robotSetup({ robot: false });
    const done = session.handleVoice(wav);
    expect(session.session).toBe("listening");
    stt.answer("やあ");
    await settle();
    dialogue.answer("こんにちは。");
    await done;
    expect(statuses(emitted)).toEqual(["listening", "thinking", "idle"]);
  });

  test("入力元がrobotでない・マイクの一時停止中・待機中でない声は、STTに渡さず記録しない", async () => {
    const other = robotSetup({ active: "tablet" });
    other.session.handleListening(true);
    expect(other.session.session).toBe("idle");
    expect(await other.session.handleVoice(wav)).toBe("inactive_device");

    const paused = robotSetup();
    paused.sources.setMicPaused(true);
    paused.session.handleListening(true);
    expect(paused.session.session).toBe("idle");
    expect(await paused.session.handleVoice(wav)).toBe("mic_paused");
    expect(paused.session.status().micPaused).toBe(true);

    const busy = robotSetup();
    busy.sources.setActive("tablet");
    const typing = busy.session.handleUtterance("tablet", "文字");
    busy.sources.setActive("robot");
    expect(busy.session.session).toBe("thinking");
    busy.session.handleListening(true);
    expect(busy.session.session).toBe("thinking");
    expect(await busy.session.handleVoice(wav)).toBe("busy");
    busy.dialogue.answer("a。");
    await typing;
    expect(busy.session.session).toBe("speaking");
    expect(await busy.session.handleVoice(wav)).toBe("busy");

    for (const s of [other, paused, busy]) expect(s.stt.calls).toHaveLength(0);
    expect(busy.entries.map((e) => e.via)).toEqual(["text"]);
  });

  test("STT・LLM・VOICEVOXのどれかが落ちていれば、聞かず、声も渡さない", async () => {
    for (const down of [{ stt: false }, { llm: false }, { tts: false }]) {
      const s = robotSetup(down);
      s.session.handleListening(true);
      expect(s.session.session).toBe("idle");
      await s.session.handleVoice(wav);
      expect(s.stt.calls).toHaveLength(0);
      expect(s.entries).toHaveLength(0);
    }
  });

  test("STTの結果が空なら、記録せずに待機中へ戻る", async () => {
    const { session, stt, dialogue, entries, emitted } = robotSetup();
    session.handleListening(true);
    const done = session.handleVoice(wav);
    stt.answer("  ");
    expect(await done).toBe("empty");
    expect(session.session).toBe("idle");
    expect(dialogue.calls).toHaveLength(0);
    expect(entries).toHaveLength(0);
    expect(emitted.some((m) => m.type === "turn_started")).toBe(false);
    expect(statuses(emitted)).toEqual(["listening", "idle"]);
  });

  test("STTが失敗したら、sttをfalseにして待機中へ戻り、error付きで残す", async () => {
    const { session, stt, health, entries } = robotSetup();
    const done = session.handleVoice(wav);
    stt.fail();
    expect(await done).toBe("stt_unavailable");
    expect(session.session).toBe("idle");
    expect(health.value.stt).toBe(false);
    expect(entries).toEqual([
      {
        kind: "turn",
        at: "2026-11-14T10:02:11.000+09:00",
        source: "robot",
        via: "mic",
        input: "",
        stt: null,
        thinkingMs: null,
        raw: null,
        rawFirst: null,
        search: null,
        model: null,
        antiLoop: false,
        say: null,
        emotion: null,
        filtered: "none",
        error: "stt_unavailable",
      },
    ]);
    // 落ちている間は聞かない。戻れば、また聞く
    session.handleListening(true);
    expect(session.session).toBe("idle");
    health.value.stt = true;
    session.handleListening(true);
    expect(session.session).toBe("listening");
  });

  test("文字にしている間にLLMが落ちたら、文字にした発言をerror付きで残して待機中へ", async () => {
    const { session, stt, health, entries, dialogue } = robotSetup();
    const done = session.handleVoice(wav);
    health.value.llm = false;
    stt.answer("こんにちは", 500);
    expect(await done).toBe("llm_unavailable");
    expect(session.session).toBe("idle");
    expect(dialogue.calls).toHaveLength(0);
    expect(entries[0]).toMatchObject({
      input: "こんにちは",
      via: "mic",
      stt: { ms: 500 },
      error: "llm_unavailable",
    });
  });

  test("取り消し・時間切れ・入力元の切り替え・マイクの一時停止・機体の切断で、聞き取り中から待機中へ", () => {
    const { session, sources, clock } = robotSetup();
    session.handleListening(true);
    session.handleListening(false);
    expect(session.session).toBe("idle");
    expect(clock.pending).toBe(0);

    session.handleListening(true);
    clock.advance(DEFAULT_LISTENING_TIMEOUT_MS - 1);
    expect(session.session).toBe("listening");
    clock.advance(1);
    expect(session.session).toBe("idle");

    session.handleListening(true);
    sources.setActive("tablet");
    session.inputConditionsChanged();
    expect(session.session).toBe("idle");
    sources.setActive("robot");

    session.handleListening(true);
    sources.setMicPaused(true);
    session.inputConditionsChanged();
    expect(session.session).toBe("idle");
    sources.setMicPaused(false);

    session.handleListening(true);
    session.robotDisconnected();
    expect(session.session).toBe("idle");
    expect(clock.pending).toBe(0);
  });

  test("文字にしている間は、入力元を切り替えても結果を待つ", async () => {
    const { session, sources, stt, dialogue } = robotSetup({ robot: false });
    const done = session.handleVoice(wav);
    sources.setActive("tablet");
    session.inputConditionsChanged();
    expect(session.session).toBe("listening");
    stt.answer("やあ");
    await settle();
    dialogue.answer("a");
    expect(await done).toBe("accepted");
  });
});

describe("ConversationSession（調べ中）", () => {
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const sessions = (emitted: BroadcastMessage[]) =>
    emitted.filter((m) => m.type === "status").map((m) => m.type === "status" && m.session);

  function searchSetup(options: Parameters<typeof setup>[0] = {}) {
    const entries: LogEntry[] = [];
    const clears: ClearEntry[] = [];
    const s = setup(options);
    const timeouts: number[] = [];
    const session = new ConversationSession({
      dialogue: s.dialogue,
      tts: s.tts,
      stt: s.stt,
      searcher: s.searcher,
      filter: options.filter,
      sources: s.sources,
      health: s.health,
      emit: (m) => s.emitted.push(m),
      sendToRobot: (m) => s.speeches.push(m),
      displayTurns: 50,
      speakingGraceMs: 5000,
      now: () => new Date(s.clock.ms),
      timers: s.clock,
      newId: () => "t1",
      record: (e) => (e.kind === "turn" ? entries.push(e) : clears.push(e)),
      onLlmTimeout: () => timeouts.push(s.clock.ms),
    });
    return { ...s, session, entries, clears, timeouts };
  }

  test("機体なし：検索語があれば調べ中、検索の結果つきで2回目、返事、待機中。ログに検索を残す", async () => {
    const { session, dialogue, searcher, emitted, entries } = searchSetup();
    const done = session.handleUtterance("tablet", "東京タワーの高さは？");
    dialogue.answer("ちょっと調べてみるね。", "東京タワー 高さ");
    await settle();
    expect(session.session).toBe("searching");
    expect(searcher.queries).toEqual(["東京タワー 高さ"]);
    expect(emitted.find((m) => m.type === "turn_search_started")).toEqual({
      type: "turn_search_started",
      turnId: "t1",
      query: "東京タワー 高さ",
      preSay: "ちょっと調べてみるね。",
      emotion: "curious",
      thinkingMs: 1200,
    });
    // 調べている間は、新しい発言を受け付けない
    expect(await session.handleUtterance("tablet", "まだ？")).toBe("busy");

    searcher.answer([{ title: "T", url: "https://a.example", snippet: "333m" }]);
    await settle();
    expect(emitted.find((m) => m.type === "turn_search_done")).toEqual({
      type: "turn_search_done",
      turnId: "t1",
      searchMs: 900,
      ok: true,
    });
    expect(dialogue.finals).toEqual([
      {
        text: "東京タワーの高さは？",
        query: "東京タワー 高さ",
        results: [{ title: "T", url: "https://a.example", snippet: "333m" }],
      },
    ]);
    expect(session.session).toBe("searching");
    dialogue.answerFinal("高さは333メートルです。");
    await done;
    expect(session.session).toBe("idle");
    expect(sessions(emitted)).toEqual(["thinking", "searching", "idle"]);
    expect(emitted.find((m) => m.type === "turn_replied")).toMatchObject({
      say: "高さは333メートルです。",
      thinkingMs: 800,
    });
    expect(session.history()[0]).toMatchObject({
      search: {
        query: "東京タワー 高さ",
        preSay: "ちょっと調べてみるね。",
        searchMs: 900,
        ok: true,
      },
      reply: { say: "高さは333メートルです。", thinkingMs: 800 },
    });
    expect(entries[0]).toMatchObject({
      thinkingMs: 2000,
      raw: "final:高さは333メートルです。",
      rawFirst: "first:ちょっと調べてみるね。",
      search: { query: "東京タワー 高さ", ms: 900, urls: ["https://a.example"], ok: true },
      model: "main",
      say: "高さは333メートルです。",
      error: null,
    });
  });

  test("機体あり：前置きを話し、検索と前置きの再生の両方を待ってから2回目。返事の文の番号は前置きの続き", async () => {
    const { session, dialogue, searcher, tts, speeches, clock } = searchSetup({ robot: true });
    const done = session.handleUtterance("tablet", "長岡の花火は？");
    dialogue.answer("ちょっと調べてみるね。", "長岡 花火");
    await settle();
    expect(tts.calls).toEqual(["ちょっと調べてみるね。"]);
    tts.finish();
    await settle();
    expect(speeches.map((m) => [m.turnId, m.index, m.last, m.text])).toEqual([
      ["t1", 0, true, "ちょっと調べてみるね。"],
    ]);
    // 検索が先に終わっても、前置きの再生を待つ
    searcher.answer();
    await settle();
    expect(dialogue.finals).toHaveLength(0);
    clock.advance(500);
    session.handlePlaybackDone("t1", 0);
    await settle();
    expect(dialogue.finals).toHaveLength(1);
    expect(session.session).toBe("searching");
    dialogue.answerFinal("大きな花火です。三尺玉が有名です。");
    await done;
    expect(session.session).toBe("speaking");
    tts.finish();
    await settle();
    tts.finish();
    await settle();
    expect(speeches.slice(1).map((m) => [m.index, m.last])).toEqual([
      [1, false],
      [2, true],
    ]);
    session.handlePlaybackDone("t1", 2);
    expect(session.session).toBe("idle");
  });

  test("前置きの再生が先に終わっても、検索を待つ。機体が切れたら前置きは待たない", async () => {
    const { session, dialogue, searcher, tts, health } = searchSetup({ robot: true });
    const done = session.handleUtterance("tablet", "q");
    dialogue.answer("調べるね。", "q");
    await settle();
    tts.finish();
    await settle();
    health.value.robot = false;
    session.robotDisconnected();
    await settle();
    expect(dialogue.finals).toHaveLength(0);
    searcher.answer();
    await settle();
    expect(dialogue.finals).toHaveLength(1);
    dialogue.answerFinal("答え。");
    await done;
    expect(session.session).toBe("idle");
  });

  test("検索の失敗は、結果なし（null）で2回目を問い合わせ、ok: falseで残す", async () => {
    const { session, dialogue, searcher, emitted, entries } = searchSetup();
    const done = session.handleUtterance("tablet", "q");
    dialogue.answer("調べるね。", "q");
    await settle();
    searcher.fail();
    await settle();
    expect(emitted.find((m) => m.type === "turn_search_done")).toMatchObject({
      searchMs: 300,
      ok: false,
    });
    expect(dialogue.finals[0]?.results).toBeNull();
    dialogue.answerFinal("調べられませんでした。");
    await done;
    expect(entries[0]?.search).toEqual({ query: "q", ms: 300, urls: [], ok: false });
    expect(entries[0]?.error).toBeNull();
  });

  test("2回目に失敗したら、検索の情報つきでllm_unavailableを残し、待機中へ", async () => {
    const { session, dialogue, searcher, entries, health } = searchSetup();
    const done = session.handleUtterance("tablet", "q");
    dialogue.answer("調べるね。", "q");
    await settle();
    searcher.answer();
    await settle();
    dialogue.failFinal();
    await done;
    expect(session.session).toBe("idle");
    expect(health.value.llm).toBe(false);
    expect(entries[0]).toMatchObject({
      rawFirst: "first:調べるね。",
      search: { query: "q", ok: true },
      say: null,
      error: "llm_unavailable",
    });
    expect(session.history()[0]?.reply).toBeUndefined();
  });

  test("前置きが禁止語に当たったら、検索せずに定型の返事", async () => {
    const canned = { say: "その話はやめておきましょう。", emotion: "troubled" as const };
    const filter = new WordListFilter({ words: ["バカ"], replies: [canned] });
    const { session, dialogue, searcher, entries } = searchSetup({ filter });
    const done = session.handleUtterance("tablet", "q");
    dialogue.answer("バカを調べるね。", "q");
    await done;
    expect(searcher.queries).toEqual([]);
    expect(entries[0]).toMatchObject({ ...canned, filtered: "output", search: null });
  });

  test("LLMの時間切れは、llm_timeoutとして知らせる", async () => {
    const { session, dialogue, timeouts } = searchSetup();
    const done = session.handleUtterance("tablet", "q");
    dialogue.fail(new LlmTimeoutError("slow"));
    await done;
    expect(timeouts).toHaveLength(1);
    const again = searchSetup();
    const done2 = again.session.handleUtterance("tablet", "q");
    again.dialogue.fail();
    await done2;
    expect(again.timeouts).toHaveLength(0);
  });
});

describe("ConversationSession（質問のループ・履歴の区切り）", () => {
  const IDLE_RESET_MS = 90_000;
  const cleared = (emitted: BroadcastMessage[]) =>
    emitted.filter((m) => m.type === "history_cleared");

  function loopSetup(options: Parameters<typeof setup>[0] = {}) {
    const entries: LogEntry[] = [];
    const clears: ClearEntry[] = [];
    const reasons: string[] = [];
    const s = setup(options);
    let id = 0;
    const session = new ConversationSession({
      dialogue: s.dialogue,
      tts: s.tts,
      stt: s.stt,
      searcher: s.searcher,
      sources: s.sources,
      health: s.health,
      emit: (m) => s.emitted.push(m),
      sendToRobot: (m) => s.speeches.push(m),
      displayTurns: 50,
      speakingGraceMs: 5000,
      now: () => new Date(s.clock.ms),
      timers: s.clock,
      newId: () => `t${++id}`,
      questionLoopThreshold: 2,
      idleResetMs: IDLE_RESET_MS,
      record: (e) => (e.kind === "turn" ? entries.push(e) : clears.push(e)),
      onHistoryCleared: (reason) => reasons.push(reason),
    });
    /** 1往復する（機体なし） */
    const turn = async (text: string, say: string) => {
      const done = session.handleUtterance("tablet", text);
      s.dialogue.answer(say);
      await done;
    };
    return { ...s, session, entries, clears, reasons, turn };
  }

  test("直近の返事が2回続けて質問で終わったら、指示を足してログに残す", async () => {
    const { dialogue, entries, turn } = loopSetup();
    await turn("a", "何が好き？");
    await turn("b", "どうして？");
    await turn("c", "わたしは電池が好きです。");
    await turn("d", "なぜ？");
    expect(dialogue.options.map((o) => o.antiLoop)).toEqual([false, false, true, false]);
    expect(entries.map((e) => e.antiLoop)).toEqual([false, false, true, false]);
  });

  test("返事が終わってから90秒だれも話さなければ、LLMの履歴を消して区切りを配信し、ログに残す", async () => {
    const { session, dialogue, emitted, clears, reasons, clock, turn } = loopSetup();
    await turn("a", "やあ。");
    clock.advance(IDLE_RESET_MS - 1);
    expect(cleared(emitted)).toHaveLength(0);
    clock.advance(1);
    expect(cleared(emitted)).toEqual([
      { type: "history_cleared", at: "2026-11-14T10:03:41.000+09:00", reason: "idle" },
    ]);
    expect(clears).toEqual([
      { kind: "history_cleared", at: "2026-11-14T10:03:41.000+09:00", reason: "idle" },
    ]);
    expect(reasons).toEqual(["idle"]);
    // 表示用の履歴は消さない。次の発言からLLMには渡さない
    expect(session.history()).toHaveLength(1);
    await turn("b", "はじめまして。");
    expect(dialogue.calls[1]?.history).toEqual([]);
    // 消す履歴がなければ、時間がたっても区切らない
    clock.advance(IDLE_RESET_MS);
    expect(cleared(emitted)).toHaveLength(2);
    clock.advance(IDLE_RESET_MS);
    expect(cleared(emitted)).toHaveLength(2);
  });

  test("90秒の前に話せば区切らない。話し中・聞き取り中は数えない", async () => {
    const s = loopSetup({ robot: true, active: "robot" });
    s.sources.setActive("tablet");
    await s.turn("a", "やあ。");
    // 機体ありなので話し中。話している間は数えない
    expect(s.session.session).toBe("speaking");
    s.clock.advance(IDLE_RESET_MS);
    expect(cleared(s.emitted)).toHaveLength(0);
    s.tts.finish();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    s.session.handlePlaybackDone("t1", 0);
    expect(s.session.session).toBe("idle");
    s.clock.advance(IDLE_RESET_MS - 1000);
    // 機体のマイクで聞き取り中になれば止まり、待機中に戻ったら数え直す
    s.sources.setActive("robot");
    s.session.handleListening(true);
    s.clock.advance(5000);
    expect(cleared(s.emitted)).toHaveLength(0);
    s.session.handleListening(false);
    s.clock.advance(IDLE_RESET_MS - 1);
    expect(cleared(s.emitted)).toHaveLength(0);
    s.clock.advance(1);
    expect(cleared(s.emitted)).toHaveLength(1);
  });

  test("管理用APIのresetは、どの状態でも受け付け、考え中の発言も以後の履歴に入れない", async () => {
    const { session, dialogue, emitted, clears, reasons, turn } = loopSetup();
    await turn("a", "やあ。");
    const done = session.handleUtterance("tablet", "b");
    expect(session.session).toBe("thinking");
    session.resetHistory();
    expect(cleared(emitted).at(-1)).toMatchObject({ reason: "manual" });
    expect(clears.at(-1)).toMatchObject({ kind: "history_cleared", reason: "manual" });
    expect(reasons).toEqual(["manual"]);
    dialogue.answer("はい。");
    await done;
    await turn("c", "ええ。");
    expect(dialogue.calls[2]?.history).toEqual([]);
    // 区切ったあとに返事をした発言は、また渡す
    await turn("d", "うん。");
    expect(dialogue.calls[3]?.history.map((t) => t.text)).toEqual(["c"]);
  });
});
