// PromptInput：ログの最後のプロンプト行としての入力欄（S01a・S01b・S01e）。
// [消す]・[送る]と、自動送信の文字の進捗バーを持つ。考え中・話し中は出さない（S01c）。
//
// 画面のキーボード（SwiftKey）を閉じないよう、出さない間も入力欄のフォーカスは外さず、
// 見た目だけ隠す。その間に入った文字は捨てる。

import { m } from "@tekurobokun/i18n";
import { Autosend, type AutosendTick } from "./autosend.ts";
import { h } from "./dom.ts";
import { textBar } from "./format.ts";
import { promptHead } from "./log_view.ts";

export type PromptInputHandlers = {
  onSend: (text: string) => void;
  /** 入力欄の文字の有無が変わったとき（状態行の「入力中」に使う） */
  onTextChange: (hasText: boolean) => void;
};

export class PromptInput {
  readonly el: HTMLElement;
  private readonly head: HTMLElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly clearButton: HTMLButtonElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly autosendRow: HTMLElement;
  private readonly autosendText: HTMLElement;
  private readonly autosendBar: HTMLElement;
  private readonly autosend: Autosend;
  private enabled = false;
  private hadText = false;

  constructor(
    private prompt: string,
    autosendMs: number,
    private readonly handlers: PromptInputHandlers,
  ) {
    const placeholder = m["input.placeholder"]();
    this.textarea = h("textarea", {
      class: "field-input",
      attrs: { rows: "1", placeholder, "aria-label": placeholder, enterkeyhint: "send" },
    });
    this.head = h("span", { class: "field-head" });
    this.clearButton = h("button", {
      class: "ctl sub",
      text: m["input.clear_button"](),
      attrs: { type: "button" },
    });
    this.sendButton = h("button", {
      class: "ctl",
      text: m["input.send_button"](),
      attrs: { type: "button" },
    });
    this.autosendText = h("span");
    this.autosendBar = h("span", { class: "bar-text" });
    this.autosendRow = h(
      "div",
      { class: "autosend", attrs: { "aria-live": "off" } },
      h("span", {}, this.autosendText, document.createTextNode(" "), this.autosendBar),
    );
    this.autosendRow.hidden = true;

    this.el = h(
      "div",
      { class: "t-input" },
      h(
        "div",
        { class: "field-row" },
        h("label", { class: "field sh" }, this.head, this.textarea),
        h("div", { class: "btns" }, this.clearButton, this.sendButton),
      ),
      this.autosendRow,
    );

    this.autosend = new Autosend(
      autosendMs,
      (tick) => this.showAutosend(tick),
      () => this.send(),
    );

    this.textarea.addEventListener("input", () => this.onInput());
    this.textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.send();
      }
    });
    this.clearButton.addEventListener("click", () => {
      this.setText("");
      this.textarea.focus();
    });
    this.sendButton.addEventListener("click", () => {
      this.send();
      this.textarea.focus();
    });
    this.setEnabled(false);
  }

  get hasText(): boolean {
    return this.textarea.value.trim() !== "";
  }

  configure(prompt: string, autosendMs: number): void {
    this.prompt = prompt;
    this.autosend.setDelay(autosendMs);
    this.renderHead();
  }

  /** 入力を受け付けるか（待機中で、つながっているとき）。 */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled && this.head.childElementCount > 0) return;
    this.enabled = enabled;
    this.el.classList.toggle("is-hidden", !enabled);
    this.el.setAttribute("aria-hidden", String(!enabled));
    if (enabled) {
      // プロンプトの時刻は、プロンプトを出した時刻にする。
      this.renderHead();
      this.textarea.focus({ preventScroll: true });
    } else {
      this.setText("");
    }
    this.updateButtons();
  }

  focus(): void {
    this.textarea.focus({ preventScroll: true });
  }

  /** フォーカスを外し、画面のキーボードを閉じる（全面の案内を出すとき）。 */
  blur(): void {
    this.textarea.blur();
  }

  private renderHead(): void {
    this.head.replaceChildren(...promptHead(new Date(), this.prompt));
  }

  private onInput(): void {
    if (!this.enabled) {
      this.textarea.value = "";
      return;
    }
    if (this.hasText) this.autosend.restart();
    else this.autosend.cancel();
    this.afterTextChange();
  }

  private setText(text: string): void {
    this.textarea.value = text;
    this.autosend.cancel();
    this.afterTextChange();
  }

  private afterTextChange(): void {
    this.updateButtons();
    const hasText = this.hasText;
    if (hasText !== this.hadText) {
      this.hadText = hasText;
      this.handlers.onTextChange(hasText);
    }
  }

  private updateButtons(): void {
    const disabled = !this.enabled || !this.hasText;
    this.clearButton.disabled = disabled;
    this.sendButton.disabled = disabled;
  }

  private send(): void {
    const text = this.textarea.value.trim();
    if (!this.enabled || text === "") return;
    this.setText("");
    this.handlers.onSend(text);
  }

  private showAutosend(tick: AutosendTick | null): void {
    this.autosendRow.hidden = tick === null;
    if (!tick) return;
    const seconds = Math.max(1, Math.ceil(tick.remainingMs / 1000));
    this.autosendText.textContent = m["input.autosend"]({ seconds });
    this.autosendBar.textContent = textBar(tick.fraction);
  }
}
