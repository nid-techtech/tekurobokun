import { describe, expect, test } from "bun:test";
import {
  parseAdminEvent,
  parseAdminStatus,
  parseClientMessage,
  parseInputSourceRequest,
  parseLlmModelRequest,
  parseMicRequest,
  parsePairingCode,
  parseServerMessage,
} from "./parse.ts";
import type {
  AdminEvent,
  AdminStatus,
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
  source: "tablet",
  via: "text",
  text: "こんにちは",
};
const reply: Reply = { say: "やあ。", emotion: "happy", thinkingMs: 1234 };
const settings: ConsoleSettings = {
  autosendMs: 3000,
  fontSizePx: 20,
  bottomInsetPx: 12,
  prompt: { user: "guest", host: "tekurobokun", dir: "~" },
  idleResetMs: 90000,
};
const health: Health = { backend: true, llm: true, tts: false, stt: true, robot: true };
const status = { type: "status", session: "idle", inputSource: "tablet", micPaused: false, health };

describe("parseClientMessage", () => {
  const valid: ClientMessage[] = [
    { type: "hello", role: "console", device: "tablet", token: null },
    { type: "hello", role: "console", device: "tablet", token: "abc" },
    { type: "hello", role: "robot", token: null },
    { type: "hello", role: "robot", token: "abc" },
    { type: "pair", role: "console", device: "phone", code: "ABCD-EFGH" },
    { type: "pair", role: "robot", code: "abcdefgh" },
    { type: "utterance", text: "こんにちは" },
    { type: "utterance", text: "" },
    { type: "playback_done", turnId: "t1", index: 0 },
    { type: "listening", active: true },
    { type: "listening", active: false },
    { type: "voice", wav: "UklGRg==", durationMs: 1500 },
  ];
  test.each(valid)("正しい形を受け付ける: %o", (msg) => {
    expect(parseClientMessage(j(msg))).toEqual(msg);
  });

  test("余分な項目は落とす", () => {
    expect(
      parseClientMessage(j({ type: "hello", role: "robot", token: null, device: "x", extra: 1 })),
    ).toEqual({ type: "hello", role: "robot", token: null });
  });

  const invalid: [string, string][] = [
    ["JSONでない", "{"],
    ["空文字列", ""],
    ["配列", j([])],
    ["null", "null"],
    ["文字列", j("hello")],
    ["typeがない", j({ text: "a" })],
    ["未知のtype", j({ type: "speech", text: "a" })],
    ["roleが未知", j({ type: "hello", role: "admin", token: null })],
    ["helloにtokenがない", j({ type: "hello", role: "robot" })],
    ["tokenが数値", j({ type: "hello", role: "robot", token: 1 })],
    ["consoleでdeviceがない", j({ type: "hello", role: "console", token: null })],
    ["deviceが数値", j({ type: "hello", role: "console", device: 1, token: null })],
    ["pairのcodeがない", j({ type: "pair", role: "robot" })],
    ["pairのroleが未知", j({ type: "pair", role: "admin", code: "ABCD-EFGH" })],
    ["pairのdeviceが数値", j({ type: "pair", role: "console", device: 1, code: "ABCD-EFGH" })],
    ["textがない", j({ type: "utterance" })],
    ["textがnull", j({ type: "utterance", text: null })],
    ["indexが負", j({ type: "playback_done", turnId: "t1", index: -1 })],
    ["indexが小数", j({ type: "playback_done", turnId: "t1", index: 0.5 })],
    ["indexが文字列", j({ type: "playback_done", turnId: "t1", index: "0" })],
    ["turnIdがない", j({ type: "playback_done", index: 0 })],
    ["listeningのactiveがない", j({ type: "listening" })],
    ["voiceのwavがない", j({ type: "voice", durationMs: 1 })],
    ["voiceのdurationMsが負", j({ type: "voice", wav: "", durationMs: -1 })],
  ];
  test.each(invalid)("崩れた形は null: %s", (_, raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });
});

