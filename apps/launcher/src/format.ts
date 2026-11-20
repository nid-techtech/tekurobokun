// 画面に出す値の組み立て（DOMに触れない部分。テストする）。文言は辞書から引き、文字列を連結して文を作らない。

import { intlLocale, m } from "@tekurobokun/i18n";
import type { AdminStatus, InputSource } from "@tekurobokun/protocol";
import type { FailReason, ServiceState, ServiceView } from "./supervisor.ts";

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 稼働時間（1時間未満は「0m21s」、それ以上は「2h13m」）。 */
export function uptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  if (hours === 0) return m["launcher.uptime_ms"]({ minutes, seconds: pad2(total % 60) });
  return m["launcher.uptime_hm"]({ hours, minutes: pad2(minutes) });
}

/** できごとの時刻（HH:MM:SS）。 */
export function clock(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** 端末の登録日時（月/日 時:分）。 */
export function shortDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(intlLocale(), {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** 失敗の理由の文。 */
export function reasonText(reason: FailReason): string {
  switch (reason.kind) {
    case "port_in_use":
      return m["launcher.port_in_use"]({ port: reason.port });
    case "exited":
      return reason.code === null
        ? m["launcher.reason_killed"]()
        : m["launcher.reason_exited"]({ code: reason.code });
    case "spawn":
      return m["launcher.reason_spawn"]({ detail: reason.detail });
    case "timeout":
      return m["launcher.reason_timeout"]({ seconds: reason.seconds });
    case "not_configured":
      return m["launcher.reason_not_configured"]();
  }
}

/** サービスの名前（辞書にないものはidのまま）。 */
export function serviceName(id: string): string {
  switch (id) {
    case "llm.main":
      return m["launcher.svc_llm_main"]();
    case "llm.sub":
      return m["launcher.svc_llm_sub"]();
    case "stt":
      return m["launcher.svc_stt"]();
    case "tts":
      return m["launcher.svc_tts"]();
    case "backend":
      return m["launcher.svc_backend"]();
    case "tunnel":
      return m["launcher.svc_tunnel"]();
    default:
      return id;
  }
}

export function stateText(state: ServiceState): string {
  switch (state) {
    case "running":
      return m["launcher.state_running"]();
    case "standby":
      return m["launcher.state_standby"]();
    case "stopped":
      return m["launcher.state_stopped"]();
    case "loading":
      return m["launcher.state_loading"]();
    case "waiting":
      return m["launcher.state_waiting"]();
    case "failed":
      return m["launcher.state_failed"]();
    case "down":
      return m["launcher.state_down"]();
  }
}

/** 印（●○✕）のクラス。 */
export function dotClass(state: ServiceState): string {
  if (state === "running" || state === "loading") return "dot-on";
  if (state === "failed" || state === "down") return "dot-bad";
  return "dot-off";
}

/** 状態の文字のクラス。 */
export function stateClass(state: ServiceState): string {
  if (state === "running") return "ok";
  if (state === "loading" || state === "waiting") return "wait";
  if (state === "failed" || state === "down") return "bad";
  return "up";
}

/** 状態行の「n/m 稼働中」。待機（副のLLM）は正常として数える。 */
export function summaryCounts(views: ServiceView[]): { up: number; all: number } {
  const up = views.filter((v) => v.state === "running" || v.state === "standby").length;
  return { up, all: views.length };
}

/** 公開URLのホスト名（状態行に出す）。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 入力元の名前。 */
export function sourceLabel(source: InputSource): string {
  return source === "robot"
    ? m["launcher.src_robot"]()
    : m["launcher.src_console"]({ name: source });
}

/** 入力元の選択肢：機体のマイクと、登録済みのconsole（いまの入力元が一覧になければ足す）。 */
export function inputSourceOptions(status: AdminStatus): InputSource[] {
  const options: InputSource[] = ["robot"];
  for (const d of status.devices) {
    if (d.role === "console" && !options.includes(d.name)) options.push(d.name);
  }
  if (!options.includes(status.inputSource)) options.push(status.inputSource);
  return options;
}

/** 登録コードの残り秒数（0未満にしない）。 */
export function remainingSeconds(expiresAt: string, now: Date): number {
  const ms = new Date(expiresAt).getTime() - now.getTime();
  return Number.isNaN(ms) ? 0 : Math.max(0, Math.ceil(ms / 1000));
}

/** 文字の進捗バー（[███████░░░]）。 */
export function progressBar(value: number, total: number, width = 10): string {
  const filled = total <= 0 ? 0 : Math.min(width, Math.max(0, Math.round((value / total) * width)));
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

export type ActionKind =
  | "start"
  | "stop"
  | "restart"
  | "switch_to_sub"
  | "back_to_main"
  | "show_log";
export type Action = { kind: ActionKind; disabled: boolean };

export type ActionContext = {
  /** 正と副（launcher.jsonのfailover） */
  from: string;
  to: string;
  /** いまの別名（HealthWatcher） */
  alias: "main" | "sub";
  /** 切り替え中 */
  switching: boolean;
};

const act = (kind: ActionKind, disabled = false): Action => ({ kind, disabled });

/** サービスの行のボタン（S03a〜S03d）。 */
export function serviceActions(view: ServiceView, ctx: ActionContext): Action[] {
  const isFrom = view.id === ctx.from;
  const isTo = view.id === ctx.to;
  if (isFrom && ctx.alias === "sub") return [act("show_log"), act("back_to_main", ctx.switching)];
  if (isTo && (view.state === "standby" || view.state === "loading")) return [];
  switch (view.state) {
    case "running":
      if (isFrom) return [act("stop"), act("restart"), act("switch_to_sub", ctx.switching)];
      if (isTo) return [act("restart")];
      return [act("stop"), act("restart")];
    case "loading":
      return [act("stop")];
    case "waiting":
      return [act("start", true)];
    case "failed":
    case "down":
      return [act("show_log"), act("start")];
    case "stopped":
      return [act("start")];
    case "standby":
      return [];
  }
}

/** ［すべて起動］を押せるか：止まっている・失敗したサービスがある（副に切り替えた正は除く）。 */
export function canStartAll(views: ServiceView[], ctx: ActionContext): boolean {
  return views.some(
    (v) =>
      !v.standby &&
      (v.state === "stopped" || v.state === "failed") &&
      !(v.id === ctx.from && ctx.alias === "sub"),
  );
}
