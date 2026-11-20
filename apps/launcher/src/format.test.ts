import { describe, expect, test } from "bun:test";
import type { AdminStatus } from "@tekurobokun/protocol";
import {
  type ActionContext,
  canStartAll,
  inputSourceOptions,
  progressBar,
  reasonText,
  remainingSeconds,
  serviceActions,
  summaryCounts,
  uptime,
} from "./format.ts";
import type { ServiceView } from "./supervisor.ts";

const view = (id: string, state: ServiceView["state"], standby = false): ServiceView => ({
  id,
  detail: "",
  port: null,
  standby,
  state,
  startedAt: null,
  reason: null,
  logPath: "",
});

const ctx: ActionContext = { from: "llm.main", to: "llm.sub", alias: "main", switching: false };
const kinds = (v: ServiceView, c: ActionContext = ctx) =>
  serviceActions(v, c).map((a) => (a.disabled ? `(${a.kind})` : a.kind));

describe("format", () => {
  test("稼働時間は1時間未満で分秒、それ以上で時分", () => {
    expect(uptime(21_000)).toBe("0m21s");
    expect(uptime(9_500)).toBe("0m09s");
    expect(uptime((2 * 3600 + 13 * 60 + 5) * 1000)).toBe("2h13m");
    expect(uptime((3 * 3600 + 60) * 1000)).toBe("3h01m");
  });

  test("失敗の理由", () => {
    expect(reasonText({ kind: "port_in_use", port: 50021 })).toBe("ポート 50021 が使われています");
    expect(reasonText({ kind: "exited", code: 1 })).toContain("1");
    expect(reasonText({ kind: "timeout", seconds: 180 })).toContain("180");
  });

  test("状態行の数は、稼働中と待機を数える", () => {
    expect(
      summaryCounts([
        view("llm.main", "running"),
        view("llm.sub", "standby", true),
        view("stt", "running"),
      ]),
    ).toEqual({ up: 3, all: 3 });
    expect(summaryCounts([view("llm.main", "down"), view("llm.sub", "running", true)])).toEqual({
      up: 1,
      all: 2,
    });
  });

  test("入力元の選択肢は、機体のマイクと登録済みのconsole", () => {
    const status = {
      inputSource: "tablet",
      devices: [
        { id: "1", role: "robot", name: "robot", registeredAt: "", connected: true },
        { id: "2", role: "console", name: "phone", registeredAt: "", connected: false },
        { id: "3", role: "console", name: "phone", registeredAt: "", connected: true },
      ],
    } as unknown as AdminStatus;
    expect(inputSourceOptions(status)).toEqual(["robot", "phone", "tablet"]);
  });

  test("登録コードの残り時間とバー", () => {
    const now = new Date("2026-11-21T13:02:00+09:00");
    expect(remainingSeconds("2026-11-21T13:02:42+09:00", now)).toBe(42);
    expect(remainingSeconds("2026-11-21T13:01:00+09:00", now)).toBe(0);
    expect(progressBar(42, 60)).toBe("[███████░░░]");
    expect(progressBar(0, 60)).toBe("[░░░░░░░░░░]");
  });
});

describe("サービスの行のボタン", () => {
  test("S03a：正は停止・再起動・副に切り替え、副の待機はなし、ほかは停止・再起動", () => {
    expect(kinds(view("llm.main", "running"))).toEqual(["stop", "restart", "switch_to_sub"]);
    expect(kinds(view("llm.sub", "standby", true))).toEqual([]);
    expect(kinds(view("stt", "running"))).toEqual(["stop", "restart"]);
  });

  test("S03b・S03d：読み込み中は停止、起動待ちは押せない起動、失敗はログと起動", () => {
    expect(kinds(view("llm.main", "loading"))).toEqual(["stop"]);
    expect(kinds(view("stt", "waiting"))).toEqual(["(start)"]);
    expect(kinds(view("tts", "failed"))).toEqual(["show_log", "start"]);
  });

  test("S03c：副に切り替えたあと、正はログと正に戻す、副は再起動", () => {
    const sub: ActionContext = { ...ctx, alias: "sub" };
    expect(kinds(view("llm.main", "down"), sub)).toEqual(["show_log", "back_to_main"]);
    expect(kinds(view("llm.sub", "running", true), sub)).toEqual(["restart"]);
    expect(kinds(view("llm.main", "down"), { ...sub, switching: true })).toEqual([
      "show_log",
      "(back_to_main)",
    ]);
  });

  test("［すべて起動］は、止まっているか失敗したものがあるときだけ", () => {
    const running = [view("llm.main", "running"), view("llm.sub", "standby", true)];
    expect(canStartAll(running, ctx)).toBe(false);
    expect(canStartAll([...running, view("tts", "failed")], ctx)).toBe(true);
    expect(
      canStartAll([view("llm.main", "stopped"), view("llm.sub", "running", true)], {
        ...ctx,
        alias: "sub",
      }),
    ).toBe(false);
  });
});
