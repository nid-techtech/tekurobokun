// WebSocketでやり取りするメッセージと、管理用APIの型（imple 4節）。
// backend・console・robot・launcherの4つのアプリが共有する。
// v5のメッセージとの互換は保たない（アプリを同時に更新する）。

export const SESSION_STATES = ["idle", "listening", "thinking", "searching", "speaking"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const EMOTIONS = ["neutral", "happy", "surprised", "curious", "troubled"] as const;
export type Emotion = (typeof EMOTIONS)[number];

export type Health = { backend: true; llm: boolean; tts: boolean; stt: boolean; robot: boolean };

/** 入力元。`robot`（機体のマイク）か、設定のconsoleの名前（`tablet`・`phone`など） */
export type InputSource = string;
export const ROBOT_SOURCE = "robot";

export const VIAS = ["mic", "text"] as const;
export type Via = (typeof VIAS)[number];

export type Reply = { say: string; emotion: Emotion; thinkingMs: number };

/** 検索したターンの検索の情報。searchMs・okは、検索が終わるまでnull */
export type TurnSearch = {
  query: string;
  preSay: string;
  searchMs: number | null;
  ok: boolean | null;
};

export type Turn = {
  id: string;
  /** ISO 8601 */
  at: string;
  source: InputSource;
  via: Via;
  text: string;
  reply?: Reply;
  search?: TurnSearch;
};

export type ConsoleSettings = {
  autosendMs: number;
  fontSizePx: number;
  /** 入力ページの下に空ける余白（キーボードとのずれの調節） */
  bottomInsetPx: number;
  prompt: { user: string; host: string; dir: string };
  /** だれも話さない時間で履歴を区切るまでの時間（区切りの行の「{seconds}秒」に使う。backendのsession.idleResetMs） */
  idleResetMs: number;
};

export const DEVICE_ROLES = ["console", "robot"] as const;
export type DeviceRole = (typeof DEVICE_ROLES)[number];

// console・robot → backend（未登録でも受け付けるのはhelloとpairだけ）
export type ConsoleHelloMessage = {
  type: "hello";
  role: "console";
  device: string;
  token: string | null;
};
export type RobotHelloMessage = { type: "hello"; role: "robot"; token: string | null };
export type PairMessage = { type: "pair"; role: DeviceRole; device?: string; code: string };

// console → backend
export type UtteranceMessage = { type: "utterance"; text: string };

// robot → backend
export type PlaybackDoneMessage = { type: "playback_done"; turnId: string; index: number };
/** 声を検出した（true）・取り消した（false） */
export type ListeningMessage = { type: "listening"; active: boolean };
export type VoiceMessage = { type: "voice" /** base64 */; wav: string; durationMs: number };

export type ConsoleMessage = ConsoleHelloMessage | PairMessage | UtteranceMessage;
export type RobotMessage =
  | RobotHelloMessage
  | PairMessage
  | PlaybackDoneMessage
  | ListeningMessage
  | VoiceMessage;
export type ClientMessage = ConsoleMessage | RobotMessage;

// backend → 接続元のみ
export const AUTH_REQUIRED_REASONS = ["missing", "invalid", "revoked"] as const;
export type AuthRequiredReason = (typeof AUTH_REQUIRED_REASONS)[number];
export type AuthRequiredMessage = { type: "auth_required"; reason: AuthRequiredReason };
export type PairedMessage = { type: "paired"; token: string };
export const PAIR_FAILED_REASONS = [
  "invalid",
  "expired",
  "rate_limited",
  "unknown_device",
] as const;
export type PairFailedReason = (typeof PAIR_FAILED_REASONS)[number];
export type PairFailedMessage = { type: "pair_failed"; reason: PairFailedReason };

// backend → console・robot（両方に配信）
export type WelcomeMessage = { type: "welcome"; settings: ConsoleSettings; history: Turn[] };
export type StatusMessage = {
  type: "status";
  session: SessionState;
  inputSource: InputSource;
  micPaused: boolean;
  health: Health;
};
export type TurnStartedMessage = { type: "turn_started"; turn: Turn };
export type TurnRepliedMessage = { type: "turn_replied"; turnId: string } & Reply;
export type TurnSearchStartedMessage = {
  type: "turn_search_started";
  turnId: string;
  query: string;
  preSay: string;
  emotion: Emotion;
  thinkingMs: number;
};
export type TurnSearchDoneMessage = {
  type: "turn_search_done";
  turnId: string;
  searchMs: number;
  ok: boolean;
};
export const HISTORY_CLEARED_REASONS = ["idle", "manual"] as const;
export type HistoryClearedReason = (typeof HISTORY_CLEARED_REASONS)[number];
export type HistoryClearedMessage = {
  type: "history_cleared";
  at: string;
  reason: HistoryClearedReason;
};

// backend → robot のみ
export type SpeechMessage = {
  type: "speech";
  turnId: string;
  index: number;
  last: boolean;
  text: string;
  emotion: Emotion;
  /** base64 */
  wav: string;
};

export type BroadcastMessage =
  | WelcomeMessage
  | StatusMessage
  | TurnStartedMessage
  | TurnRepliedMessage
  | TurnSearchStartedMessage
  | TurnSearchDoneMessage
  | HistoryClearedMessage;
export type DirectMessage = AuthRequiredMessage | PairedMessage | PairFailedMessage;
export type ServerMessage = BroadcastMessage | SpeechMessage | DirectMessage;

// ===== 管理用API（127.0.0.1:8788） =====

export const ADMIN_PATHS = {
  status: "/admin/status",
  pairingCodes: "/admin/pairing-codes",
  devices: "/admin/devices",
  inputSource: "/admin/input-source",
  mic: "/admin/mic",
  reset: "/admin/reset",
  llmModel: "/admin/llm-model",
  events: "/admin/events",
} as const;

export const LLM_ALIASES = ["main", "sub"] as const;
export type LlmAlias = (typeof LLM_ALIASES)[number];

export type Device = {
  id: string;
  role: DeviceRole;
  name: string;
  /** ISO 8601 */
  registeredAt: string;
  connected: boolean;
};

/** GET /admin/status */
export type AdminStatus = {
  session: SessionState;
  inputSource: InputSource;
  micPaused: boolean;
  health: Health;
  llmModel: LlmAlias;
  searchCount: { month: string; count: number };
  devices: Device[];
  publicUrl: string;
};

/** POST /admin/pairing-codes */
export type PairingCode = {
  code: string;
  /** ISO 8601 */
  expiresAt: string;
  /** QRに入れる文字列（`{publicUrl}/pair#{code}`） */
  qr: string;
};

/** PUT /admin/input-source */
export type InputSourceRequest = { source: InputSource };
/** PUT /admin/mic */
export type MicRequest = { paused: boolean };
/** PUT /admin/llm-model */
export type LlmModelRequest = { alias: LlmAlias };

export const ADMIN_EVENT_KINDS = [
  "llm_timeout",
  "paired",
  "unpaired",
  "reset",
  "input_source",
  "mic",
] as const;
export type AdminEventKind = (typeof ADMIN_EVENT_KINDS)[number];

/** WS /admin/events で流すもの */
export type AdminStatusEvent = { type: "status" } & AdminStatus;
export type AdminEventMessage = {
  type: "event";
  /** ISO 8601 */
  at: string;
  kind: AdminEventKind;
  detail: string;
};
export type AdminEvent = AdminStatusEvent | AdminEventMessage;
