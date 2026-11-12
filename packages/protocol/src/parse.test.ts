import { describe, expect, test } from "bun:test";
import { parseClientMessage, parseServerMessage } from "./parse.ts";
import type {
  ClientMessage,
  ConsoleSettings,
  Health,
  Reply,
  ServerMessage,
  Turn,
} from "./types.ts";

const j = (v: unknown) => JSON.stringify(v);

const turn: Turn = {
  id: "t1",
  at: "2026-11-14T10:00:00+09:00",
  device: "tablet",
  text: "こんにちは",
};
const reply: Reply = { say: "やあ。", emotion: "happy", thinkingMs: 1234 };
const settings: ConsoleSettings = {
  autosendMs: 3000,
  fontSizePx: 20,
  bottomInsetPx: 12,
  prompt: { user: "guest", host: "tekurobokun", dir: "~" },
};
const health: Health = { backend: true, llm: true, tts: false, robot: true };

describe("parseClientMessage", () => {
  const valid: ClientMessage[] = [
    { type: "hello", role: "console", device: "tablet" },
    { type: "hello", role: "robot" },
    { type: "utterance", text: "こんにちは" },
    { type: "utterance", text: "" },
    { type: "playback_done", turnId: "t1", index: 0 },
  ];
  test.each(valid)("正しい形を受け付ける: %o", (msg) => {
    expect(parseClientMessage(j(msg))).toEqual(msg);
  });

  test("余分な項目は落とす", () => {
    expect(parseClientMessage(j({ type: "hello", role: "robot", device: "x", extra: 1 }))).toEqual({
      type: "hello",
      role: "robot",
    });
  });

  const invalid: [string, string][] = [
    ["JSONでない", "{"],
    ["空文字列", ""],
    ["配列", j([])],
    ["null", "null"],
    ["文字列", j("hello")],
    ["typeがない", j({ text: "a" })],
    ["未知のtype", j({ type: "speech", text: "a" })],
    ["roleが未知", j({ type: "hello", role: "admin" })],
    ["consoleでdeviceがない", j({ type: "hello", role: "console" })],
    ["deviceが数値", j({ type: "hello", role: "console", device: 1 })],
    ["textがない", j({ type: "utterance" })],
    ["textがnull", j({ type: "utterance", text: null })],
    ["indexが負", j({ type: "playback_done", turnId: "t1", index: -1 })],
    ["indexが小数", j({ type: "playback_done", turnId: "t1", index: 0.5 })],
    ["indexが文字列", j({ type: "playback_done", turnId: "t1", index: "0" })],
    ["turnIdがない", j({ type: "playback_done", index: 0 })],
  ];
  test.each(invalid)("崩れた形は null: %s", (_, raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });
});

describe("parseServerMessage", () => {
  const valid: ServerMessage[] = [
    { type: "welcome", settings, history: [] },
    { type: "welcome", settings, history: [turn, { ...turn, id: "t2", reply }] },
    { type: "status", session: "idle", activeDevice: "tablet", health },
    { type: "status", session: "thinking", activeDevice: "", health },
    { type: "status", session: "speaking", activeDevice: "phone", health },
    { type: "turn_started", turn },
    { type: "turn_replied", turnId: "t1", ...reply },
    {
      type: "speech",
      turnId: "t1",
      index: 2,
      last: true,
      text: "やあ。",
      emotion: "curious",
      wav: "UklGRg==",
    },
  ];
  test.each(valid)("正しい形を受け付ける: %o", (msg) => {
    expect(parseServerMessage(j(msg))).toEqual(msg);
  });

  test("感情はすべて受け付ける", () => {
    for (const emotion of ["neutral", "happy", "surprised", "curious", "troubled"]) {
      expect(
        parseServerMessage(j({ type: "turn_replied", turnId: "t1", ...reply, emotion })),
      ).not.toBeNull();
    }
  });

  test("ネストした余分な項目も落とす", () => {
    const parsed = parseServerMessage(
      j({
        type: "turn_started",
        turn: { ...turn, secret: 1, reply: { ...reply, raw: "x" } },
        extra: 1,
      }),
    );
    expect(parsed).toEqual({ type: "turn_started", turn: { ...turn, reply } });
  });

  const invalid: [string, unknown][] = [
    ["クライアント向けのtype", { type: "utterance", text: "a" }],
    ["settingsがない", { type: "welcome", history: [] }],
    [
      "promptが欠ける",
      { type: "welcome", settings: { ...settings, prompt: { user: "a" } }, history: [] },
    ],
    ["autosendMsが負", { type: "welcome", settings: { ...settings, autosendMs: -1 }, history: [] }],
    [
      "bottomInsetPxがない",
      { type: "welcome", settings: { ...settings, bottomInsetPx: undefined }, history: [] },
    ],
    [
      "bottomInsetPxが負",
      { type: "welcome", settings: { ...settings, bottomInsetPx: -1 }, history: [] },
    ],
    ["historyが配列でない", { type: "welcome", settings, history: {} }],
    ["historyに崩れた要素", { type: "welcome", settings, history: [turn, { id: "t2" }] }],
    ["sessionが未知", { type: "status", session: "sleep", activeDevice: "a", health }],
    [
      "health.backendがfalse",
      { type: "status", session: "idle", activeDevice: "a", health: { ...health, backend: false } },
    ],
    [
      "health.llmがない",
      {
        type: "status",
        session: "idle",
        activeDevice: "a",
        health: { backend: true, tts: true, robot: true },
      },
    ],
    ["activeDeviceがない", { type: "status", session: "idle", health }],
    ["turnのtextがない", { type: "turn_started", turn: { id: "t1", at: "x", device: "a" } }],
    ["turnのreplyが崩れている", { type: "turn_started", turn: { ...turn, reply: { say: "a" } } }],
    ["turnのreplyがnull", { type: "turn_started", turn: { ...turn, reply: null } }],
    ["emotionが未知", { type: "turn_replied", turnId: "t1", ...reply, emotion: "angry" }],
    ["thinkingMsが文字列", { type: "turn_replied", turnId: "t1", ...reply, thinkingMs: "1" }],
    ["thinkingMsがnull", { type: "turn_replied", turnId: "t1", ...reply, thinkingMs: null }],
    ["turnIdがない", { type: "turn_replied", ...reply }],
    [
      "speechのlastがない",
      { type: "speech", turnId: "t1", index: 0, text: "a", emotion: "happy", wav: "" },
    ],
    [
      "speechのwavが数値",
      { type: "speech", turnId: "t1", index: 0, last: false, text: "a", emotion: "happy", wav: 1 },
    ],
    [
      "speechのindexが負",
      {
        type: "speech",
        turnId: "t1",
        index: -1,
        last: false,
        text: "a",
        emotion: "happy",
        wav: "",
      },
    ],
  ];
  test.each(invalid)("崩れた形は null: %s", (_, msg) => {
    expect(parseServerMessage(j(msg))).toBeNull();
  });

  test("JSONでなければ null", () => {
    expect(parseServerMessage("not json")).toBeNull();
  });
});
