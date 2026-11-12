// 口パク：再生中の音の大きさ（RMS）から、口の開き（0〜1）を決める。
// 開くときは速く、閉じるときはゆっくり追従させ、音の細かい揺れで口がばたつかないようにする。

import type { LipSyncConfig } from "../config/config";

export type LipSyncParams = Pick<LipSyncConfig, "floor" | "gain" | "attack" | "release">;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** RMSから、目標の口の開き（0〜1）。 */
export function targetOpenness(rms: number, { floor, gain }: LipSyncParams): number {
  return clamp01((rms - floor) * gain);
}

/** 1フレーム分、口の開きを目標へ近づける。 */
export function followOpenness(previous: number, rms: number, params: LipSyncParams): number {
  const target = targetOpenness(rms, params);
  const rate = clamp01(target > previous ? params.attack : params.release);
  return previous + (target - previous) * rate;
}
