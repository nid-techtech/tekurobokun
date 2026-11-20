// ServiceSupervisor（Rust、src-tauri/src/supervisor.rs）とのやりとり。
// 状態はRustが持ち、変わるたびに「services」のイベントで全サービスの状態が届く。

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const SERVICE_STATES = [
  "running",
  "standby",
  "stopped",
  "loading",
  "waiting",
  "failed",
  "down",
] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];

/** 失敗の理由（文言は画面が辞書で組み立てる）。 */
export type FailReason =
  | { kind: "port_in_use"; port: number }
  | { kind: "exited"; code: number | null }
  | { kind: "spawn"; detail: string }
  | { kind: "timeout"; seconds: number }
  | { kind: "not_configured" };

export type ServiceView = {
  id: string;
  detail: string;
  port: number | null;
  standby: boolean;
  state: ServiceState;
  /** 起動した時刻（UNIX時刻のミリ秒） */
  startedAt: number | null;
  reason: FailReason | null;
  logPath: string;
};

/** ランチャーの設定（launcher.json）のうち、画面が使うもの。 */
export type LauncherConfig = {
  adminPort: number;
  startAllOnLaunch: boolean;
  autostart: boolean;
  /** 検索の無料枠（月あたり）。外部サービスの行の分母 */
  searchMonthlyLimit: number;
  heartbeat: { url: string; intervalMs: number; timeoutMs: number; failures: number };
  failover: { from: string; to: string; releaseTimeoutMs: number; settleMs: number };
};

export type LaunchInfo = {
  config: LauncherConfig | null;
  configPath: string;
  configError: string | null;
  startedAllOnLaunch: boolean;
  autostart: boolean | null;
};

/** 止めたあとの状態（正→副の切り替えは「応答なし」、正に戻すときの副は「待機」）。 */
export type SwitchMark = "down" | "standby" | "stopped";

export const supervisor = {
  launchInfo: () => invoke<LaunchInfo>("launch_info"),
  list: () => invoke<ServiceView[]>("list_services"),
  start: (id: string) => invoke<void>("start_service", { id }),
  stop: (id: string) => invoke<void>("stop_service", { id }),
  restart: (id: string) => invoke<void>("restart_service", { id }),
  startAll: () => invoke<void>("start_all"),
  stopAll: () => invoke<void>("stop_all"),
  switchService: (from: string, to: string, mark: SwitchMark) =>
    invoke<void>("switch_service", { from, to, mark }),
  probe: (url: string, timeoutMs: number) => invoke<boolean>("probe", { url, timeoutMs }),
  openLog: (id: string) => invoke<void>("open_log", { id }),
  /** backendの管理用APIを呼ぶ（AdminClientのtransport）。 */
  adminRequest: (method: string, path: string, body?: string) =>
    invoke<{ status: number; body: string }>("admin_request", { method, path, body }),
  onServices: (handler: (views: ServiceView[]) => void): Promise<UnlistenFn> =>
    listen<ServiceView[]>("services", (event) => handler(event.payload)),
};
