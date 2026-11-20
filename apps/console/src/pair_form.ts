// PairForm：未登録の端末の登録コードの入力（S01i）。
// 上に見出しと説明（# 付きの行）、下に「登録コード %」の入力行と［登録］。
// コードの形（XXXX-XXXX、読み違えやすい文字を除く）になったら［登録］を押せる。
// 失敗したら入力を消して入れ直してもらう（モックに失敗の文言がないため、文言は出さない）。

import { m } from "@tekurobokun/i18n";
import { normalizePairingCode } from "@tekurobokun/protocol";
import { h } from "./dom.ts";

export type PairFormHandlers = {
  /** 正規の形にそろえたコードを送る。送れなければfalse */
  onSubmit: (code: string) => boolean;
};

export class PairForm {
  /** 見出しと説明（ログの場所に出す） */
  readonly message: HTMLElement;
  /** 入力行（入力行の場所に出す） */
  readonly row: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly button: HTMLButtonElement;
  private shown = false;
  /** 送ってから結果が届くまで */
  private pending = false;

  constructor(private readonly handlers: PairFormHandlers) {
    this.message = h(
      "div",
      { class: "pair-form" },
      h("div", { class: "sh pair-title", text: m["pair.console_title"]() }),
      h("div", { class: "sh sh-comment pair-body", text: m["pair.console_body"]() }),
    );
    const label = m["pair.code_label"]();
    this.input = h("input", {
      class: "field-input",
      attrs: {
        type: "text",
        placeholder: m["pair.code_placeholder"](),
        "aria-label": label,
        autocomplete: "off",
        autocapitalize: "characters",
        spellcheck: "false",
        enterkeyhint: "go",
        maxlength: "16",
      },
    });
    this.button = h("button", {
      class: "ctl",
      text: m["pair.register_button"](),
      attrs: { type: "button" },
    });
    this.row = h(
      "div",
      { class: "t-input" },
      h(
        "div",
        { class: "field-row" },
        h(
          "label",
          { class: "field sh" },
          h("span", { class: "field-head pair-head", text: label }),
          this.input,
        ),
        h("div", { class: "btns" }, this.button),
      ),
    );

    this.input.addEventListener("input", () => this.update());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        this.submit();
      }
    });
    this.button.addEventListener("click", () => {
      this.submit();
      this.input.focus();
    });
    this.message.hidden = true;
    this.row.hidden = true;
    this.update();
  }

  /** 出す・隠す。出したら入力欄にフォーカスする。 */
  set(shown: boolean): void {
    if (shown === this.shown) return;
    this.shown = shown;
    this.message.hidden = !shown;
    this.row.hidden = !shown;
    if (shown) {
      this.input.focus({ preventScroll: true });
    } else {
      this.input.value = "";
      this.pending = false;
      this.input.blur();
    }
    this.update();
  }

  /** 登録に失敗した（pair_failed）。入力を消して、入れ直してもらう。 */
  failed(): void {
    this.pending = false;
    this.input.value = "";
    this.update();
    if (this.shown) this.input.focus({ preventScroll: true });
  }

  private update(): void {
    this.button.disabled = this.pending || normalizePairingCode(this.input.value) === null;
  }

  private submit(): void {
    const code = normalizePairingCode(this.input.value);
    if (!this.shown || this.pending || code === null) return;
    if (!this.handlers.onSubmit(code)) return;
    this.pending = true;
    this.update();
  }
}
