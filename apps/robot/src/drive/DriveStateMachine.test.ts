import { describe, expect, test } from "bun:test";
import { DriveStateMachine, type DriveKey, type DriveState } from "./DriveStateMachine";

// 仕様4.1の状態遷移表を全パターン網羅する。undefined = 無視（同一状態への遷移を含む）。
const TRANSITION_TABLE: Record<DriveState, Partial<Record<DriveKey, DriveState>>> = {
  STOP: { w: "FORWARD", s: "BACKWARD", a: "TURN_L", d: "TURN_R" },
  FORWARD: { s: "BACKWARD", a: "TURN_L", d: "TURN_R", r: "STOP" },
  BACKWARD: { w: "FORWARD", a: "TURN_L", d: "TURN_R", r: "STOP" },
  TURN_L: { w: "FORWARD", s: "BACKWARD", d: "TURN_R", r: "STOP" },
  TURN_R: { w: "FORWARD", s: "BACKWARD", a: "TURN_L", r: "STOP" },
};

const ALL_KEYS: DriveKey[] = ["w", "s", "a", "d", "r"];

// STOPから対象状態へ至るためのキー入力列。
const ENTRY_KEYS: Record<DriveState, DriveKey[]> = {
  STOP: [],
  FORWARD: ["w"],
  BACKWARD: ["s"],
  TURN_L: ["a"],
  TURN_R: ["d"],
};

function createMachineAt(state: DriveState): DriveStateMachine {
  const machine = new DriveStateMachine({ forwardSpeed: 50, turnSpeed: 30 });
  for (const key of ENTRY_KEYS[state]) {
    machine.handleKey(key);
  }
  expect(machine.getCurrentState()).toBe(state);
  return machine;
}

describe("DriveStateMachine 状態遷移表（仕様4.1）", () => {
  for (const [fromState, row] of Object.entries(TRANSITION_TABLE) as [DriveState, Partial<Record<DriveKey, DriveState>>][]) {
    for (const key of ALL_KEYS) {
      const expected = row[key] ?? null;
      test(`${fromState} + '${key}' -> ${expected ?? "無視"}`, () => {
        const machine = createMachineAt(fromState);
        const result = machine.handleKey(key);
        if (expected === null) {
          expect(result).toBeNull();
          expect(machine.getCurrentState()).toBe(fromState);
        } else {
          expect(result).toBe(expected);
          expect(machine.getCurrentState()).toBe(expected);
        }
      });
    }
  }
});

describe("DriveStateMachine モーターコマンド（仕様4.2）", () => {
  test("STOP -> (0, 0)", () => {
    const machine = createMachineAt("STOP");
    expect(machine.getMotorCommand()).toEqual({ l: 0, r: 0 });
  });

  test("FORWARD -> (+F, +F)", () => {
    const machine = createMachineAt("FORWARD");
    expect(machine.getMotorCommand()).toEqual({ l: 50, r: 50 });
  });

  test("BACKWARD -> (-F, -F)", () => {
    const machine = createMachineAt("BACKWARD");
    expect(machine.getMotorCommand()).toEqual({ l: -50, r: -50 });
  });

  test("TURN_L -> (-T, +T)", () => {
    const machine = createMachineAt("TURN_L");
    expect(machine.getMotorCommand()).toEqual({ l: -30, r: 30 });
  });

  test("TURN_R -> (+T, -T)", () => {
    const machine = createMachineAt("TURN_R");
    expect(machine.getMotorCommand()).toEqual({ l: 30, r: -30 });
  });
});

describe("DriveStateMachine onStateChange", () => {
  test("状態変化時にhandlerへstateとcommandが渡る", () => {
    const machine = new DriveStateMachine({ forwardSpeed: 50, turnSpeed: 30 });
    const events: Array<{ state: DriveState; command: { l: number; r: number } }> = [];
    machine.onStateChange((state, command) => events.push({ state, command }));

    machine.handleKey("w");
    expect(events).toEqual([{ state: "FORWARD", command: { l: 50, r: 50 } }]);
  });

  test("無視される入力ではhandlerが発火しない", () => {
    const machine = new DriveStateMachine({ forwardSpeed: 50, turnSpeed: 30 });
    let callCount = 0;
    machine.onStateChange(() => callCount++);

    machine.handleKey("r"); // STOP中のrは無視
    expect(callCount).toBe(0);
  });
});
