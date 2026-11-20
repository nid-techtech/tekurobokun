// ランチャー（apps/launcher）の画面。S03a〜S03e。
// サービスの起動と監視はRust側（ServiceSupervisor）、backendの管理用APIはAdminClient、
// 正→副の切り替えの判断はHealthWatcherが受け持ち、ここではそれらをつないで描く。

import "./styles.css";
import { initLocale, m } from "@tekurobokun/i18n";
import type { AdminEventMessage, AdminStatus, PairingCode } from "@tekurobokun/protocol";
import { AdminClient, browserSocket, type HttpMethod } from "./admin_client.ts";
import { clock, reasonText, remainingSeconds, serviceName, sourceLabel } from "./format.ts";
import { HealthWatcher, type WatchLog } from "./health_watcher.ts";
import { qrElement } from "./qr.ts";
import { type LauncherConfig, type ServiceView, supervisor } from "./supervisor.ts";
import { type Callbacks, type EventLine, render } from "./view.ts";

/** できごとの一覧に残す行数 */
const MAX_EVENTS = 60;
/** 登録コードの発行に失敗したら、次に試すまで待つ時間 */
const ISSUE_RETRY_MS = 5000;

initLocale({ dev: import.meta.env.DEV });
document.title = m["launcher.title"]();

const root = document.getElementById("app") as HTMLElement;
const info = await supervisor.launchInfo();
const config: LauncherConfig | null = info.config;

const state = {
  views: [] as ServiceView[],
  connected: false,
  status: null as AdminStatus | null,
  events: [] as EventLine[],
  pair: null as { code: PairingCode; qr: SVGSVGElement | null } | null,
  zoom: false,
  issuing: false,
  issueRetryAt: 0,
};

function log(text: string, error = false): void {
  state.events.push({ text, error });
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  draw();
}

const now = () => new Date();
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const logError = (e: unknown) =>
  log(m["launcher.ev_error"]({ time: clock(now()), detail: message(e) }), true);
const logAdminError = (e: unknown) =>
  log(m["launcher.ev_admin_failed"]({ time: clock(now()), detail: message(e) }), true);

// ===== backendの管理用API =====

const admin = new AdminClient({
  port: config?.adminPort ?? 8788,
  transport: (method: HttpMethod, path: string, body?: string) =>
    supervisor.adminRequest(method, path, body),
  socket: browserSocket,
  handlers: {
    onStatus: (status) => {
      state.status = status;
      void watcher?.onStatus(status.llmModel, status.session);
      void ensureCode();
      draw();
    },
    onEvent: onAdminEvent,
    onConnection: (connected) => {
      state.connected = connected;
      if (!connected) {
        state.pair = null;
        state.zoom = false;
      }
      draw();
    },
  },
});

function deviceName(id: string): string {
  return state.status?.devices.find((d) => d.id === id)?.name ?? id;
}

function onAdminEvent(event: AdminEventMessage): void {
  const time = clock(new Date(event.at));
  switch (event.kind) {
    case "llm_timeout":
      void watcher?.onLlmTimeout();
      return;
    case "paired": {
      // detailは「役割 名前 id」
      const name = event.detail.split(" ")[1] ?? event.detail;
      log(m["launcher.ev_paired"]({ time, name }));
      // 使ったコードは使えないので、新しいコードを出す
      void issueCode();
      return;
    }
    case "unpaired":
      log(m["launcher.ev_unpaired"]({ time, name: deviceName(event.detail) }));
      return;
    case "reset":
      log(
        event.detail === "manual"
          ? m["launcher.ev_reset_manual"]({ time })
          : m["launcher.ev_reset"]({ time }),
      );
      return;
    case "input_source":
      log(m["launcher.ev_input_source"]({ time, source: sourceLabel(event.detail) }));
      return;
    case "mic":
      log(
        event.detail === "paused"
          ? m["launcher.ev_mic_paused"]({ time })
          : m["launcher.ev_mic_resumed"]({ time }),
      );
      return;
  }
}

// ===== 登録コード =====

async function issueCode(): Promise<void> {
  if (state.issuing || !state.connected) return;
  state.issuing = true;
  try {
    const code = await admin.issueCode();
    let qr: SVGSVGElement | null = null;
    try {
      qr = await qrElement(code.qr);
    } catch (e) {
      logError(e);
    }
    state.pair = { code, qr };
  } catch (e) {
    state.issueRetryAt = Date.now() + ISSUE_RETRY_MS;
    logAdminError(e);
  } finally {
    state.issuing = false;
    draw();
  }
}

/** つながっていて、コードがない・期限が切れたら、新しいコードを出す。 */
async function ensureCode(): Promise<void> {
  if (!state.connected || Date.now() < state.issueRetryAt) return;
  if (state.pair && remainingSeconds(state.pair.code.expiresAt, now()) > 0) return;
  await issueCode();
}

// ===== 正→副の切り替え =====

