// LogView：シェル風のログ（S01a〜S01e、S01h）。
// 来場者の発言は時刻つきのプロンプト行（機体のマイクで聞いた発言は「(mic)」付き）、
// 返事は「finished thinking in」の行と「>」の行。
// 検索したターンは、前置きの返事、「searched "検索語" in」の行、検索のあとの返事の順（S01h）。
// 会話を区切ったら（history_cleared）、コメントの行を出す（S01h）。
// 考え中は末尾に「is thinking」と点字のスピナー。話し中は最後の返事の行の末尾でカーソルが点滅する。
// ログは消さず、下に追加して末尾へスクロールする。

import { m } from "@tekurobokun/i18n";
import type { Reply, Turn, TurnSearch } from "@tekurobokun/protocol";
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

/** 1ターンの行のまとまり。 */
type Group = {
  el: HTMLElement;
  /** 検索語（検索の行に使う） */
  query: string | null;
  searched: boolean;
  replied: boolean;
};

export class LogView {
  readonly el: HTMLElement;
  private readonly groups = new Map<string, Group>();
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
    const mic =
      turn.via === "mic"
        ? [
            h("span", { class: "mic", text: m["console.heard_mark"]() }),
            document.createTextNode(" "),
          ]
        : [];
    const el = h(
      "div",
      { class: "sh-turn" },
      h("div", { class: "sh" }, ...promptHead(turn.at, this.prompt()), ...mic, turn.text),
    );
    this.groups.set(turn.id, { el, query: null, searched: false, replied: false });
    this.el.insertBefore(el, this.thinking);
    // 会話ログから戻したターンは、前置きの考えた時間を持たないため、前置きの「>」の行だけを出す。
    if (turn.search) this.restoreSearch(turn.id, turn.search);
    if (turn.reply) this.addReply(turn.id, turn.reply);
    this.scrollToEnd();
  }

  private restoreSearch(turnId: string, search: TurnSearch): void {
    this.addSearchStarted(turnId, search.query, search.preSay, null);
    if (search.searchMs !== null) this.addSearchDone(turnId, search.searchMs);
  }

  /** 調べ始めた：前置きの返事を出す（thinkingMsがnullなら「finished thinking in」の行を省く）。 */
  addSearchStarted(turnId: string, query: string, preSay: string, thinkingMs: number | null): void {
    const group = this.groups.get(turnId);
    if (!group || group.query !== null || group.replied) return;
    group.query = query;
    if (thinkingMs !== null) group.el.append(this.finishedLine(thinkingMs));
    if (preSay !== "") {
      const output = this.outputLine(preSay);
      group.el.append(output);
      this.lastOutput = output;
    }
    this.scrollToEnd();
  }

  /** 調べ終えた：「searched "検索語" in」の行を出す。 */
  addSearchDone(turnId: string, searchMs: number): void {
    const group = this.groups.get(turnId);
    if (!group || group.query === null || group.searched || group.replied) return;
    group.searched = true;
    const query = group.query;
    group.el.append(
      h(
        "div",
        { class: "sh sh-meta" },
        ...withBoldName(
          (name) => m["shell.searched"]({ name, query, duration: formatDuration(searchMs) }),
          m["app.name"](),
        ),
      ),
    );
    this.scrollToEnd();
  }

  addReply(turnId: string, reply: Reply): void {
    const group = this.groups.get(turnId);
    if (!group || group.replied) return;
    group.replied = true;
    const output = this.outputLine(reply.say);
    group.el.append(this.finishedLine(reply.thinkingMs), output);
    this.lastOutput = output;
    this.scrollToEnd();
  }

  /** コメントの行（「# …」）を出す。会話を区切ったときに使う。 */
  addNote(text: string): void {
    this.empty?.remove();
    this.empty = null;
    this.el.insertBefore(h("div", { class: "sh sh-comment", text: `# ${text}` }), this.thinking);
    this.scrollToEnd();
  }

  private finishedLine(thinkingMs: number): HTMLElement {
    return h(
      "div",
      { class: "sh sh-meta" },
      ...withBoldName(
        (name) => m["shell.finished"]({ name, duration: formatDuration(thinkingMs) }),
        m["app.name"](),
      ),
    );
  }

  private outputLine(say: string): HTMLElement {
    return h(
      "div",
      { class: "sh sh-output" },
      h("span", { class: "output-mark", text: m["shell.output_mark"]() }),
      document.createTextNode(" "),
      say,
    );
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
