// OperatorConsole：バックエンドを起動したターミナルでのキー操作（imple 3節）。
// 数字キー`1`〜`9`（端末一覧の順）で入力を受け付ける端末を切り替え、現在の状態を1行で表示する。
// 端末の切り替えはここからだけ行う（入力ページ・機体には切り替えの操作を置かない）。
// スタブ（--stub）のときは、`l`・`t`でLLM・VOICEVOXの停止と復旧を再現できる（W4-2）。
//
// キーの解釈（handleKey）と状態の1行（statusLine）は端末の入出力と分け、テストできるようにする。

import type { StatusMessage } from "@tekurobokun/protocol";
import type { StubAvailability, StubTarget } from "./stub_availability.ts";

/** OperatorConsoleが参照するInputDeviceRegistryの部分。 */
export type OperatorDevices = {
  list(): readonly string[];
  active(): string;
  setActiveByNumber(n: number): boolean;
};

export type OperatorConsoleOptions = {
  devices: OperatorDevices;
  /** 現在の会話の状態と接続・応答の有無 */
  status: () => StatusMessage;
  /** スタブのときだけ渡す。止める・戻すの切り替えのあと、recheckでヘルスを問い合わせ直す */
  stub?: { availability: StubAvailability; recheck: () => Promise<void> };
  /** ターミナルへ1行出す */
  write: (line: string) => void;
  /** Ctrl+Cで呼ぶ（バックエンドを終える） */
  quit: () => void;
};

const CTRL_C = "\u0003";
const STUB_KEYS: Record<string, StubTarget> = { l: "llm", t: "tts" };

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

  /** 現在の状態の1行。例：`[operator] active=tablet [1:tablet* 2:phone] session=idle llm=up tts=up robot=connected` */
  statusLine(): string {
    const { devices } = this.options;
    const { session, health } = this.options.status();
    const active = devices.active();
    const list = devices
      .list()
      .map((d, i) => `${i + 1}:${d}${d === active ? "*" : ""}`)
      .join(" ");
    const up = (v: boolean) => (v ? "up" : "DOWN");
    return [
      `[operator] active=${active || "(none)"}`,
      `[${list}]`,
      `session=${session}`,
      `llm=${up(health.llm)}`,
      `tts=${up(health.tts)}`,
      `robot=${health.robot ? "connected" : "disconnected"}`,
    ].join(" ");
  }

  /** キー操作の説明。起動時と`h`・`?`で出す。 */
  helpLines(): string[] {
    const n = Math.min(this.options.devices.list().length, 9);
    const lines = [
      `[operator] keys: 1-${n} switch input device, s show status, h help, Ctrl+C quit`,
    ];
    if (this.options.stub) lines.push("[operator] stub keys: l stop/start llm, t stop/start tts");
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
      const before = this.options.devices.active();
      if (!this.options.devices.setActiveByNumber(n)) {
        this.options.write(`[operator] no device for key ${key}`);
        return;
      }
      // 切り替わればInputDeviceRegistryの通知で状態が表示される。同じ端末なら、ここで表示する。
      if (this.options.devices.active() === before) this.showStatus();
      return;
    }
    const lower = key.toLowerCase();
    if (lower === "s" || key === "\r" || key === "\n") {
      this.showStatus();
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
