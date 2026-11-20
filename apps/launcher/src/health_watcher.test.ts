import { describe, expect, test } from "bun:test";
import type { LlmAlias } from "@tekurobokun/protocol";
import { HealthWatcher, type WatchLog } from "./health_watcher.ts";

function setup(
  options: { probe?: boolean[]; switchFails?: boolean; setModelFails?: boolean } = {},
) {
  const probes = [...(options.probe ?? [])];
  const calls: string[] = [];
  const logs: WatchLog[] = [];
  const models: LlmAlias[] = [];
  const watcher = new HealthWatcher(
    {
      probe: async () => probes.shift() ?? true,
      switchToSub: async (mark) => {
        calls.push(`sub:${mark}`);
        if (options.switchFails) throw new Error("port 8080 was not released");
      },
      switchToMain: async () => {
        calls.push("main");
      },
      setModel: async (alias) => {
        if (options.setModelFails) throw new Error("connection refused");
        models.push(alias);
      },
      now: () => new Date("2026-11-21T15:41:07+09:00"),
      log: (entry) => logs.push(entry),
      onChange: () => {},
    },
    3,
  );
  watcher.setMainState("running", null);
  return { watcher, calls, logs, models };
}

describe("HealthWatcher", () => {
  test("ハートビートが3回続けて失敗したら、正を応答なしにして副に切り替え、subを伝える", async () => {
    const { watcher, calls, logs, models } = setup({ probe: [false, false, false] });
    await watcher.heartbeat();
    await watcher.heartbeat();
    expect(calls).toEqual([]);
    await watcher.heartbeat();
    expect(calls).toEqual(["sub:down"]);
    expect(models).toEqual(["sub"]);
    expect(watcher.alias).toBe("sub");
    expect(watcher.failoverAt?.toISOString()).toBe("2026-11-21T06:41:07.000Z");
    expect(logs).toEqual([
      { kind: "heartbeat_fail", n: 1, max: 3 },
      { kind: "heartbeat_fail", n: 2, max: 3 },
      { kind: "heartbeat_fail", n: 3, max: 3 },
      { kind: "switched" },
    ]);
  });

  test("途中で成功したら数え直す", async () => {
    const { watcher, calls } = setup({ probe: [false, false, true, false, false] });
    for (let i = 0; i < 5; i++) await watcher.heartbeat();
    expect(calls).toEqual([]);
    expect(watcher.failureCount).toBe(2);
  });

  test("llm_timeoutも失敗として数え、ハートビートの失敗と合わせて3回で切り替える", async () => {
    const { watcher, calls, logs } = setup({ probe: [false] });
    await watcher.onLlmTimeout();
    await watcher.heartbeat();
    await watcher.onLlmTimeout();
    expect(calls).toEqual(["sub:down"]);
    expect(logs.slice(0, 3)).toEqual([
      { kind: "llm_timeout", n: 1, max: 3 },
      { kind: "heartbeat_fail", n: 2, max: 3 },
      { kind: "llm_timeout", n: 3, max: 3 },
    ]);
  });

  test("正が読み込み中・停止中のときは数えない。稼働後に落ちたときは数える", async () => {
    const { watcher, logs } = setup({ probe: [false, false] });
    watcher.setMainState("loading", null);
    await watcher.heartbeat();
    await watcher.onLlmTimeout();
    watcher.setMainState("failed", { kind: "port_in_use", port: 8080 });
    await watcher.heartbeat();
    expect(logs).toEqual([]);
    watcher.setMainState("failed", { kind: "exited", code: 1 });
    await watcher.heartbeat();
    expect(logs).toEqual([{ kind: "heartbeat_fail", n: 1, max: 3 }]);
  });

  test("副に切り替えたあとは数えず、正に戻すのは手動", async () => {
    const { watcher, calls, models, logs } = setup({ probe: [false, false, false, false] });
    for (let i = 0; i < 3; i++) await watcher.heartbeat();
    watcher.setMainState("down", null);
    await watcher.heartbeat();
    await watcher.onLlmTimeout();
    expect(logs.filter((l) => l.kind !== "switched")).toHaveLength(3);
    await watcher.backToMain();
    expect(calls).toEqual(["sub:down", "main"]);
    expect(models).toEqual(["sub", "main"]);
    expect(watcher.alias).toBe("main");
    expect(watcher.failoverAt).toBeNull();
  });

  test("［副に切り替え］は手動の切り替え（正は停止、警告の帯は出さない）", async () => {
    const { watcher, calls } = setup();
    await watcher.switchToSub(true);
    expect(calls).toEqual(["sub:stopped"]);
    expect(watcher.alias).toBe("sub");
    expect(watcher.failoverAt).toBeNull();
  });

  test("切り替えに失敗したら別名を変えずに知らせる", async () => {
    const { watcher, logs, models } = setup({ probe: [false, false, false], switchFails: true });
    for (let i = 0; i < 3; i++) await watcher.heartbeat();
    expect(watcher.alias).toBe("main");
    expect(models).toEqual([]);
    expect(logs.at(-1)).toEqual({ kind: "switch_failed", detail: "port 8080 was not released" });
  });

  test("backendの別名が食い違っていたら伝え直す（backendの再起動）。伝えられなければ知らせる", async () => {
    const { watcher, models } = setup();
    await watcher.switchToSub(true);
    await watcher.onStatus("main");
    await watcher.onStatus("sub");
    expect(models).toEqual(["sub", "sub"]);

    const down = setup({ setModelFails: true });
    await down.watcher.onStatus("sub");
    expect(down.logs).toEqual([{ kind: "admin_failed", detail: "connection refused" }]);
  });

  test("［すべて停止］のあとは正から始め直す", async () => {
    const { watcher } = setup({ probe: [false, false, false] });
    for (let i = 0; i < 3; i++) await watcher.heartbeat();
    expect(watcher.alias).toBe("sub");
    watcher.reset();
    expect(watcher.alias).toBe("main");
    expect(watcher.failoverAt).toBeNull();
  });
});
