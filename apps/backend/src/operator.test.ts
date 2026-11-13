import { describe, expect, test } from "bun:test";
import type { Health, StatusMessage } from "@tekurobokun/protocol";
import { InputDeviceRegistry } from "./devices.ts";
import { type KeyInput, OperatorConsole } from "./operator.ts";
import { StubAvailability } from "./stub_availability.ts";

function setup(options: { stub?: boolean; devices?: string[] } = {}) {
  const devices = new InputDeviceRegistry(options.devices ?? ["tablet", "phone"], "tablet");
  const health: Health = { backend: true, llm: true, tts: true, robot: false };
  const lines: string[] = [];
  let quits = 0;
  let rechecks = 0;
  const availability = new StubAvailability();
  const operator = new OperatorConsole({
    devices,
    status: (): StatusMessage => ({
      type: "status",
      session: "idle",
      activeDevice: devices.active(),
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
  devices.onChange(() => operator.showStatus());
  return {
    operator,
    devices,
    health,
    lines,
    availability,
    quits: () => quits,
    rechecks: () => rechecks,
  };
}

describe("OperatorConsole", () => {
  test("状態の1行に、有効な端末・端末一覧・会話の状態・応答の有無が入る", () => {
    const { operator, health } = setup();
    expect(operator.statusLine()).toBe(
      "[operator] active=tablet [1:tablet* 2:phone] session=idle llm=up tts=up robot=disconnected",
    );
    health.llm = false;
    health.robot = true;
    expect(operator.statusLine()).toContain("llm=DOWN tts=up robot=connected");
  });

  test("数字キーで端末一覧の順に有効な端末を切り替え、状態を出す", () => {
    const { operator, devices, lines } = setup();
    operator.handleKey("2");
    expect(devices.active()).toBe("phone");
    expect(lines.at(-1)).toContain("active=phone [1:tablet 2:phone*]");
    operator.handleKey("1");
    expect(devices.active()).toBe("tablet");
    expect(lines).toHaveLength(2);
  });

  test("いま有効な端末の番号でも状態を出す。一覧にない番号は切り替えない", () => {
    const { operator, devices, lines } = setup();
    operator.handleKey("1");
    expect(lines).toHaveLength(1);
    operator.handleKey("3");
    expect(devices.active()).toBe("tablet");
    expect(lines.at(-1)).toBe("[operator] no device for key 3");
    operator.handleKey("0");
    expect(lines).toHaveLength(2);
  });

  test("s・Enterで状態、h・?で説明、Ctrl+Cで終える", () => {
    const { operator, lines, quits } = setup();
    operator.handleKey("s");
    operator.handleKey("\r");
    expect(lines.filter((l) => l.startsWith("[operator] active="))).toHaveLength(2);
    operator.handleKey("h");
    expect(lines.at(-1)).toContain("1-2 switch input device");
    operator.handleKey("\u0003");
    expect(quits()).toBe(1);
  });

  test("スタブのときだけ、l・tでLLM・VOICEVOXを止め・戻し、問い合わせ直す", () => {
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
    stub.operator.handleKey("l");
    expect(stub.availability.isUp("llm")).toBe(true);
    expect(stub.rechecks()).toBe(3);
    expect(stub.operator.helpLines()).toHaveLength(2);
  });

  test("TTYでなければキー入力を受け取らない。TTYなら生のモードで1文字ずつ処理する", () => {
    const { operator, devices } = setup();
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
    (listener as ((chunk: string) => void) | null)?.("21");
    expect(devices.active()).toBe("tablet");
  });
});
