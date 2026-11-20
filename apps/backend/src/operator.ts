// OperatorConsole：バックエンドを起動したターミナルでのキー操作（開発用。imple 3節）。
// 数字キー`1`〜`9`（入力元の一覧の順。`1`が`robot`）で入力元を切り替え、`m`でマイクを一時停止・再開し、
// 現在の状態を1行で表示する。本番の切り替えはランチャー（管理用API）から行う。
// console・機体には切り替えの操作を置かない。
// スタブ（--stub）のときは、`l`・`t`・`r`でLLM・VOICEVOX・STTの停止と復旧を再現できる（W4-2）。
// `p`で登録コードを発行して表示する（開発用。本番はランチャーで出す）。
//
// キーの解釈（handleKey）と状態の1行（statusLine）は端末の入出力と分け、テストできるようにする。

import type { StatusMessage } from "@tekurobokun/protocol";
import type { StubAvailability, StubTarget } from "./stub_availability.ts";

/** OperatorConsoleが参照するInputSourceRegistryの部分。 */
export type OperatorSources = {
  list(): readonly string[];
  active(): string;
  setActiveByNumber(n: number): boolean;
  micPaused(): boolean;
  setMicPaused(paused: boolean): void;
};

export type OperatorConsoleOptions = {
  sources: OperatorSources;
  /** 現在の会話の状態と接続・応答の有無 */
  status: () => StatusMessage;
  /** スタブのときだけ渡す。止める・戻すの切り替えのあと、recheckでヘルスを問い合わせ直す */
  stub?: { availability: StubAvailability; recheck: () => Promise<void> };
  /** 登録コードを発行する（`p`）。なければ`p`は使えない */
  issuePairingCode?: () => { code: string; expiresAt: Date; qr: string };
  /** ターミナルへ1行出す */
  write: (line: string) => void;
  now?: () => Date;
  /** Ctrl+Cで呼ぶ（バックエンドを終える） */
  quit: () => void;
};

const CTRL_C = "\u0003";
const STUB_KEYS: Record<string, StubTarget> = { l: "llm", t: "tts", r: "stt" };

/** 端末で読み込むstdinの部分。 */
export type KeyInput = {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding(encoding: "utf8"): unknown;
  resume(): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
};

export class OperatorConsole {
  constructor(private readonly options: OperatorConsoleOptions) {}

  /**
   * 現在の状態の1行。例：
   * `[operator] input=robot [1:robot* 2:tablet 3:phone] mic=on session=idle llm=up tts=up stt=up robot=connected`
   */
  statusLine(): string {
    const { sources } = this.options;
    const { session, health } = this.options.status();
    const active = sources.active();
    const list = sources
      .list()
      .map((d, i) => `${i + 1}:${d}${d === active ? "*" : ""}`)
      .join(" ");
    const up = (v: boolean) => (v ? "up" : "DOWN");
    return [
      `[operator] input=${active}`,
      `[${list}]`,
      `mic=${sources.micPaused() ? "paused" : "on"}`,
      `session=${session}`,
      `llm=${up(health.llm)}`,
      `tts=${up(health.tts)}`,
      `stt=${up(health.stt)}`,
      `robot=${health.robot ? "connected" : "disconnected"}`,
    ].join(" ");
  }

  /** キー操作の説明。起動時と`h`・`?`で出す。 */
  helpLines(): string[] {
    const n = Math.min(this.options.sources.list().length, 9);
    const pair = this.options.issuePairingCode ? ", p pairing code" : "";
    const lines = [
      `[operator] keys: 1-${n} switch input source, m pause/resume mic${pair}, s show status, h help, Ctrl+C quit`,
    ];
    if (this.options.stub) {
      lines.push("[operator] stub keys: l stop/start llm, t stop/start tts, r stop/start stt");
    }
    return lines;
  }

  showStatus(): void {
    this.options.write(this.statusLine());
  }

  /** 1文字のキー入力を処理する。 */
  handleKey(key: string): void {
    if (key === CTRL_C) {
      this.options.quit();
      return;
    }
    if (/^[1-9]$/.test(key)) {
      const n = Number(key);
      const before = this.options.sources.active();
      if (!this.options.sources.setActiveByNumber(n)) {
        this.options.write(`[operator] no input source for key ${key}`);
        return;
      }
      // 切り替わればInputSourceRegistryの通知で状態が表示される。同じ入力元なら、ここで表示する。
      if (this.options.sources.active() === before) this.showStatus();
      return;
    }
    const lower = key.toLowerCase();
    if (lower === "m") {
      // 変わればInputSourceRegistryの通知で状態が表示される。
      const { sources } = this.options;
      sources.setMicPaused(!sources.micPaused());
      return;
    }
    if (lower === "s" || key === "\r" || key === "\n") {
      this.showStatus();
      return;
    }
    if (lower === "p" && this.options.issuePairingCode) {
      const { code, expiresAt, qr } = this.options.issuePairingCode();
      const now = (this.options.now ?? (() => new Date()))();
      const sec = Math.max(0, Math.round((expiresAt.getTime() - now.getTime()) / 1000));
      this.options.write(`[operator] pairing code ${code} (expires in ${sec}s) qr=${qr}`);
      return;
    }
    if (lower === "h" || key === "?") {
      for (const line of this.helpLines()) this.options.write(line);
      return;
    }
    const target = STUB_KEYS[lower];
    if (target && this.options.stub) {
      const { availability, recheck } = this.options.stub;
      const up = availability.toggle(target);
      this.options.write(`[operator] stub ${target} ${up ? "started" : "stopped"}`);
      // 問い合わせ直して、すぐ入力ページと機体に伝える（変われば通知で状態が表示される）。
      void recheck();
    }
  }

  /** 入力を受け取り始める。キー入力を受けられない（TTYでない）ときはfalseを返す。 */
  attach(input: KeyInput): boolean {
    if (!input.isTTY || typeof input.setRawMode !== "function") return false;
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      for (const key of chunk) this.handleKey(key);
    });
    input.resume();
    return true;
  }
}
