// ランチャーの画面の組み立て（S03a〜S03e）。モデルからDOMを作り直す（状態は持たない）。
// 文言は辞書から引き、記号（# [] ● ○ ✕）は見せ方として扱う。

import { m } from "@tekurobokun/i18n";
import type { AdminStatus, InputSource, PairingCode } from "@tekurobokun/protocol";
import { h } from "./dom.ts";
import {
  type ActionContext,
  type ActionKind,
  canStartAll,
  clock,
  dotClass,
  hostOf,
  inputSourceOptions,
  progressBar,
  reasonText,
  remainingSeconds,
  serviceActions,
  serviceName,
  shortDateTime,
  sourceLabel,
  stateClass,
  stateText,
  summaryCounts,
  uptime,
} from "./format.ts";
import type { ServiceView } from "./supervisor.ts";

export type EventLine = { text: string; error: boolean };

export type Model = {
  now: Date;
  views: ServiceView[];
  ctx: ActionContext;
  /** backendの管理用APIにつながっている（/admin/eventsのstatusを受けた） */
  connected: boolean;
  status: AdminStatus | null;
  searchLimit: number;
  events: EventLine[];
  pair: { code: PairingCode; qr: SVGSVGElement | null } | null;
  zoom: boolean;
  /** 自動で副に切り替えた時刻（警告の帯） */
  failoverAt: Date | null;
  configError: { path: string; detail: string } | null;
};

export type Callbacks = {
  service: (kind: ActionKind, id: string) => void;
  startAll: () => void;
  stopAll: () => void;
  backToMain: () => void;
  setSource: (source: InputSource) => void;
  toggleMic: () => void;
  resetHistory: () => void;
  unregister: (id: string, name: string) => void;
  newCode: () => void;
  zoom: (open: boolean) => void;
};

/** 描き直してもフォーカスを保つための目印。 */
const key = (el: HTMLElement, value: string) => {
  el.dataset.key = value;
  return el;
};

function button(
  label: string,
  onClick: () => void,
  opts: { disabled?: boolean; primary?: boolean; key: string },
) {
  const el = h("button", {
    class: opts.primary ? "ctl primary" : "ctl",
    text: label,
    attrs: { type: "button" },
  });
  el.disabled = opts.disabled ?? false;
  el.addEventListener("click", onClick);
  return key(el, opts.key);
}

const comment = (text: string) => h("div", { class: "sh-comment", text: `# ${text}` });

function actionLabel(kind: ActionKind): string {
  switch (kind) {
    case "start":
      return m["launcher.start"]();
    case "stop":
      return m["launcher.stop"]();
    case "restart":
      return m["launcher.restart"]();
    case "switch_to_sub":
      return m["launcher.switch_to_sub"]();
    case "back_to_main":
      return m["launcher.back_to_main"]();
    case "show_log":
      return m["launcher.show_log"]();
  }
}

// ===== 状態行 =====

function titleBar(model: Model): HTMLElement {
  const { up, all } = summaryCounts(model.views, model.ctx.from);
  const left = h(
    "span",
    {},
    h("b", { text: m["launcher.title"]() }),
    `  [${m["launcher.summary"]({ up, all })}]`,
  );
  const right = h("span");
  if (model.status) {
    right.textContent = `${m["launcher.input_source"]({ source: sourceLabel(model.status.inputSource) })}  ${m["launcher.public_url"]({ url: hostOf(model.status.publicUrl) })}`;
  }
  return h("div", { class: "t-bar" }, left, right);
}

// ===== 警告の帯 =====

function banners(model: Model, cb: Callbacks): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (model.configError) {
    out.push(
      h(
        "div",
        { class: "banner" },
        h("span", { text: `! ${m["launcher.config_error"](model.configError)}` }),
      ),
    );
  }
  if (model.failoverAt) {
    out.push(
      h(
        "div",
        { class: "banner", attrs: { role: "alert" } },
        h("span", {
          text: `! ${m["launcher.failover_msg"]({ time: clock(model.failoverAt) })}`,
        }),
        button(m["launcher.back_to_main"](), cb.backToMain, {
          disabled: model.ctx.switching,
          key: "banner-back",
        }),
      ),
    );
  }
  // 起動中の案内（S03b）。失敗したサービスがあれば出さない（S03d。理由は行とできごとに出る）
  const anyFailed = model.views.some((v) => v.state === "failed");
  if (!anyFailed && model.views.some((v) => v.id === model.ctx.from && v.state === "loading")) {
    out.push(h("div", { class: "banner info" }, h("span", { text: m["launcher.loading_msg"]() })));
  }
  return out;
}

