// ConversationSession：会話の状態、受付可否、直近の履歴、話し中の進行（imple 3節・5節）。
// 外部のAPIは直接呼ばず、DialogueEngine・TtsEngine・WebSearcher・ContentFilterなどを受け取って使う。
// 1回の発言ごとに、会話ログの1行をrecordへ渡す（ファイルへの追記はConversationLog）。
//
// 機体のマイク：入力元がrobotで、マイクが一時停止でなく、LLM・VOICEVOX・STTが応答しているときだけ聞く。
// 機体が声を検出したら（listening: true）聞き取り中、区切れた1発話（voice）はSTTで文字にしてから、
// 文字の発言と同じ流れ（禁止語→LLM→話し中）に入る。STTの間も聞き取り中のまま（目で注目を示し続ける）。
// 受け付けない声（入力元・状態・マイクの一時停止）はSTTに渡さずに捨て、何も記録しない（imple 5節）。
//
// 調べ中：1回目の返事に検索語（search）があれば、前置きのsayを合成して機体へ送り、同時に検索する。
// 検索が終わり、前置きの再生が終わったら（機体がいないときは検索が終わったら）、結果の抜粋を付けて
// 2回目を問い合わせ、話し中へ進む。検索は1ターンに1回まで（2回目の返事にsearchはない）。
// 検索の失敗（無料枠の使い切り・エラー・時間切れ）は、結果なしで2回目を問い合わせる。
//
// 話し中：返事を文に分け、1文ずつ合成して機体へ送る。機体が再生している間に次の文を合成する。
// 最後の文のplayback_done、機体の切断、タイムアウト、合成の失敗で待機中に戻る。
// 機体がいない・VOICEVOXが落ちているときは、返事を得たらすぐ待機中に戻る。
// 前置きと返事は同じturnIdで送り、文の番号は前置きの続きから振る（最後の文の番号を区別するため）。
//
// 質問のループを防ぐ：LLMに渡す履歴の直近の返事が、続けてquestionLoopThreshold回以上質問で終わっていたら、
// 今回の問い合わせに指示を足す（antiLoop）。
// 履歴の区切り：待機中のまま、返事が終わってからidleResetMsの間だれも話さなければ、LLMに渡す履歴を消し、
// history_cleared（reason: "idle"）を配信して会話ログに残す。管理用APIのresetも同じ（reason: "manual"。
// どの状態でも受け付け、次の発言から効く）。表示用の履歴は消さない。

import {
  type BroadcastMessage,
  type Emotion,
  type Health,
  type HistoryClearedReason,
  ROBOT_SOURCE,
  type SessionState,
  type SpeechMessage,
  type StatusMessage,
  type Turn,
  type Via,
} from "@tekurobokun/protocol";
import type { ContentFilter } from "./content_filter.ts";
import type { LogLine } from "./conversation_log.ts";
import { shouldAntiLoop } from "./dialogue/anti_loop.ts";
import {
  type DialogueEngine,
  type FirstReplyResult,
  LlmTimeoutError,
  type ReplyOptions,
} from "./dialogue/engine.ts";
import { SearchError, type SearchResult, type WebSearcher } from "./search/engine.ts";
import type { SpeechRecognizer } from "./stt/engine.ts";
import { toJstIso } from "./time.ts";
import type { Speech, TtsEngine } from "./tts/engine.ts";

/** セッションが参照するHealthMonitorの部分。 */
export type HealthSource = {
  snapshot(): Health;
  markLlmDown(): void;
  markTtsDown(): void;
  markSttDown(): void;
};
/** セッションが参照するInputSourceRegistryの部分。 */
export type SourceState = {
  active(): string;
  isActive(source: string): boolean;
  micPaused(): boolean;
};

/** タイマー（テストで差し替える）。 */
export type Timers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** 聞き取り中のまま声（voice）が来なければ待機中に戻すまでの時間の既定（機体の1発話の最大15秒より長く） */
export const DEFAULT_LISTENING_TIMEOUT_MS = 20_000;