function watchLogLine(entry: WatchLog): void {
  const time = clock(now());
  switch (entry.kind) {
    case "heartbeat_fail":
      log(m["launcher.ev_heartbeat_fail"]({ time, n: entry.n, max: entry.max }), true);
      return;
    case "llm_timeout":
      log(m["launcher.ev_llm_timeout"]({ time, n: entry.n, max: entry.max }), true);
      return;
    case "switched":
      log(m["launcher.ev_switched"]({ time }));
      return;
    case "switched_back":
      log(m["launcher.ev_switched_back"]({ time }));
      return;
    case "switch_failed":
      log(m["launcher.ev_switch_failed"]({ time, detail: entry.detail }), true);
      return;
    case "admin_failed":
      log(m["launcher.ev_admin_failed"]({ time, detail: entry.detail }), true);
      return;
  }
}

const watcher: HealthWatcher | null = config
  ? new HealthWatcher(
      {
        probe: () => supervisor.probe(config.heartbeat.url, config.heartbeat.timeoutMs),
        switchToSub: (mark) =>
          supervisor.switchService(config.failover.from, config.failover.to, mark),
        switchToMain: () =>
          supervisor.switchService(config.failover.to, config.failover.from, "standby"),
        setModel: (alias) => admin.setLlmModel(alias),
        now,
        log: watchLogLine,
        onChange: () => draw(),
      },
      config.heartbeat.failures,
    )
  : null;

// ===== サービス =====

function onServices(views: ServiceView[]): void {
  const before = new Map(state.views.map((v) => [v.id, v.state]));
  for (const v of views) {
    if (v.state === "failed" && before.get(v.id) !== "failed" && v.reason) {
      log(
        m["launcher.ev_failed"]({
          time: clock(now()),
          name: serviceName(v.id),
          reason: reasonText(v.reason),
        }),
        true,
      );
    }
  }
  state.views = views;
  const main = views.find((v) => v.id === config?.failover.from);
  if (main) watcher?.setMainState(main.state, main.reason);
  draw();
}

const run = (p: Promise<unknown>) => void p.catch(logError);
const runAdmin = (p: Promise<unknown>) => void p.catch(logAdminError);

const callbacks: Callbacks = {
  service: (kind, id) => {
    switch (kind) {
      case "start":
        return run(supervisor.start(id));
      case "stop":
        return run(supervisor.stop(id));
      case "restart":
        return run(supervisor.restart(id));
      case "show_log":
        return run(supervisor.openLog(id));
      case "switch_to_sub":
        return void watcher?.switchToSub(true);
      case "back_to_main":
        return void watcher?.backToMain();
    }
  },
  startAll: () => {
    log(m["launcher.ev_started"]({ time: clock(now()) }));
    run(supervisor.startAll());
  },
  stopAll: () => {
    log(m["launcher.ev_stopped"]({ time: clock(now()) }));
    watcher?.reset();
    run(supervisor.stopAll());
  },
  backToMain: () => void watcher?.backToMain(),
  setSource: (source) => runAdmin(admin.setInputSource(source)),
  toggleMic: () => {
    if (state.status) runAdmin(admin.setMic(!state.status.micPaused));
  },
  resetHistory: () => runAdmin(admin.reset()),
  unregister: (id, name) => {
    if (window.confirm(m["launcher.unregister_confirm"]({ name }))) runAdmin(admin.revoke(id));
  },
  newCode: () => void issueCode(),
  zoom: (open) => {
    state.zoom = open;
    draw();
  },
};

// ===== 描画 =====

let drawQueued = false;
/** 描き直す（同じ処理の中で何度呼ばれても1回にまとめる）。 */
function draw(): void {
  if (drawQueued) return;
  drawQueued = true;
  queueMicrotask(() => {
    drawQueued = false;
    render(
      root,
      {
        now: now(),
        views: state.views,
        ctx: {
          from: config?.failover.from ?? "",
          to: config?.failover.to ?? "",
          alias: watcher?.alias ?? "main",
          switching: watcher?.busy ?? false,
        },
        connected: state.connected,
        status: state.status,
        searchLimit: config?.searchMonthlyLimit ?? 0,
        events: state.events,
        pair: state.pair,
        zoom: state.zoom,
        failoverAt: watcher?.failoverAt ?? null,
        configError:
          info.configError === null ? null : { path: info.configPath, detail: info.configError },
      },
      callbacks,
    );
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.zoom) callbacks.zoom(false);
});

// ===== 起動 =====

// 設定で起動と同時に［すべて起動］を行ったなら、その行を先に出す（失敗の行より前に）
if (info.startedAllOnLaunch) log(m["launcher.ev_started"]({ time: clock(now()) }));
await supervisor.onServices(onServices);
onServices(await supervisor.list());
if (config) {
  watcher?.start(config.heartbeat.intervalMs);
  admin.connect();
}
// 稼働時間と登録コードの残り時間を進める
setInterval(() => {
  void ensureCode();
  draw();
}, 1000);
draw();