// ===== サービス =====

function serviceRow(view: ServiceView, model: Model, cb: Callbacks): HTMLElement {
  const failed = view.state === "failed" && view.reason !== null;
  const detail = failed && view.reason ? reasonText(view.reason) : view.detail;
  const port = !failed && view.port !== null ? ` :${view.port}` : "";
  const showUptime =
    view.startedAt !== null && (view.state === "running" || view.state === "loading");
  const actions = h(
    "span",
    {},
    ...serviceActions(view, model.ctx).map((a) =>
      button(actionLabel(a.kind), () => cb.service(a.kind, view.id), {
        disabled: a.disabled,
        key: `svc-${view.id}-${a.kind}`,
      }),
    ),
  );
  return h(
    "div",
    { class: "svc" },
    h("span", { class: dotClass(view.state) }),
    h("span", { class: "name", text: serviceName(view.id) }),
    h("span", { class: "detail", text: `${detail}${port}`, attrs: { title: `${detail}${port}` } }),
    h("span", { class: stateClass(view.state), text: `[${stateText(view.state)}]` }),
    h("span", {
      class: "up",
      text:
        showUptime && view.startedAt !== null ? uptime(model.now.getTime() - view.startedAt) : "",
    }),
    actions,
  );
}

function services(model: Model, cb: Callbacks): HTMLElement {
  return h(
    "div",
    { class: "l-sec" },
    comment(m["launcher.sec_services"]()),
    ...model.views.map((v) => serviceRow(v, model, cb)),
    h(
      "div",
      { class: "l-actions" },
      button(m["launcher.start_all"](), cb.startAll, {
        primary: true,
        disabled: !canStartAll(model.views, model.ctx),
        key: "start-all",
      }),
      button(m["launcher.stop_all"](), cb.stopAll, { key: "stop-all" }),
    ),
  );
}

// ===== 入力元 =====

function inputSection(model: Model, cb: Callbacks): HTMLElement {
  const status = model.status;
  const disabled = !model.connected || status === null;
  const radios = h("div", { class: "radio", attrs: { role: "radiogroup" } });
  radios.setAttribute("aria-label", m["launcher.sec_input"]());
  if (status) {
    for (const source of inputSourceOptions(status)) {
      const on = status.inputSource === source;
      const el = h("button", {
        text: `(${on ? "●" : " "}) ${sourceLabel(source)}`,
        attrs: { type: "button", role: "radio", "aria-checked": String(on) },
      });
      el.disabled = disabled;
      el.addEventListener("click", () => {
        if (!on) cb.setSource(source);
      });
      radios.append(key(el, `src-${source}`));
    }
  }
  const micLabel = status?.micPaused ? m["launcher.mic_resume"]() : m["launcher.mic_pause"]();
  return h(
    "div",
    { class: "l-sec" },
    comment(m["launcher.sec_input"]()),
    radios,
    h(
      "div",
      {},
      button(micLabel, cb.toggleMic, { disabled, key: "mic" }),
      button(m["launcher.reset_history"](), cb.resetHistory, { disabled, key: "reset" }),
    ),
  );
}

// ===== 外部サービス =====

function externals(model: Model): HTMLElement {
  const count = model.status?.searchCount.count;
  return h(
    "div",
    { class: "l-sec" },
    comment(m["launcher.sec_external"]()),
    h(
      "div",
      { class: "svc" },
      h("span", { class: model.connected ? "dot-on" : "dot-off" }),
      h("span", { class: "name", text: m["launcher.ext_name_search"]() }),
      h("span", { class: "detail", text: m["launcher.ext_search"]() }),
      h("span", {
        class: "ok",
        text:
          count === undefined
            ? ""
            : m["launcher.ext_count"]({ used: count, limit: model.searchLimit }),
      }),
      h("span"),
      h("span"),
    ),
  );
}

// ===== 端末 =====

