export type DriveState = "STOP" | "FORWARD" | "BACKWARD" | "TURN_L" | "TURN_R";
export type DriveKey = "w" | "s" | "a" | "d" | "r";

export interface MotorCommand {
  l: number;
  r: number;
}

export interface DriveStateMachineParams {
  forwardSpeed: number;
  turnSpeed: number;
}

// 仕様4.1の状態遷移表。キーが存在しないセルは「無視」（同一状態への遷移を含む）。
const TRANSITIONS: Record<DriveState, Partial<Record<DriveKey, DriveState>>> = {
  STOP: { w: "FORWARD", s: "BACKWARD", a: "TURN_L", d: "TURN_R" },
  FORWARD: { s: "BACKWARD", a: "TURN_L", d: "TURN_R", r: "STOP" },
  BACKWARD: { w: "FORWARD", a: "TURN_L", d: "TURN_R", r: "STOP" },
  TURN_L: { w: "FORWARD", s: "BACKWARD", d: "TURN_R", r: "STOP" },
  TURN_R: { w: "FORWARD", s: "BACKWARD", a: "TURN_L", r: "STOP" },
};

export class DriveStateMachine {
  private state: DriveState = "STOP";
  private readonly handlers: Array<(state: DriveState, command: MotorCommand) => void> = [];

  constructor(private readonly params: DriveStateMachineParams) {}

  handleKey(key: DriveKey): DriveState | null {
    const nextState = TRANSITIONS[this.state][key];
    if (nextState === undefined) {
      return null;
    }
    this.state = nextState;
    const command = this.getMotorCommand();
    for (const handler of this.handlers) handler(this.state, command);
    return this.state;
  }

  getCurrentState(): DriveState {
    return this.state;
  }

  // 仕様4.2のコマンド対応表。
  getMotorCommand(): MotorCommand {
    const { forwardSpeed: f, turnSpeed: t } = this.params;
    switch (this.state) {
      case "STOP":
        return { l: 0, r: 0 };
      case "FORWARD":
        return { l: f, r: f };
      case "BACKWARD":
        return { l: -f, r: -f };
      case "TURN_L":
        return { l: -t, r: t };
      case "TURN_R":
        return { l: t, r: -t };
    }
  }

  onStateChange(handler: (state: DriveState, command: MotorCommand) => void): void {
    this.handlers.push(handler);
  }
}
