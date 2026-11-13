// FullNotice：全面の案内（S01f：つながらない、S01g：別の端末が有効）。
// 出している間は、ログと入力行の代わりに、状態行の下いっぱいに見出しと説明を出す。

import { m } from "@tekurobokun/i18n";
import { h } from "./dom.ts";
import type { NoticeKind } from "./notice.ts";

const TEXT: Record<NoticeKind, { title: () => string; body: () => string }> = {
  offline: { title: () => m["error.offline_title"](), body: () => m["error.offline_body"]() },
  inactive: { title: () => m["input.inactive_title"](), body: () => m["input.inactive_body"]() },
};

export class FullNotice {
  readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private kind: NoticeKind | null | undefined;

  constructor() {
    this.title = h("h3");
    this.body = h("p");
    this.el = h("div", { class: "offline", attrs: { role: "alert" } }, this.title, this.body);
    this.set(null);
  }

  get shown(): boolean {
    return this.kind != null;
  }

  /** 案内の種類。nullなら隠す。 */
  set(kind: NoticeKind | null): void {
    if (kind === this.kind) return;
    this.kind = kind;
    this.el.hidden = kind === null;
    if (kind === null) return;
    this.el.className = kind === "inactive" ? "offline inactive" : "offline";
    this.title.textContent = TEXT[kind].title();
    this.body.textContent = TEXT[kind].body();
  }
}
