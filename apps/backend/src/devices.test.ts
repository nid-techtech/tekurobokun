import { describe, expect, mock, test } from "bun:test";
import { InputDeviceRegistry } from "./devices.ts";

describe("InputDeviceRegistry", () => {
  test("起動時に有効な端末だけを受け付ける", () => {
    const registry = new InputDeviceRegistry(["tablet", "phone"], "tablet");
    expect(registry.active()).toBe("tablet");
    expect(registry.isActive("tablet")).toBe(true);
    expect(registry.isActive("phone")).toBe(false);
    expect(registry.isActive("unknown")).toBe(false);
  });

  test("一覧にない端末は有効にできない", () => {
    const registry = new InputDeviceRegistry(["tablet", "phone"], "tablet");
    expect(registry.setActive("laptop")).toBe(false);
    expect(registry.active()).toBe("tablet");
  });

  test("番号（1始まり）で切り替え、変わったときだけ知らせる", () => {
    const registry = new InputDeviceRegistry(["tablet", "phone"], "tablet");
    const listener = mock((_: string) => {});
    registry.onChange(listener);
    expect(registry.setActiveByNumber(2)).toBe(true);
    expect(registry.active()).toBe("phone");
    expect(registry.setActiveByNumber(2)).toBe(true);
    expect(registry.setActiveByNumber(3)).toBe(false);
    expect(registry.setActiveByNumber(0)).toBe(false);
    expect(listener.mock.calls).toEqual([["phone"]]);
  });

  test("有効な端末が一覧になければ先頭、一覧が空ならどれも有効にしない", () => {
    expect(new InputDeviceRegistry(["a", "b"], "x").active()).toBe("a");
    const empty = new InputDeviceRegistry([], "x");
    expect(empty.active()).toBe("");
    expect(empty.isActive("")).toBe(false);
  });
});
