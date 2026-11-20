// 機体アプリの設定（imple 6節）。config.default.jsonをGitで管理し、
// 同じディレクトリにconfig.local.json（Git管理外）があれば項目ごとに上書きする。
// 上書きはオブジェクトを再帰的に合わせ、配列と値はまるごと置き換える。
// どちらもViteがビルドに取り込むため、変えたら機体アプリを起動し直す（ビルドし直す）。

import configDefault from "./config.default.json";

/**
 * 開発用の接続先とトークン（config.local.jsonに書いたときだけ使う）。
 * 本番は、登録の画面（S02g）でQRを読み、接続先とトークンをlocalStorageに保存する。
 */
export interface BackendConfig {
  /** バックエンドのWebSocket（例：ws://192.168.0.10:8787/ws） */
  url: string | null;
  /** `bun run admin exchange`で得たトークン */
  token: string | null;
}

/** 登録の画面（S02g） */
export interface PairingConfig {
  /** カメラの画像からQRを探す間隔 */
  scanIntervalMs: number;
  /** 読み取れたとき、笑った顔と「つながりました」を出す時間 */
  okHoldMs: number;
}

/** 機体のマイクの音声入力（VoiceCapture） */
export interface VoiceConfig {
  /** 検出の方式：silero（Silero VAD。精度が高いがCPUを使う）・level（音量のしきい値。軽い） */
  detector: "silero" | "level";
  /** 区切りの無音の長さ */
  silenceMs: number;
  /** 1発話の最大の長さ（超えたらそこで区切って送る） */
  maxUtteranceMs: number;
  /** 再生が終わってから聞き始めるまでの余裕（半二重） */
  halfDuplexGraceMs: number;
  /** 音量のしきい値（levelのとき。RMS、0〜1） */
  levelThreshold: number;
  /** これより短い音は声とみなさない */
  minSpeechMs: number;
  /** 声の始まりより前に含める長さ（語頭が切れないように） */
  preSpeechPadMs: number;
}

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
  /** 聞き取り中（S02h）の内側の円の半径。待機中より少し大きくして注目を示す */
  listeningInnerRadius: number;
  strokeWeight: number;
}

export interface MouthConfig {
  y: number;
  width: number;
  height: number;
  segments: number;
  strokeWeight: number;
  cornerRadius: number;
}

export interface FacialConfig {
  eyes: EyesConfig;
  mouth: MouthConfig;
}

/** 口パク：再生中の音の大きさ（RMS）から口の高さを決める。 */
export interface LipSyncConfig {
  /** これより小さいRMSは無音とみなす */
  floor: number;
  /** (RMS - floor) に掛けて0〜1にする */
  gain: number;
  /** 開くとき・閉じるときの追従の速さ（1フレームで目標に近づく割合、0〜1） */
  attack: number;
  release: number;
  /** 話し中の口の高さ＝基本の高さ ×（minRatio ＋ 値 × rangeRatio） */
  minRatio: number;
  rangeRatio: number;
}

/** 待機中のまばたき・きょろきょろ。間隔は最小〜最大の一様乱数。 */
export interface IdleConfig {
  blinkMinMs: number;
  blinkMaxMs: number;
  blinkDurationMs: number;
  lookMinMs: number;
  lookMaxMs: number;
  lookDurationMs: number;
  /** きょろきょろで内側の円を左右にずらす量 */
  lookOffsetX: number;
  /** 疑似乱数の種。nullなら起動ごとに変える */
  seed: number | null;
}

export interface RenderConfig {
  /** 話し中・考え中・まばたきなど、動いている間の描画頻度 */
  activeFps: number;
  /** 表情が変わらない間の描画頻度 */
  idleFps: number;
  /** 考え中の内側の円が1周する時間 */
  loadingTurnMs: number;
  /** 話し終えてから、感情の目を通常の目に戻すまで */
  emotionHoldMs: number;
  /** 眠っている顔の口の開き（話し中の口の値と同じ0〜1の尺度） */
  sleepMouthLevel: number;
  /** 眠っている顔が上下に揺れる幅（中心から片側） */
  sleepBobAmplitude: number;
  /** 眠っている顔が上下に1往復する時間 */
  sleepBobCycleMs: number;
}

/** 字幕1行の位置と大きさ（キャンバス左上が原点、px）。目の上端より上に収める。 */
export interface CaptionConfig {
  x: number;
  y: number;
  /** 1行に入る幅。これを超える文は末尾側を出す */
  maxWidth: number;
  fontSize: number;
  lineHeight: number;
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
  backend: BackendConfig;
  pairing: PairingConfig;
  voice: VoiceConfig;
  drive: DriveConfig;
  facial: FacialConfig;
  lipSync: LipSyncConfig;
  idle: IdleConfig;
  render: RenderConfig;
  caption: CaptionConfig;
  audio: AudioConfig;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** baseに、overrideの項目を再帰的に上書きした新しい値を返す。 */
export function mergeConfig(base: unknown, override: unknown): unknown {
  if (!isObj(base) || !isObj(override)) return override === undefined ? base : override;
  const out: Obj = { ...base };
  for (const [key, value] of Object.entries(override)) out[key] = mergeConfig(base[key], value);
  return out;
}

// config.local.jsonはないことが多いため、globで「あれば読む」。
const local = import.meta.glob<{ default: unknown }>("./config.local.json", { eager: true });

export const config = mergeConfig(
  configDefault,
  local["./config.local.json"]?.default ?? {},
) as AppConfig;
