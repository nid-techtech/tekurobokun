import { describe, expect, mock, test } from "bun:test";
import { type InputSourceChange, InputSourceRegistry } from "./input_sources.ts";

describe("InputSourceRegistry", () => {
  test("一覧の先頭はrobot、続けて設定のconsole。起動時に有効な入力元だけを受け付ける", () => {
    const registry = new InputSourceRegistry(["tablet", "phone"], "tablet");
    expect(registry.list()).toEqual(["robot", "tablet", "phone"]);
    expect(registry.active()).toBe("tablet");
    expect(registry.isActive("tablet")).toBe(true);
    expect(registry.isActive("robot")).toBe(false);
    expect(registry.isActive("unknown")).toBe(false);
    expect(registry.micPaused()).toBe(false);
  });

  test("有効な入力元が一覧になければrobot", () => {
    expect(new InputSourceRegistry(["tablet"], "laptop").active()).toBe("robot");
    expect(new InputSourceRegistry([], "robot").list()).toEqual(["robot"]);
  });

  test("一覧にない入力元は有効にできない", () => {
    const registry = new InputSourceRegistry(["tablet", "phone"], "robot");
    expect(registry.setActive("laptop")).toBe(false);
    expect(registry.active()).toBe("robot");
  });

  test("番号（1がrobot）で切り替え、変わったときだけ知らせる", () => {
    const registry = new InputSourceRegistry(["tablet", "phone"], "robot");
    const listener = mock((_: InputSourceChange) => {});
    registry.onChange(listener);
    expect(registry.setActiveByNumber(3)).toBe(true);
    expect(registry.active()).toBe("phone");
    expect(registry.setActiveByNumber(3)).toBe(true);
    expect(registry.setActiveByNumber(4)).toBe(false);
    expect(registry.setActiveByNumber(0)).toBe(false);
    expect(registry.setActiveByNumber(1)).toBe(true);
    expect(listener.mock.calls).toEqual([
      [{ kind: "source", source: "phone" }],
      [{ kind: "source", source: "robot" }],
    ]);
  });

  test("マイクの一時停止と再開を、変わったときだけ知らせる", () => {
    const registry = new InputSourceRegistry(["tablet"], "robot");
    const listener = mock((_: InputSourceChange) => {});
    const off = registry.onChange(listener);
    registry.setMicPaused(true);
    registry.setMicPaused(true);
    expect(registry.micPaused()).toBe(true);
    registry.setMicPaused(false);
    off();
    registry.setMicPaused(true);
    expect(listener.mock.calls).toEqual([
      [{ kind: "mic", paused: true }],
      [{ kind: "mic", paused: false }],
    ]);
  });
});