export type SessionOptions = {
  dialogue: DialogueEngine;
  tts: TtsEngine;
  /** 機体のマイクの1発話を文字にする */
  stt: SpeechRecognizer;
  /** 1回目の返事に検索語があれば検索する */
  searcher: WebSearcher;
  /** 禁止語の検査。なければ検査しない */
  filter?: ContentFilter;
  sources: SourceState;
  health: HealthSource;
  /** 入力ページと機体の両方に配信する */
  emit: (message: BroadcastMessage) => void;
  /** 機体にだけ送る（音声） */
  sendToRobot: (message: SpeechMessage) => void;
  /** 表示用に持つ履歴の件数 */
  displayTurns: number;
  /** 話し中のタイムアウトの余裕（送った音声の長さの合計に足す） */
  speakingGraceMs: number;
  /** 聞き取り中のまま声が来なければ待機中に戻すまでの時間 */
  listeningTimeoutMs?: number;
  now?: () => Date;
  timers?: Timers;
  newId?: () => string;
  /** 直近の返事が続けてこの回数以上質問で終わっていたら、質問のループを防ぐ指示を足す（0なら足さない） */
  questionLoopThreshold?: number;
  /** 待機中のまま、この時間だれも話さなければLLMに渡す履歴を消す（0なら消さない） */
  idleResetMs?: number;
  /** 会話ログに1行残す（ConversationLog）。なければ残さない */
  record?: (entry: LogLine) => void;
  /** LLMに渡す履歴を区切った（管理用APIの/admin/eventsにresetを出す） */
  onHistoryCleared?: (reason: HistoryClearedReason) => void;
  /** LLMが時間内に返事をしなかった（管理用APIの/admin/eventsにllm_timeoutを出す） */
  onLlmTimeout?: () => void;
  /** 受け付けなかった発言・LLMの失敗などをターミナルに出す */
  log?: (line: string) => void;
};

export type UtteranceResult =
  | "accepted"
  | "empty"
  | "busy"
  | "inactive_device"
  | "mic_paused"
  | "llm_unavailable"
  | "tts_unavailable"
  | "stt_unavailable";

/** 1回の発言の結果のうち、会話ログに残す部分。 */
type Outcome = Omit<
  Extract<LogLine, { kind: "turn" }>,
  "kind" | "at" | "source" | "via" | "input" | "stt"
>;

/** 返事を得たあとの進め方（会話ログに残さない部分）。 */
type Replied = {
  outcome: Outcome;
  /** 表示用の考えた時間（検索したときは2回目） */
  replyThinkingMs: number;
  /** 返事の最初の文の番号（前置きを送ったときは、その続き） */
  firstIndex: number;
};

