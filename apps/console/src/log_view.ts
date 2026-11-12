// LogView：シェル風のログ（S01a〜S01e）。
// 来場者の発言は時刻つきのプロンプト行、返事は「finished thinking in」の行と「>」の行。
// 考え中は末尾に「is thinking」と点字のスピナー。話し中は最後の返事の行の末尾でカーソルが点滅する。
// ログは消さず、下に追加して末尾へスクロールする。

import { m } from "@tekurobokun/i18n";
import type { Reply, Turn } from "@tekurobokun/protocol";
import { h, reducedMotion, withBoldName } from "./dom.ts";
import { formatClock, formatDuration } from "./format.ts";

/** 点字の8点が1つずつ欠けて回るスピナー。 */
const BRAILLE = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
const SPINNER_STEP_MS = 100;

/** プロンプト行の先頭（時刻とプロンプト）。入力行でも使う。 */
export function promptHead(at: string | Date, prompt: string): Node[] {
  return [
    h("span", { class: "ts", text: formatClock(at) }),
    document.createTextNode(" "),
    h("span", { class: "prompt", text: prompt }),
    document.createTextNode(" "),
  ];
}

export class LogView {
  readonly el: HTMLElement;
  private readonly groups = new Map<string, HTMLElement>();
  private empty: HTMLElement | null = null;
  private thinking: HTMLElement | null = null;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  /** 最後に足した返事の行（話し中のカーソルを置く） */
  private lastOutput: HTMLElement | null = null;
  private readonly cursor = h("span", { class: "cursor", attrs: { "aria-hidden": "true" } });

  /** promptは、プロンプト行に出す「user@host:dir %」を返す。 */
  constructor(private readonly prompt: () => string) {
    this.el = h("main", { class: "t-log", attrs: { role: "log", "aria-live": "polite" } });
    // 入力行の出し入れや画面のキーボードの開閉でログの高さが変わっても、末尾を見せ続ける。
    new ResizeObserver(() => this.scrollToEnd()).observe(this.el);
    this.reset([]);
  }

  /** 履歴で描き直す（接続のたびのwelcome）。 */
  reset(turns: Turn[]): void {
    this.setThinking(false);
    this.cursor.remove();
    this.lastOutput = null;
    this.groups.clear();
    this.el.replaceChildren();
    this.empty = null;
    for (const turn of turns) this.addTurn(turn);
    if (turns.length === 0) {
      this.empty = h("div", { class: "sh sh-comment", text: `# ${m["log.empty"]()}` });
      this.el.append(this.empty);
    }
    this.scrollToEnd();
  }

  addTurn(turn: Turn): void {
    if (this.groups.has(turn.id)) return;
    this.empty?.remove();
    this.empty = null;
    const group = h(
      "div",
      { class: "sh-turn" },
      h("div", { class: "sh" }, ...promptHead(turn.at, this.prompt()), turn.text),
    );
    this.groups.set(turn.id, group);
    this.el.insertBefore(group, this.thinking);
    if (turn.reply) this.addReply(turn.id, turn.reply);
    this.scrollToEnd();
  }

  addReply(turnId: string, reply: Reply): void {
    const group = this.groups.get(turnId);
    if (!group || group.childElementCount > 1) return;
    const output = h(
      "div",
      { class: "sh sh-output" },
      h("span", { class: "output-mark", text: m["shell.output_mark"]() }),
      document.createTextNode(" "),
      reply.say,
    );
    group.append(
      h(
        "div",
        { class: "sh sh-meta" },
        ...withBoldName(
          (name) => m["shell.finished"]({ name, duration: formatDuration(reply.thinkingMs) }),
          m["app.name"](),
        ),
      ),
      output,
    );
    this.lastOutput = output;
    this.scrollToEnd();
  }

  /** 話し中のカーソルを、最後の返事の行の末尾に出す・消す。 */
  setSpeaking(on: boolean): void {
    if (!on || !this.lastOutput) {
      this.cursor.remove();
      return;
    }
    if (this.cursor.parentElement === this.lastOutput) return;
    this.lastOutput.append(this.cursor);
    this.scrollToEnd();
  }

  /** 考え中の行を出す・消す。 */
  setThinking(on: boolean): void {
    if (on === (this.thinking !== null)) return;
    if (!on) {
      this.thinking?.remove();
      this.thinking = null;
      if (this.spinnerTimer) clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
      return;
    }
    const spinner = h("b", { text: BRAILLE[0] ?? "" });
    this.thinking = h(
      "div",
      { class: "sh sh-meta" },
      ...withBoldName((name) => m["shell.thinking"]({ name }), m["app.name"]()),
      document.createTextNode(" "),
      h("span", { class: "think", attrs: { "aria-hidden": "true" } }, spinner),
      h("span", { class: "sr-only", text: m["log.thinking"]() }),
    );
    this.el.append(this.thinking);
    let frame = 0;
    this.spinnerTimer = setInterval(() => {
      if (reducedMotion()) return;
      frame = (frame + 1) % BRAILLE.length;
      spinner.textContent = BRAILLE[frame] ?? "";
    }, SPINNER_STEP_MS);
    this.scrollToEnd();
  }

  private scrollToEnd(): void {
    this.el.scrollTop = this.el.scrollHeight;
  }
}
