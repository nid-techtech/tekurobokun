import { describe, expect, test } from "bun:test";
import { formatClock, formatDuration, textBar } from "./format.ts";

describe("formatDuration", () => {
  test("秒とミリ秒で表す", () => {
    expect(formatDuration(12708)).toBe("12s708ms");
    expect(formatDuration(3850)).toBe("3s850ms");
    expect(formatDuration(999)).toBe("0s999ms");
  });

  test("小数は丸め、負の値は0にする", () => {
    expect(formatDuration(1500.6)).toBe("1s501ms");
    expect(formatDuration(-5)).toBe("0s0ms");
  });

  test("桁区切りを入れない", () => {
    expect(formatDuration(1234567)).toBe("1234s567ms");
  });
});

describe("formatClock", () => {
  test("時:分:秒の24時間制", () => {
    expect(formatClock(new Date(2026, 10, 14, 14, 2, 11))).toBe("14:02:11");
    expect(formatClock(new Date(2026, 10, 14, 0, 5, 9))).toBe("00:05:09");
  });
});

describe("textBar", () => {
  test("10マスで割合を表す", () => {
    expect(textBar(0)).toBe("[░░░░░░░░░░]");
    expect(textBar(0.2)).toBe("[██░░░░░░░░]");
    expect(textBar(1)).toBe("[██████████]");
  });

  test("範囲外は端にそろえる", () => {
    expect(textBar(-1)).toBe("[░░░░░░░░░░]");
    expect(textBar(2)).toBe("[██████████]");
  });
});