/** LLMが落ちていた・失敗したとき。 */
const FAILED: Outcome = {
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

/** STTが失敗したとき。 */
const STT_FAILED: Outcome = { ...FAILED, error: "stt_unavailable" };

/** 機体での再生の進行（前置き・返事）。 */
type Playback = {
  turnId: string;
  /** 最後の文を送ったら、その番号 */
  lastIndex: number | null;
  /** 送った音声を機体が順に再生し終える見込みの時刻（ms） */
  estimatedEndMs: number;
  timer: unknown;
  /** 最後の文のplayback_done・切断・タイムアウト・合成の失敗で1回だけ呼ぶ */
  onDone: () => void;
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class ConversationSession {
  private state: SessionState = "idle";
  private turns: Turn[] = [];
  /** LLMに渡してよい発言のid（禁止語で差し替えた入力や、ログから戻した履歴は含めない） */
  private readonly llmTurnIds = new Set<string>();
  private playback: Playback | null = null;
  /** 機体の1発話を文字にしている間 */
  private recognizing = false;
  private listeningTimer: unknown = null;
  /** だれも話さない時間で履歴を区切るタイマー */
  private idleResetTimer: unknown = null;
  /** 履歴を区切るたびに進める（区切る前に始まった発言を、区切ったあとのLLMの履歴に入れないため） */
  private historyGeneration = 0;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: (line: string) => void;
  private readonly timers: Timers;

  constructor(private readonly options: SessionOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.log = options.log ?? (() => {});
    this.timers = options.timers ?? realTimers;
  }

  get session(): SessionState {
    return this.state;
  }

  /** 表示用の履歴（古い順）。 */
  history(): Turn[] {
    return this.turns.map((t) => structuredClone(t));
  }

  status(): StatusMessage {
    return {
      type: "status",
      session: this.state,
      inputSource: this.options.sources.active(),
      micPaused: this.options.sources.micPaused(),
      health: this.options.health.snapshot(),
    };
  }

  broadcastStatus(): void {
    this.options.emit(this.status());
  }

  /** 文字の発言を受け付けられるか。受け付けない場合は理由を返す。 */
  check(device: string, text: string): UtteranceResult {
    if (text.trim() === "") return "empty";
    if (this.state !== "idle") return "busy";
    if (!this.options.sources.isActive(device)) return "inactive_device";
    // LLM・VOICEVOXのどちらかが落ちている間は受け付けない（入力ページはS01f、機体はS02e）。
    // HealthMonitorの定期的な問い合わせで応答が戻れば、自動で受け付けに戻る。
    const health = this.options.health.snapshot();
    if (!health.llm) return "llm_unavailable";
    if (!health.tts) return "tts_unavailable";
    return "accepted";
  }

  /**
   * 機体のマイクの声を受け付けられない理由（受け付けられればnull）。状態は見ない。
   * 入力元がrobotで、マイクが一時停止でなく、STT・LLM・VOICEVOXが応答しているときだけ受け付ける。
   */
  private robotInputBlocked(): UtteranceResult | null {
    const { sources } = this.options;
    if (!sources.isActive(ROBOT_SOURCE)) return "inactive_device";
    if (sources.micPaused()) return "mic_paused";
    const health = this.options.health.snapshot();
    if (!health.stt) return "stt_unavailable";
    if (!health.llm) return "llm_unavailable";
    if (!health.tts) return "tts_unavailable";
    return null;
  }

  /**
   * 文字の発言を受け取る。受け付けない発言は捨て、何も記録しない（imple 5節）。
   * ただし、有効な端末から待機中に届いた発言をLLMが落ちているために受け付けなかったときは、
   * `error: "llm_unavailable"`として会話ログに1行残す（imple 7節）。
   * 受け付けた場合は、返事を得るまで待つ（話し中に入ったら、その終わりは待たない）。
   */
  async handleUtterance(device: string, text: string): Promise<UtteranceResult> {
    const result = this.check(device, text);
    if (result !== "accepted") {
      this.log(`dropped utterance from "${device}": ${result}`);
      if (result === "llm_unavailable") {
        this.recordTurn(toJstIso(this.now()), device, "text", text.trim(), null, FAILED);
      }
      return result;
    }
    await this.runTurn(toJstIso(this.now()), device, "text", text.trim(), null);
    return "accepted";
  }

  /**
   * 機体が声を検出した（true）・取り消した（false）。
   * 待機中で機体の声を受け付けられるときだけ聞き取り中にする。取り消しは、文字にしている間は無視する。
   */
  handleListening(active: boolean): void {
    if (active) {
      if (this.state !== "idle" || this.robotInputBlocked() !== null) return;
      this.cancelIdleReset();
      this.state = "listening";
      this.listeningTimer = this.timers.set(() => {
        this.listeningTimer = null;
        if (this.state !== "listening" || this.recognizing) return;
        this.log("no voice arrived while listening");
        this.toIdle();
      }, this.options.listeningTimeoutMs ?? DEFAULT_LISTENING_TIMEOUT_MS);
      this.broadcastStatus();
      return;
    }
    if (this.state === "listening" && !this.recognizing) this.toIdle();
  }

  /**
   * 機体のマイクの1発話（WAV）を受け取る。
   * 待機中・聞き取り中で、機体の声を受け付けられるときだけSTTに渡す。受け付けない声は捨て、何も記録しない。
   * STTの結果が空なら待機中に戻る（記録しない）。STTが失敗したら`health.stt`を落として待機中に戻り、
   * `error: "stt_unavailable"`として1行残す。文字にできたら、文字の発言と同じ流れに入る。
   */
  async handleVoice(wav: Uint8Array): Promise<UtteranceResult> {
    const busy = (this.state !== "idle" && this.state !== "listening") || this.recognizing;
    const blocked = busy ? "busy" : this.robotInputBlocked();
    if (blocked !== null) {
      this.log(`dropped voice: ${blocked}`);
      return blocked;
    }

    const at = toJstIso(this.now());
    this.recognizing = true;
    this.clearListeningTimer();
    if (this.state !== "listening") {
      this.cancelIdleReset();
      this.state = "listening";
      this.broadcastStatus();
    }
    let text: string;
    let sttMs: number;
    try {
      const recognition = await this.options.stt.recognize(wav);
      text = recognition.text.trim();
      sttMs = recognition.ms;
    } catch (e) {
      this.recognizing = false;
      this.log(`stt failed: ${errorText(e)}`);
      this.recordTurn(at, ROBOT_SOURCE, "mic", "", null, STT_FAILED);
      this.options.health.markSttDown();
      this.toIdle();
      return "stt_unavailable";
    }
    this.recognizing = false;
    if (text === "") {
      this.log("dropped voice: empty");
      this.toIdle();
      return "empty";
    }
    // 文字にしている間にLLM・VOICEVOXが落ちたら、文字の発言と同じく扱う。
    const health = this.options.health.snapshot();
    if (!health.llm || !health.tts) {
      const reason = health.llm ? "tts_unavailable" : "llm_unavailable";
      this.log(`dropped voice: ${reason}`);
      if (reason === "llm_unavailable") {
        this.recordTurn(at, ROBOT_SOURCE, "mic", text, { ms: sttMs }, FAILED);
      }
      this.toIdle();
      return reason;
    }
    await this.runTurn(at, ROBOT_SOURCE, "mic", text, { ms: sttMs });
    return "accepted";
  }

  /**
   * 入力元・マイクの一時停止・応答の有無が変わった。
   * 聞き取り中に機体の声を受け付けられなくなったら、待機中に戻す（文字にしている間は戻さない）。
   */
  inputConditionsChanged(): void {
    if (this.state === "listening" && !this.recognizing && this.robotInputBlocked() !== null) {
      this.toIdle();
    }
  }

  /** 発言を履歴に入れ、考え中→（調べ中）→返事→（話し中）へ進める。返事を得るまで待つ。 */
  private async runTurn(
    at: string,
    source: string,
    via: Via,
    text: string,
    stt: { ms: number } | null,
  ): Promise<void> {
    // LLMに渡す往復の候補。往復数はDialogueEngineが絞る。
    const context = this.llmContext();
    const antiLoop = shouldAntiLoop(
      context.flatMap((t) => (t.reply ? [t.reply.say] : [])),
      this.options.questionLoopThreshold ?? 0,
    );
    const generation = this.historyGeneration;
    const turn: Turn = { id: this.newId(), at, source, via, text };
    this.push(turn);
    this.clearListeningTimer();
    this.cancelIdleReset();
    this.state = "thinking";
    this.options.emit({ type: "turn_started", turn: structuredClone(turn) });
    this.broadcastStatus();

    const { outcome, replyThinkingMs, firstIndex } = await this.reply(context, turn, { antiLoop });
    // LLMが返事をした発言は、以後LLMに渡す。ただし、考えている間に履歴を区切ったら渡さない。
    if (outcome.raw !== null && generation === this.historyGeneration) {
      this.llmTurnIds.add(turn.id);
    }
    this.recordTurn(at, source, via, text, stt, outcome);
    if (outcome.say !== null && outcome.emotion !== null) {
      const { say, emotion } = outcome;
      turn.reply = { say, emotion, thinkingMs: replyThinkingMs };
      this.options.emit({
        type: "turn_replied",
        turnId: turn.id,
        say,
        emotion,
        thinkingMs: replyThinkingMs,
      });
      if (this.startSpeaking(turn.id, say, emotion, firstIndex)) return;
    }

    this.enterIdle();
  }

  private recordTurn(
    at: string,
    source: string,
    via: Via,
    input: string,
    stt: { ms: number } | null,
    outcome: Outcome,
  ): void {
    this.options.record?.({ kind: "turn", at, source, via, input, stt, ...outcome });
  }

  /** 聞き取り中から待機中に戻す（待機中なら何もしない）。 */
  private toIdle(): void {
    this.clearListeningTimer();
    if (this.state === "idle") return;
    this.enterIdle();
  }

  /** 待機中にして配信し、履歴を区切るタイマーをかけ直す。 */
  private enterIdle(): void {
    this.state = "idle";
    this.broadcastStatus();
    this.armIdleReset();
  }

  /** LLMに渡す履歴があれば、だれも話さない時間で区切るタイマーをかける。 */
  private armIdleReset(): void {
    this.cancelIdleReset();
    const ms = this.options.idleResetMs ?? 0;
    if (ms <= 0 || this.llmTurnIds.size === 0) return;
    this.idleResetTimer = this.timers.set(() => {
      this.idleResetTimer = null;
      if (this.state !== "idle" || this.llmTurnIds.size === 0) return;
      this.clearHistory("idle");
    }, ms);
  }

  private cancelIdleReset(): void {
    if (this.idleResetTimer !== null) this.timers.clear(this.idleResetTimer);
    this.idleResetTimer = null;
  }

  /**
   * LLMに渡す履歴を消す（管理用APIのreset）。どの状態でも受け付け、次の発言から効く
   * （考え中・調べ中の発言も、以後のLLMの履歴には入れない）。
   */
  resetHistory(): void {
    this.cancelIdleReset();
    this.clearHistory("manual");
  }

  private clearHistory(reason: HistoryClearedReason): void {
    this.llmTurnIds.clear();
    this.historyGeneration++;
    const at = toJstIso(this.now());
    this.log(`history cleared (${reason})`);
    this.options.emit({ type: "history_cleared", at, reason });
    this.options.record?.({ kind: "history_cleared", at, reason });
    this.options.onHistoryCleared?.(reason);
  }

  private clearListeningTimer(): void {
    if (this.listeningTimer !== null) this.timers.clear(this.listeningTimer);
    this.listeningTimer = null;
  }

  /** 会話ログから戻した表示用の履歴を置く（起動時）。LLMに渡す往復には入れない（imple 7節）。 */
  restoreHistory(turns: Turn[]): void {
    this.turns = [];
    this.llmTurnIds.clear();
    for (const turn of turns) this.push(structuredClone(turn));
  }

  /**
   * 返事を得る。入力が禁止語に当たったらLLMに渡さずに定型の返事を、
   * LLMの返事が当たったら定型の返事に差し替えたものを返す（前置きが当たったら検索もしない）。
   * 1回目に検索語があれば、調べ中に進む。LLMが失敗したら、返事はnull。
   */
  private async reply(context: Turn[], turn: Turn, opts: ReplyOptions): Promise<Replied> {
    const filter = this.options.filter;
    const input = filter?.check(turn.text);
    if (input?.hit && input.replacement) {
      this.log(`filtered input from "${turn.source}"`);
      // 禁止語を含む発言は、以後もLLMに渡さない。
      const { say, emotion } = input.replacement;
      const outcome: Outcome = {
        ...FAILED,
        say,
        emotion,
        filtered: "input",
        error: null,
      };
      return { outcome, replyThinkingMs: 0, firstIndex: 0 };
    }

    const model = this.options.dialogue.activeModel();
    let first: FirstReplyResult;
    try {
      first = await this.options.dialogue.reply(context, turn.text, opts);
    } catch (e) {
      return this.llmFailed(e, { ...FAILED, model, antiLoop: opts.antiLoop });
    }
    const base: Outcome = {
      ...FAILED,
      thinkingMs: first.thinkingMs,
      raw: first.raw,
      model: first.model,
      antiLoop: opts.antiLoop,
      error: null,
    };
    const output = filter?.check(first.say);
    if (output?.hit && output.replacement) {
      this.log("filtered output");
      const outcome: Outcome = { ...base, ...output.replacement, filtered: "output" };
      return { outcome, replyThinkingMs: first.thinkingMs, firstIndex: 0 };
    }
    if (first.search === null) {
      const outcome: Outcome = { ...base, say: first.say, emotion: first.emotion };
      return { outcome, replyThinkingMs: first.thinkingMs, firstIndex: 0 };
    }
    return this.searchAndReply(context, turn, first, first.search, opts);
  }

  /** LLMの失敗。時間切れなら知らせ、応答なしにする。 */
  private llmFailed(e: unknown, outcome: Outcome): Replied {
    this.log(`llm failed: ${errorText(e)}`);
    if (e instanceof LlmTimeoutError) this.options.onLlmTimeout?.();
    this.options.health.markLlmDown();
    return { outcome, replyThinkingMs: 0, firstIndex: 0 };
  }

  /**
   * 調べ中：前置きの再生と検索を並行して進め、両方を待ってから結果つきで2回目を問い合わせる。
   * 検索の失敗は、結果なし（null）で問い合わせる。
   */
  private async searchAndReply(
    context: Turn[],
    turn: Turn,
    first: FirstReplyResult,
    query: string,
    opts: ReplyOptions,
  ): Promise<Replied> {
    const preSay = first.say;
    turn.search = { query, preSay, searchMs: null, ok: null };
    this.state = "searching";
    this.options.emit({
      type: "turn_search_started",
      turnId: turn.id,
      query,
      preSay,
      emotion: first.emotion,
      thinkingMs: first.thinkingMs,
    });
    this.broadcastStatus();

    const preSayDone = this.playPreSay(turn.id, preSay, first.emotion);
    const found = await this.runSearch(query);
    turn.search.searchMs = found.ms;
    turn.search.ok = found.ok;
    this.options.emit({
      type: "turn_search_done",
      turnId: turn.id,
      searchMs: found.ms,
      ok: found.ok,
    });
    const firstIndex = await preSayDone;

    const search = {
      query,
      ms: found.ms,
      urls: (found.results ?? []).map((r) => r.url),
      ok: found.ok,
    };
    const base: Outcome = {
      ...FAILED,
      rawFirst: first.raw,
      search,
      model: first.model,
      antiLoop: opts.antiLoop,
    };
    const model = this.options.dialogue.activeModel();
    let second: Awaited<ReturnType<DialogueEngine["replyWithResults"]>>;
    try {
      second = await this.options.dialogue.replyWithResults(
        context,
        turn.text,
        query,
        found.results,
        opts,
      );
    } catch (e) {
      // 2回目に失敗した。前置きは話したが、返事はない。
      return { ...this.llmFailed(e, { ...base, model }), firstIndex };
    }
    const outcome: Outcome = {
      ...base,
      thinkingMs: first.thinkingMs + second.thinkingMs,
      raw: second.raw,
      model: second.model,
      say: second.say,
      emotion: second.emotion,
      error: null,
    };
    const output = this.options.filter?.check(second.say);
    if (output?.hit && output.replacement) {
      this.log("filtered output");
      Object.assign(outcome, output.replacement, { filtered: "output" });
    }
    return { outcome, replyThinkingMs: second.thinkingMs, firstIndex };
  }

  /** 検索する。失敗は結果をnullにして返す。 */
  private async runSearch(
    query: string,
  ): Promise<{ results: SearchResult[] | null; ms: number; ok: boolean }> {
    const started = performance.now();
    try {
      const { results, ms } = await this.options.searcher.search(query);
      return { results, ms, ok: true };
    } catch (e) {
      const reason = e instanceof SearchError ? e.reason : "unknown";
      this.log(`search failed (${reason}): ${errorText(e)}`);
      const ms = e instanceof SearchError ? e.ms : Math.round(performance.now() - started);
      return { results: null, ms, ok: false };
    }
  }

  /**
   * 前置きを機体で再生し、終わったら（機体がいない・VOICEVOXが落ちているときはすぐ）、
   * 返事の最初の文の番号（前置きの文の数）で解決する。
   */
  private playPreSay(turnId: string, preSay: string, emotion: Emotion): Promise<number> {
    const health = this.options.health.snapshot();
    const sentences = health.robot && health.tts ? this.options.tts.split(preSay) : [];
    if (sentences.length === 0) return Promise.resolve(0);
    return new Promise((resolve) => {
      this.startPlayback(turnId, sentences, emotion, 0, () => resolve(sentences.length));
    });
  }

  /** LLMに渡してよい往復（このセッションでLLMが返事をした発言だけ。古い順）。 */
  private llmContext(): Turn[] {
    return this.turns.filter((t) => this.llmTurnIds.has(t.id)).map((t) => structuredClone(t));
  }

  /** 機体から1文の再生終了が届いた。最後の文なら、その再生を終える。 */
  handlePlaybackDone(turnId: string, index: number): void {
    const pb = this.playback;
    if (!pb || pb.turnId !== turnId || pb.lastIndex !== index) return;
    this.finishPlayback();
  }

  /**
   * 機体がすべて切断した。聞き取り中なら待機中に、再生中（前置き・返事）なら、その再生をすぐ終える
   * （文字にしている間は、その結果を待つ）。
   */
  robotDisconnected(): void {
    if (this.state === "listening" && !this.recognizing) {
      this.toIdle();
      return;
    }
    if (!this.playback) return;
    this.log(`robot disconnected while ${this.state}`);
    this.finishPlayback();
  }

  /** 機体がいてVOICEVOXが応答していれば、話し中に入る。入らなければfalse。 */
  private startSpeaking(
    turnId: string,
    say: string,
    emotion: Emotion,
    firstIndex: number,
  ): boolean {
    const health = this.options.health.snapshot();
    if (!health.robot || !health.tts) return false;
    const sentences = this.options.tts.split(say);
    if (sentences.length === 0) return false;

    this.state = "speaking";
    this.broadcastStatus();
    this.startPlayback(turnId, sentences, emotion, firstIndex, () => this.enterIdle());
    return true;
  }

  private startPlayback(
    turnId: string,
    sentences: string[],
    emotion: Emotion,
    firstIndex: number,
    onDone: () => void,
  ): void {
    const pb: Playback = { turnId, lastIndex: null, estimatedEndMs: 0, timer: null, onDone };
    this.playback = pb;
    void this.speak(pb, sentences, emotion, firstIndex);
  }

  /** 1文ずつ合成して送る。送ったらすぐ次の文を合成する（機体は届いた順に再生する）。 */
  private async speak(
    pb: Playback,
    sentences: string[],
    emotion: Emotion,
    firstIndex: number,
  ): Promise<void> {
    for (const [i, text] of sentences.entries()) {
      let speech: Speech;
      try {
        speech = await this.options.tts.synthesize(text);
      } catch (e) {
        if (this.playback !== pb) return;
        this.log(`tts failed: ${errorText(e)}`);
        this.options.health.markTtsDown();
        this.finishPlayback();
        return;
      }
      // 合成の間に再生が終わっていたら（切断・タイムアウト）、続きは送らない。
      if (this.playback !== pb) return;

      const index = firstIndex + i;
      const last = i === sentences.length - 1;
      this.options.sendToRobot({
        type: "speech",
        turnId: pb.turnId,
        index,
        last,
        text,
        emotion,
        wav: Buffer.from(speech.wav).toString("base64"),
      });
      const now = this.now().getTime();
      pb.estimatedEndMs = Math.max(pb.estimatedEndMs, now) + speech.durationMs;
      if (last) {
        pb.lastIndex = index;
        pb.timer = this.timers.set(
          () => {
            if (this.playback !== pb) return;
            this.log("playback_done did not arrive in time");
            this.finishPlayback();
          },
          pb.estimatedEndMs - now + this.options.speakingGraceMs,
        );
      }
    }
  }

  private finishPlayback(): void {
    const pb = this.playback;
    if (!pb) return;
    if (pb.timer != null) this.timers.clear(pb.timer);
    this.playback = null;
    pb.onDone();
  }

  private push(turn: Turn): void {
    this.turns.push(turn);
    if (this.turns.length > this.options.displayTurns) {
      const removed = this.turns.splice(0, this.turns.length - this.options.displayTurns);
      for (const t of removed) this.llmTurnIds.delete(t.id);
    }
  }
}
