// StatusLine：反転した状態行（S01a〜S01f、S01h）。左にアプリ名、右に[状態]。
// ログ表示専用（S01h）では、待機中・聞き取り中を「聞いています」、マイクの一時停止中を「マイク停止中」と出す。
// 調べ中は、入力ページでもS01hでも「調べ中」（考え中と同じ印）。

import { m } from "@tekurobokun/i18n";
import { h } from "./dom.ts";

export type StatusKind =
  | "ready"
  | "listening"
  | "listening_voice"
  | "mic_paused"
  | "thinking"
  | "searching"
  | "speaking"
  | "offline";

const LABEL: Record<StatusKind, () => string> = {
  ready: () => m["status.ready"](),
  listening: () => m["status.listening"](),
  listening_voice: () => m["status.listening_voice"](),
  mic_paused: () => m["status.mic_paused"](),
  thinking: () => m["status.thinking"](),
  searching: () => m["status.searching"](),
  speaking: () => m["status.speaking"](),
  offline: () => m["status.offline"](),
};

const CLASS: Record<StatusKind, string> = {
  ready: "",
  listening: "is-busy",
  listening_voice: "",
  mic_paused: "",
  thinking: "is-thinking",
  searching: "is-thinking",
  speaking: "is-busy",
  offline: "is-offline",
};

export class StatusLine {
  readonly el: HTMLElement;
  private readonly status: HTMLElement;
  private kind: StatusKind | null = null;

  constructor() {
    this.status = h("span", { class: "status", attrs: { role: "status" } });
    this.el = h(
      "header",
      { class: "t-bar" },
      h("span", { class: "t-name", text: m["app.name"]() }),
      this.status,
    );
  }

  set(kind: StatusKind): void {
    if (kind === this.kind) return;
    this.kind = kind;
    this.status.className = `status ${CLASS[kind]}`.trim();
    this.status.textContent = LABEL[kind]();
  }
}
