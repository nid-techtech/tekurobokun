import { describe, expect, test } from "bun:test";
import type { Health } from "@tekurobokun/protocol";
import { type NoticeInput, noticeFor } from "./notice.ts";

const health = (h: Partial<Health> = {}): Health => ({
  backend: true,
  llm: true,
  tts: true,
  robot: true,
  ...h,
});

const input = (over: Partial<NoticeInput> = {}): NoticeInput => ({
  connected: true,
  welcomed: true,
  status: { activeDevice: "tablet", health: health() },
  device: "tablet",
  ...over,
});

describe("noticeFor", () => {
  test("つながっていて、自分が有効で、LLM・VOICEVOXが応答していれば案内を出さない", () => {
    expect(noticeFor(input())).toBeNull();
    // 機体がいなくても、入力ページは使える
    expect(
      noticeFor(input({ status: { activeDevice: "tablet", health: health({ robot: false }) } })),
    ).toBeNull();
  });

  test("切断中・welcomeやstatusがまだ届かないときはS01f", () => {
    expect(noticeFor(input({ connected: false }))).toBe("offline");
    expect(noticeFor(input({ welcomed: false }))).toBe("offline");
    expect(noticeFor(input({ status: null }))).toBe("offline");
  });

  test("LLM・VOICEVOXのどちらかが応答しないときもS01f（別の端末が有効でも、こちらを優先）", () => {
    for (const h of [{ llm: false }, { tts: false }]) {
      expect(noticeFor(input({ status: { activeDevice: "tablet", health: health(h) } }))).toBe(
        "offline",
      );
      expect(noticeFor(input({ status: { activeDevice: "phone", health: health(h) } }))).toBe(
        "offline",
      );
    }
  });

  test("別の端末が有効ならS01g、自分に切り替われば戻る", () => {
    expect(noticeFor(input({ status: { activeDevice: "phone", health: health() } }))).toBe(
      "inactive",
    );
    expect(
      noticeFor(input({ device: "phone", status: { activeDevice: "phone", health: health() } })),
    ).toBeNull();
  });
});