describe("parseServerMessage", () => {
  const valid: ServerMessage[] = [
    { type: "welcome", settings, history: [] },
    { type: "welcome", settings, history: [turn, { ...turn, id: "t2", reply }] },
    { type: "status", session: "idle", inputSource: "tablet", micPaused: false, health },
    { type: "status", session: "listening", inputSource: "robot", micPaused: true, health },
    { type: "status", session: "thinking", inputSource: "", micPaused: false, health },
    { type: "status", session: "searching", inputSource: "robot", micPaused: false, health },
    { type: "status", session: "speaking", inputSource: "phone", micPaused: false, health },
    { type: "turn_started", turn },
    { type: "turn_started", turn: { ...turn, source: "robot", via: "mic" } },
    {
      type: "turn_started",
      turn: {
        ...turn,
        search: { query: "東京タワー 高さ", preSay: "調べるね。", searchMs: null, ok: null },
      },
    },
    { type: "turn_replied", turnId: "t1", ...reply },
    {
      type: "turn_search_started",
      turnId: "t1",
      query: "東京タワー 高さ",
      preSay: "調べるね。",
      emotion: "curious",
      thinkingMs: 800,
    },
    { type: "turn_search_done", turnId: "t1", searchMs: 1204, ok: true },
    { type: "history_cleared", at: "2026-11-14T10:00:00+09:00", reason: "idle" },
    { type: "history_cleared", at: "2026-11-14T10:00:00+09:00", reason: "manual" },
    {
      type: "speech",
      turnId: "t1",
      index: 2,
      last: true,
      text: "やあ。",
      emotion: "curious",
      wav: "UklGRg==",
    },
    { type: "auth_required", reason: "missing" },
    { type: "auth_required", reason: "invalid" },
    { type: "auth_required", reason: "revoked" },
    { type: "paired", token: "abc" },
    { type: "pair_failed", reason: "invalid" },
    { type: "pair_failed", reason: "expired" },
    { type: "pair_failed", reason: "rate_limited" },
    { type: "pair_failed", reason: "unknown_device" },
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
    ["sessionが未知", { ...status, session: "sleep" }],
    ["health.backendがfalse", { ...status, health: { ...health, backend: false } }],
    [
      "health.llmがない",
      { ...status, health: { backend: true, tts: true, stt: true, robot: true } },
    ],
    [
      "health.sttがない",
      { ...status, health: { backend: true, llm: true, tts: true, robot: true } },
    ],
    ["inputSourceがない", { ...status, inputSource: undefined }],
    ["micPausedがない", { ...status, micPaused: undefined }],
    ["v5のactiveDeviceだけ", { type: "status", session: "idle", activeDevice: "a", health }],
    ["turnのtextがない", { type: "turn_started", turn: { ...turn, text: undefined } }],
    [
      "turnのsourceがない(v5のdevice)",
      { type: "turn_started", turn: { id: "t1", at: "x", device: "a", via: "text", text: "a" } },
    ],
    ["turnのviaが未知", { type: "turn_started", turn: { ...turn, via: "voice" } }],
    ["turnのreplyが崩れている", { type: "turn_started", turn: { ...turn, reply: { say: "a" } } }],
    ["turnのreplyがnull", { type: "turn_started", turn: { ...turn, reply: null } }],
    [
      "turnのsearchが崩れている",
      { type: "turn_started", turn: { ...turn, search: { query: "a", preSay: "b" } } },
    ],
    ["emotionが未知", { type: "turn_replied", turnId: "t1", ...reply, emotion: "angry" }],
    ["thinkingMsが文字列", { type: "turn_replied", turnId: "t1", ...reply, thinkingMs: "1" }],
    ["thinkingMsがnull", { type: "turn_replied", turnId: "t1", ...reply, thinkingMs: null }],
    ["turnIdがない", { type: "turn_replied", ...reply }],
    [
      "turn_search_startedのqueryがない",
      { type: "turn_search_started", turnId: "t1", preSay: "a", emotion: "happy", thinkingMs: 1 },
    ],
    ["turn_search_doneのokがない", { type: "turn_search_done", turnId: "t1", searchMs: 1 }],
    ["history_clearedのreasonが未知", { type: "history_cleared", at: "x", reason: "auto" }],
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
    ["auth_requiredのreasonが未知", { type: "auth_required", reason: "expired" }],
    ["pairedのtokenが空", { type: "paired", token: "" }],
    ["pair_failedのreasonがない", { type: "pair_failed" }],
  ];
  test.each(invalid)("崩れた形は null: %s", (_, msg) => {
    expect(parseServerMessage(j(msg))).toBeNull();
  });

  test("JSONでなければ null", () => {
    expect(parseServerMessage("not json")).toBeNull();
  });
});

describe("管理用API", () => {
  const adminStatus: AdminStatus = {
    session: "idle",
    inputSource: "robot",
    micPaused: false,
    health,
    llmModel: "main",
    searchCount: { month: "2026-11", count: 12 },
    devices: [
      {
        id: "d1",
        role: "robot",
        name: "robot",
        registeredAt: "2026-11-20T10:00:00+09:00",
        connected: true,
      },
    ],
    publicUrl: "https://example.test",
  };

  test("statusの応答", () => {
    expect(parseAdminStatus(j(adminStatus))).toEqual(adminStatus);
    expect(parseAdminStatus(adminStatus)).toEqual(adminStatus);
    expect(parseAdminStatus({ ...adminStatus, llmModel: "third" })).toBeNull();
    expect(parseAdminStatus({ ...adminStatus, devices: [{ id: "d1" }] })).toBeNull();
    expect(parseAdminStatus({ ...adminStatus, searchCount: { month: "2026-11" } })).toBeNull();
  });

  test("登録コードの応答", () => {
    const code = {
      code: "ABCD-EFGH",
      expiresAt: "2026-11-20T10:01:00+09:00",
      qr: "https://example.test/pair#ABCD-EFGH",
    };
    expect(parsePairingCode(j(code))).toEqual(code);
    expect(parsePairingCode({ ...code, qr: undefined })).toBeNull();
  });

  test("できごと", () => {
    const events: AdminEvent[] = [
      { type: "status", ...adminStatus },
      { type: "event", at: "2026-11-20T10:00:00+09:00", kind: "paired", detail: "robot" },
      { type: "event", at: "2026-11-20T10:00:00+09:00", kind: "llm_timeout", detail: "" },
    ];
    for (const e of events) expect(parseAdminEvent(j(e))).toEqual(e);
    expect(parseAdminEvent(j({ type: "event", at: "x", kind: "boom", detail: "" }))).toBeNull();
    expect(parseAdminEvent(j({ type: "other" }))).toBeNull();
  });

  test("要求の本文", () => {
    expect(parseInputSourceRequest(j({ source: "phone" }))).toEqual({ source: "phone" });
    expect(parseInputSourceRequest(j({ source: "" }))).toBeNull();
    expect(parseMicRequest(j({ paused: true }))).toEqual({ paused: true });
    expect(parseMicRequest(j({ paused: "yes" }))).toBeNull();
    expect(parseLlmModelRequest(j({ alias: "sub" }))).toEqual({ alias: "sub" });
    expect(parseLlmModelRequest(j({ alias: "x" }))).toBeNull();
    expect(parseMicRequest("not json")).toBeNull();
  });
});
