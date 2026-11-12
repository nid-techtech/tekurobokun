// StatusLine：反転した状態行（S01a〜S01f）。左にアプリ名、右に[状態]。

import { m } from "@tekurobokun/i18n";
import { h } from "./dom.ts";

export type StatusKind = "ready" | "listening" | "thinking" | "speaking" | "offline";

const LABEL: Record<StatusKind, () => string> = {
  ready: () => m["status.ready"](),
  listening: () => m["status.listening"](),
  thinking: () => m["status.thinking"](),
  speaking: () => m["status.speaking"](),
  offline: () => m["status.offline"](),
};

const CLASS: Record<StatusKind, string> = {
  ready: "",
  listening: "is-busy",
  thinking: "is-thinking",
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
