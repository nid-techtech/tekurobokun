// 入力ページ（apps/console）。URLの`?device=`で端末名を名乗る（既定はtablet）。
// 表示はバックエンドから届くwelcome・status・turn_started・turn_replied・turn_search_started・
// turn_search_done・history_clearedだけで決める。
// 未登録（auth_required）ならS01iの登録コードの入力、つながらない・LLMかVOICEVOXが応答しないときはS01f、
// 別の端末が有効なときはS01gの全面の案内を出し、状況が戻れば自動で元の表示に戻る（再接続はLinkが続ける）。
// 入力元が機体のマイクのときは、ログの表示だけにする（S01h。入力欄とキーボードを出さない）。

import "./styles.css";
import { initLocale, m } from "@tekurobokun/i18n";
import type { ConsoleSettings, ServerMessage, StatusMessage } from "@tekurobokun/protocol";
import { h } from "./dom.ts";
import { FullNotice } from "./full_notice.ts";
import { Link } from "./link.ts";
import { LogView } from "./log_view.ts";
import { isViewOnly, noticeFor } from "./notice.ts";
import { PairForm } from "./pair_form.ts";
import { PromptInput } from "./prompt_input.ts";
import { type StatusKind, StatusLine } from "./status_line.ts";
import { browserStorage, TokenStore } from "./token_store.ts";
import { browserViewportFit } from "./viewport_fit.ts";

const DEFAULT_DEVICE = "tablet";

initLocale({ dev: import.meta.env.DEV });
document.title = m["app.name"]();

const device = new URLSearchParams(window.location.search).get("device") || DEFAULT_DEVICE;

const state: {
  connected: boolean;
  /** 未登録（auth_requiredを受けた）。welcomeで解ける */
  unpaired: boolean;
  settings: ConsoleSettings | null;
  status: StatusMessage | null;
  /** 調べている（turn_search_startedからturn_search_doneまで）。調べ終えたら、返事を考える間のスピナーを出す */
  searchPending: boolean;
} = {
  connected: false,
  unpaired: false,
  settings: null,
  status: null,
  searchPending: false,
};

/** プロンプトの表示。設定が空の項目は辞書の値を使う。 */
function promptText(): string {
  const p = state.settings?.prompt;
  return m["shell.prompt"]({
    user: p?.user || m["shell.user"](),
    host: p?.host || m["shell.host"](),
    dir: p?.dir || m["shell.dir"](),
  });
}

// キーボードを除いて見えている範囲に画面を合わせる。PWAでないときは最初のタップで全画面にする。
const viewportFit = browserViewportFit();
viewportFit.start();

const statusLine = new StatusLine();
const log = new LogView(promptText);
const notice = new FullNotice();
const input = new PromptInput(promptText(), 0, {
  onSend: (text) => link.send({ type: "utterance", text }),
  onTextChange: () => render(),
});

const pairForm = new PairForm({ onSubmit: (code) => link.pair(code) });
// S01hの下端の案内（入力は機体のマイクで受け付けている）。
const lockLine = h("div", { class: "lockline sh-comment", text: `# ${m["console.locked"]()}` });
lockLine.hidden = true;

const root = document.querySelector<HTMLElement>("#app");
root?.append(statusLine.el, log.el, notice.el, pairForm.message, input.el, lockLine, pairForm.row);

function currentNotice() {
  return noticeFor({
    connected: state.connected,
    welcomed: state.settings !== null,
    status: state.status,
    device,
  });
}

const isUnpaired = () => state.connected && state.unpaired;

/** ログ表示専用（S01h）にするか。案内を出しているときは出さない。 */
const viewOnly = () => !isUnpaired() && currentNotice() === null && isViewOnly(state.status);

function statusKind(): StatusKind {
  if (isUnpaired() || currentNotice() === "offline") return "offline";
  const session = state.status?.session ?? "idle";
  if (session === "thinking") return "thinking";
  if (session === "searching") return "searching";
  if (session === "speaking") return "speaking";
  if (viewOnly()) return state.status?.micPaused ? "mic_paused" : "listening_voice";
  return input.hasText ? "listening" : "ready";
}

function render(): void {
  // 未登録ならS01i。ログと入力ページの代わりに、登録コードの入力を出す。
  const unpaired = isUnpaired();
  const kind = unpaired ? null : currentNotice();
  const session = state.status?.session ?? "idle";
  const locked = viewOnly();
  const wasShown = notice.shown;
  const wasLocked = !lockLine.hidden;
  notice.set(kind);
  pairForm.set(unpaired);
  log.el.hidden = kind !== null || unpaired;
  lockLine.hidden = !locked;
  input.setEnabled(!unpaired && kind === null && !locked && session === "idle");
  // 案内やログ表示専用を出している間は、入力欄のフォーカスを外して画面のキーボードを閉じる（S01f・S01g・S01h）。
  if ((kind !== null && !wasShown) || (locked && !wasLocked)) input.blur();
  log.setThinking(
    kind === null && (session === "thinking" || (session === "searching" && !state.searchPending)),
  );
  log.setSpeaking(kind === null && session === "speaking");
  statusLine.set(statusKind());
}

function applySettings(settings: ConsoleSettings): void {
  state.settings = settings;
  document.documentElement.style.setProperty("--term-text-size", `${settings.fontSizePx}px`);
  input.configure(promptText(), settings.autosendMs);
  viewportFit.setBottomInset(settings.bottomInsetPx);
}

function onMessage(message: ServerMessage): void {
  switch (message.type) {
    case "auth_required":
      state.unpaired = true;
      break;
    case "pair_failed":
      pairForm.failed();
      return;
    case "paired":
      // Linkがトークンを保存してhelloを送り直す。welcomeが届いたら元の表示に戻る。
      return;
    case "welcome":
      state.unpaired = false;
      applySettings(message.settings);
      log.reset(message.history);
      break;
    case "status":
      state.status = message;
      break;
    case "turn_started":
      state.searchPending = false;
      log.addTurn(message.turn);
      break;
    case "turn_search_started":
      state.searchPending = true;
      log.addSearchStarted(message.turnId, message.query, message.preSay, message.thinkingMs);
      break;
    case "turn_search_done":
      state.searchPending = false;
      log.addSearchDone(message.turnId, message.searchMs);
      break;
    case "turn_replied":
      log.addReply(message.turnId, message);
      break;
    case "history_cleared":
      log.addNote(
        message.reason === "idle"
          ? m["console.history_reset"]({
              seconds: Math.round((state.settings?.idleResetMs ?? 0) / 1000),
            })
          : m["console.history_reset_manual"](),
      );
      break;
    case "speech":
      return;
  }
  render();
}

const link = new Link(
  Link.urlFor(window.location),
  device,
  new TokenStore(device, browserStorage()),
  {
    onMessage,
    onOpen: () => {
      state.connected = true;
      render();
    },
    onClose: () => {
      state.connected = false;
      state.unpaired = false;
      state.settings = null;
      state.status = null;
      state.searchPending = false;
      render();
    },
  },
);

render();
link.connect();

// ログをタップしてもキーボードを閉じないよう、入力欄にフォーカスを戻す。
// 案内から戻ったあと、キーボードが自動で開かない端末でも、ログをタップすれば開く。
// ログ表示専用（S01h）の間は、キーボードを出さない。
log.el.addEventListener("click", () => {
  if (!viewOnly()) input.focus();
});