function devices(model: Model, cb: Callbacks): HTMLElement {
  const rows = (model.status?.devices ?? []).map((d) =>
    h(
      "div",
      { class: "svc" },
      h("span", { class: d.connected ? "dot-on" : "dot-off" }),
      h("span", { class: "name", text: d.name }),
      h("span", {
        class: "detail",
        text: m["launcher.dev_since"]({ time: shortDateTime(d.registeredAt) }),
      }),
      h("span", {
        class: d.connected ? "ok" : "up",
        text: `[${d.connected ? m["launcher.dev_connected"]() : m["launcher.dev_offline"]()}]`,
      }),
      h("span"),
      h(
        "span",
        {},
        button(m["launcher.unregister"](), () => cb.unregister(d.id, d.name), {
          disabled: !model.connected,
          key: `dev-${d.id}`,
        }),
      ),
    ),
  );
  return h("div", { class: "l-sec" }, comment(m["launcher.sec_devices"]()), ...rows);
}

// ===== できごと =====

function events(model: Model): HTMLElement {
  return h(
    "div",
    { class: "l-sec ev" },
    comment(m["launcher.sec_events"]()),
    h(
      "div",
      { class: "events", attrs: { role: "log" } },
      ...model.events.map((e) => h("span", { class: e.error ? "err" : "", text: e.text })),
    ),
  );
}

// ===== 端末の登録 =====

function qrBox(qr: SVGSVGElement | null, dim: boolean): HTMLElement {
  const box = h("div", { class: dim ? "qr dim" : "qr" });
  if (qr) box.append(qr.cloneNode(true));
  return box;
}

function pairPanel(model: Model, cb: Callbacks): HTMLElement[] {
  const head = comment(m["launcher.sec_pair"]());
  if (!model.connected || !model.pair) {
    return [
      head,
      qrBox(null, true),
      h("div", { class: "sh-comment", text: `# ${m["launcher.pair_wait_backend"]()}` }),
    ];
  }
  const seconds = remainingSeconds(model.pair.code.expiresAt, model.now);
  return [
    head,
    qrBox(model.pair.qr, false),
    h("div", { class: "pair-code", text: model.pair.code.code }),
    h(
      "div",
      {},
      `${m["launcher.pair_remaining"]({ seconds })} `,
      h("span", { class: "bar-text", text: progressBar(seconds, 60) }),
    ),
    comment(m["launcher.pair_once"]()),
    h(
      "div",
      {},
      button(m["launcher.pair_new"](), cb.newCode, { key: "pair-new" }),
      button(m["launcher.pair_zoom"](), () => cb.zoom(true), { primary: true, key: "pair-zoom" }),
    ),
  ];
}

/** 登録コードの拡大表示（S03e）。 */
function zoomView(model: Model, cb: Callbacks): HTMLElement | null {
  if (!model.zoom || !model.pair || !model.connected) return null;
  const seconds = remainingSeconds(model.pair.code.expiresAt, model.now);
  return h(
    "div",
    { class: "qr-full", attrs: { role: "dialog", "aria-modal": "true" } },
    qrBox(model.pair.qr, false),
    h(
      "div",
      { class: "info" },
      h("div", { class: "pair-code", text: model.pair.code.code }),
      h("div", { text: m["launcher.pair_remaining"]({ seconds }) }),
      h(
        "div",
        {},
        button(m["launcher.pair_close"](), () => cb.zoom(false), { key: "pair-close" }),
      ),
    ),
  );
}

/** 画面全体を描き直す。フォーカスしていたボタンは、描き直したあとも同じものにフォーカスする。 */
export function render(root: HTMLElement, model: Model, cb: Callbacks): void {
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
  root.className = "win";
  const zoom = zoomView(model, cb);
  root.replaceChildren(
    titleBar(model),
    h(
      "div",
      { class: "l-body" },
      h(
        "div",
        { class: "l-main" },
        ...banners(model, cb),
        services(model, cb),
        inputSection(model, cb),
        externals(model),
        devices(model, cb),
        events(model),
      ),
      h("div", { class: "l-side" }, ...pairPanel(model, cb)),
    ),
    ...(zoom ? [zoom] : []),
  );
  if (focused) {
    root.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus();
  }
}
