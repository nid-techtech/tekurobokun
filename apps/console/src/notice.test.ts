import { describe, expect, test } from "bun:test";
import type { Health } from "@tekurobokun/protocol";
import { isViewOnly, type NoticeInput, noticeFor } from "./notice.ts";

const health = (h: Partial<Health> = {}): Health => ({
  backend: true,
  llm: true,
  tts: true,
  stt: true,
  robot: true,
  ...h,
});

const input = (over: Partial<NoticeInput> = {}): NoticeInput => ({
  connected: true,
  welcomed: true,
  status: { inputSource: "tablet", health: health() },
  device: "tablet",
  ...over,
});

describe("noticeFor", () => {
  test("つながっていて、自分が有効で、LLM・VOICEVOXが応答していれば案内を出さない", () => {
    expect(noticeFor(input())).toBeNull();
    // 機体がいなくても、入力ページは使える
    expect(
      noticeFor(input({ status: { inputSource: "tablet", health: health({ robot: false }) } })),
    ).toBeNull();
  });

  test("切断中・welcomeやstatusがまだ届かないときはS01f", () => {
    expect(noticeFor(input({ connected: false }))).toBe("offline");
    expect(noticeFor(input({ welcomed: false }))).toBe("offline");
    expect(noticeFor(input({ status: null }))).toBe("offline");
  });

  test("LLM・VOICEVOXのどちらかが応答しないときもS01f（別の端末が有効でも、こちらを優先）", () => {
    for (const h of [{ llm: false }, { tts: false }]) {
      expect(noticeFor(input({ status: { inputSource: "tablet", health: health(h) } }))).toBe(
        "offline",
      );
      expect(noticeFor(input({ status: { inputSource: "phone", health: health(h) } }))).toBe(
        "offline",
      );
    }
  });

  test("入力元が機体のマイクなら案内を出さず（S01h）、STTが応答しないときだけS01f", () => {
    const robot = (h: Partial<Health> = {}) =>
      input({ status: { inputSource: "robot", health: health(h) } });
    expect(noticeFor(robot())).toBeNull();
    expect(noticeFor(robot({ stt: false }))).toBe("offline");
    expect(noticeFor(robot({ llm: false }))).toBe("offline");
    // consoleが入力元なら、STTが落ちていても使える
    expect(
      noticeFor(input({ status: { inputSource: "tablet", health: health({ stt: false }) } })),
    ).toBeNull();
    expect(isViewOnly({ inputSource: "robot" })).toBe(true);
    expect(isViewOnly({ inputSource: "tablet" })).toBe(false);
    expect(isViewOnly(null)).toBe(false);
  });

  test("別の端末が有効ならS01g、自分に切り替われば戻る", () => {
    expect(noticeFor(input({ status: { inputSource: "phone", health: health() } }))).toBe(
      "inactive",
    );
    expect(
      noticeFor(input({ device: "phone", status: { inputSource: "phone", health: health() } })),
    ).toBeNull();
  });
});
