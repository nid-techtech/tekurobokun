import { describe, expect, test } from "bun:test";
import { AudioSlotRegistry } from "./AudioSlotRegistry";

const SLOTS = {
  "1": { filePath: "a.mp3", caption: "あ" },
  "5": { filePath: "b.mp3", caption: "い" },
  "0": { filePath: "c.mp3", caption: "う" },
};

describe("AudioSlotRegistry", () => {
  test("登録済みスロットはファイルパス・キャプションを解決できる", () => {
    const registry = new AudioSlotRegistry(SLOTS);
    expect(registry.resolve("1")).toEqual({ filePath: "a.mp3", caption: "あ" });
    expect(registry.resolve("5")).toEqual({ filePath: "b.mp3", caption: "い" });
    expect(registry.resolve("0")).toEqual({ filePath: "c.mp3", caption: "う" });
  });

  test("未登録スロットはEMPTYを返す", () => {
    const registry = new AudioSlotRegistry(SLOTS);
    for (const key of ["2", "3", "4", "6", "7", "8", "9"]) {
      expect(registry.resolve(key)).toBe("EMPTY");
    }
  });

  test("範囲外のキーもEMPTYを返す", () => {
    const registry = new AudioSlotRegistry(SLOTS);
    expect(registry.resolve("x")).toBe("EMPTY");
  });
});
