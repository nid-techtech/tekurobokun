import { describe, expect, test } from "bun:test";
import type { Health, StatusMessage } from "@tekurobokun/protocol";
import { InputSourceRegistry } from "./input_sources.ts";
import { type KeyInput, OperatorConsole } from "./operator.ts";
import { StubAvailability } from "./stub_availability.ts";

function setup(options: { stub?: boolean } = {}) {
  const sources = new InputSourceRegistry(["tablet", "phone"], "tablet");
  const health: Health = { backend: true, llm: true, tts: true, stt: true, robot: false };
  const lines: string[] = [];
  let quits = 0;
  let rechecks = 0;
  const availability = new StubAvailability();
  const operator = new OperatorConsole({
    sources,
    status: (): StatusMessage => ({
      type: "status",
      session: "idle",
      inputSource: sources.active(),
      micPaused: sources.micPaused(),
      health: { ...health },
    }),
    stub: options.stub
      ? {
          availability,
          recheck: async () => {
            rechecks++;
          },
        }
      : undefined,
    write: (line) => lines.push(line),
    quit: () => {
      quits++;
    },
  });
  // index.tsと同じく、切り替わったら状態を出す
  sources.onChange(() => operator.showStatus());
  return {
    operator,
    sources,
    health,
    lines,
    availability,
    quits: () => quits,
    rechecks: () => rechecks,
  };
}

describe("OperatorConsole", () => {
  test("状態の1行に、入力元・入力元の一覧・マイク・会話の状態・応答の有無が入る", () => {
    const { operator, health, sources } = setup();
    expect(operator.statusLine()).toBe(
      "[operator] input=tablet [1:robot 2:tablet* 3:phone] mic=on session=idle llm=up tts=up stt=up robot=disconnected",
    );
    health.llm = false;
    health.stt = false;
    health.robot = true;
    sources.setMicPaused(true);
    expect(operator.statusLine()).toContain("mic=paused");
    expect(operator.statusLine()).toContain("llm=DOWN tts=up stt=DOWN robot=connected");
  });

  test("数字キーで入力元の一覧の順（1がrobot）に切り替え、状態を出す", () => {
    const { operator, sources, lines } = setup();
    operator.handleKey("3");
    expect(sources.active()).toBe("phone");
    expect(lines.at(-1)).toContain("input=phone [1:robot 2:tablet 3:phone*]");
    operator.handleKey("1");
    expect(sources.active()).toBe("robot");
    expect(lines).toHaveLength(2);
  });

  test("いま有効な入力元の番号でも状態を出す。一覧にない番号は切り替えない", () => {
    const { operator, sources, lines } = setup();
    operator.handleKey("2");
    expect(lines).toHaveLength(1);
    operator.handleKey("4");
    expect(sources.active()).toBe("tablet");
    expect(lines.at(-1)).toBe("[operator] no input source for key 4");
    operator.handleKey("0");
    expect(lines).toHaveLength(2);
  });

  test("mでマイクを一時停止・再開し、状態を出す", () => {
    const { operator, sources, lines } = setup();
    operator.handleKey("m");
    expect(sources.micPaused()).toBe(true);
    expect(lines.at(-1)).toContain("mic=paused");
    operator.handleKey("M");
    expect(sources.micPaused()).toBe(false);
    expect(lines.at(-1)).toContain("mic=on");
  });

  test("s・Enterで状態、h・?で説明、Ctrl+Cで終える", () => {
    const { operator, lines, quits } = setup();
    operator.handleKey("s");
    operator.handleKey("\r");
    expect(lines.filter((l) => l.startsWith("[operator] input="))).toHaveLength(2);
    operator.handleKey("h");
    expect(lines.at(-1)).toContain("1-3 switch input source, m pause/resume mic");
    operator.handleKey("\u0003");
    expect(quits()).toBe(1);
  });

  test("スタブのときだけ、l・t・rでLLM・VOICEVOX・STTを止め・戻し、問い合わせ直す", () => {
    const real = setup();
    real.operator.handleKey("l");
    expect(real.lines).toHaveLength(0);
    expect(real.availability.isUp("llm")).toBe(true);
    expect(real.operator.helpLines()).toHaveLength(1);

    const stub = setup({ stub: true });
    stub.operator.handleKey("l");
    expect(stub.availability.isUp("llm")).toBe(false);
    expect(stub.lines.at(-1)).toBe("[operator] stub llm stopped");
    stub.operator.handleKey("T");
    expect(stub.availability.isUp("tts")).toBe(false);
    stub.operator.handleKey("r");
    expect(stub.availability.isUp("stt")).toBe(false);
    expect(stub.lines.at(-1)).toBe("[operator] stub stt stopped");
    stub.operator.handleKey("l");
    expect(stub.availability.isUp("llm")).toBe(true);
    expect(stub.rechecks()).toBe(4);
    expect(stub.operator.helpLines()).toHaveLength(2);
  });

  test("pで登録コードを発行し、残り時間とQRの中身を出す（発行の関数があるときだけ）", () => {
    const lines: string[] = [];
    const now = new Date("2026-11-20T01:00:00Z");
    const make = (issue?: () => { code: string; expiresAt: Date; qr: string }) =>
      new OperatorConsole({
        sources: new InputSourceRegistry(["tablet"], "robot"),
        status: () => ({
          type: "status",
          session: "idle",
          inputSource: "robot",
          micPaused: false,
          health: { backend: true, llm: true, tts: true, stt: true, robot: false },
        }),
        issuePairingCode: issue,
        write: (line) => lines.push(line),
        quit: () => {},
        now: () => now,
      });
    make().handleKey("p");
    expect(lines).toEqual([]);

    const operator = make(() => ({
      code: "ABCD-EFGH",
      expiresAt: new Date(now.getTime() + 60_000),
      qr: "http://x/pair#ABCD-EFGH",
    }));
    expect(operator.helpLines()[0]).toContain("p pairing code");
    operator.handleKey("P");
    expect(lines).toEqual([
      "[operator] pairing code ABCD-EFGH (expires in 60s) qr=http://x/pair#ABCD-EFGH",
    ]);
  });

  test("TTYでなければキー入力を受け取らない。TTYなら生のモードで1文字ずつ処理する", () => {
    const { operator, sources } = setup();
    const notTty: KeyInput = {
      isTTY: false,
      setEncoding: () => {},
      resume: () => {},
      on: () => {},
    };
    expect(operator.attach(notTty)).toBe(false);

    let raw = false;
    let listener: ((chunk: string) => void) | null = null;
    const tty: KeyInput = {
      isTTY: true,
      setRawMode: (mode) => {
        raw = mode;
      },
      setEncoding: () => {},
      resume: () => {},
      on: (_event, fn) => {
        listener = fn;
      },
    };
    expect(operator.attach(tty)).toBe(true);
    expect(raw).toBe(true);
    (listener as ((chunk: string) => void) | null)?.("32");
    expect(sources.active()).toBe("tablet");
  });
});
