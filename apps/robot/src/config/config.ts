import configDefault from "./config.default.json";

export interface DriveConfig {
  forwardSpeed: number;
  turnSpeed: number;
  arduinoTimeoutMs: number;
  keepAliveIntervalMs: number;
}

export interface EyesConfig {
  offsetX: number; // キャンバス中央からの左右オフセット(px)
  y: number;
  outerRadius: number;
  innerRadius: number;
  strokeWeight: number;
}

export interface MouthConfig {
  y: number;
  width: number;
  height: number;
  segments: number;
  strokeWeight: number;
}

export interface FacialConfig {
  eyes: EyesConfig;
  mouth: MouthConfig;
}

export interface AudioSlotInfo {
  filePath: string;
  caption: string;
}

export interface AudioConfig {
  slots: Record<string, AudioSlotInfo>; // '1'-'9','0'キーに対応。未登録キーはEMPTY扱い
  errorSound: AudioSlotInfo; // 空スロット再生時専用（番号スロットとは独立）
  startupGreeting: AudioSlotInfo; // 起動時自動再生（番号スロットとは独立）
}

export interface AppConfig {
  drive: DriveConfig;
  facial: FacialConfig;
  audio: AudioConfig;
}

export const config: AppConfig = configDefault;
