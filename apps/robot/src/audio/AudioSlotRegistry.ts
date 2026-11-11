import type { AudioConfig, AudioSlotInfo } from "../config/config";

// '1'-'9','0'キー→音声ファイル/キャプションの対応をconfigから解決する（imple 4.6準拠）。
// エラー音声・起動挨拶は番号スロットとは独立したリソースのため、ここでは扱わない。
export class AudioSlotRegistry {
  constructor(private readonly slots: AudioConfig["slots"]) {}

  resolve(key: string): AudioSlotInfo | "EMPTY" {
    return this.slots[key] ?? "EMPTY";
  }
}
