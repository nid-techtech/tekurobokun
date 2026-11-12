// 入力ページ（apps/console）。URLの`?device=`で端末名を名乗る（既定はtablet）。
// 表示はバックエンドから届くwelcome・status・turn_started・turn_repliedだけで決める。

import "./styles.css";
import { initLocale, m } from "@tekurobokun/i18n";
import type { ConsoleSettings, ServerMessage, SessionState } from "@tekurobokun/protocol";
import { Link } from "./link.ts";
import { LogView } from "./log_view.ts";
import { PromptInput } from "./prompt_input.ts";
import { type StatusKind, StatusLine } from "./status_line.ts";
import { browserViewportFit } from "./viewport_fit.ts";

const DEFAULT_DEVICE = "tablet";

initLocale({ dev: import.meta.env.DEV });
document.title = m["app.name"]();

const device = new URLSearchParams(window.location.search).get("device") || DEFAULT_DEVICE;

const state: { connected: boolean; settings: ConsoleSettings | null; session: SessionState } = {
  connected: false,
  settings: null,
  session: "idle",
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
const input = new PromptInput(promptText(), 0, {
  onSend: (text) => link.send({ type: "utterance", text }),
  onTextChange: () => render(),
});

const root = document.querySelector<HTMLElement>("#app");
root?.append(statusLine.el, log.el, input.el);

function statusKind(): StatusKind {
  if (!state.connected || !state.settings) return "offline";
  if (state.session === "thinking") return "thinking";
  if (state.session === "speaking") return "speaking";
  return input.hasText ? "listening" : "ready";
}

function render(): void {
  const ready = state.connected && state.settings !== null;
  input.setEnabled(ready && state.session === "idle");
  log.setThinking(ready && state.session === "thinking");
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
    case "welcome":
      applySettings(message.settings);
      log.reset(message.history);
      break;
    case "status":
      state.session = message.session;
      break;
    case "turn_started":
      log.addTurn(message.turn);
      break;
    case "turn_replied":
      log.addReply(message.turnId, message);
      break;
    case "speech":
      return;
  }
  render();
}

const link = new Link(Link.urlFor(window.location), device, {
  onMessage,
  onOpen: () => {
    state.connected = true;
    render();
  },
  onClose: () => {
    state.connected = false;
    state.settings = null;
    render();
  },
});

render();
link.connect();

// ログをタップしてもキーボードを閉じないよう、入力欄にフォーカスを戻す。
log.el.addEventListener("click", () => input.focus());
