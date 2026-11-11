import type { InputSource } from "./InputSource";

export type DriveKey = "w" | "s" | "a" | "d" | "r";

const DRIVE_KEYS = new Set<DriveKey>(["w", "s", "a", "d", "r"]);
const AUDIO_KEYS = new Set<string>(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]);
const DEBUG_KEY = "/";

export class InputRouter {
  private readonly driveHandlers: Array<(key: DriveKey) => void> = [];
  private readonly audioHandlers: Array<(key: string) => void> = [];
  private readonly debugToggleHandlers: Array<() => void> = [];

  constructor(source: InputSource) {
    source.onKeyDown((key) => {
      if (DRIVE_KEYS.has(key as DriveKey)) {
        for (const handler of this.driveHandlers) handler(key as DriveKey);
        return;
      }
      if (AUDIO_KEYS.has(key)) {
        for (const handler of this.audioHandlers) handler(key);
        return;
      }
      if (key === DEBUG_KEY) {
        for (const handler of this.debugToggleHandlers) handler();
        return;
      }
      // 範囲外キーは無視。
    });
  }

  onDrive(handler: (key: DriveKey) => void): void {
    this.driveHandlers.push(handler);
  }

  onAudio(handler: (key: string) => void): void {
    this.audioHandlers.push(handler);
  }

  onDebugToggle(handler: () => void): void {
    this.debugToggleHandlers.push(handler);
  }
}
