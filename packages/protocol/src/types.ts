// WebSocketでやり取りするメッセージの型（imple 4節）。
// backend・console・robotの3つのアプリが共有する。

export const SESSION_STATES = ["idle", "thinking", "speaking"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const EMOTIONS = ["neutral", "happy", "surprised", "curious", "troubled"] as const;
export type Emotion = (typeof EMOTIONS)[number];

export type Health = { backend: true; llm: boolean; tts: boolean; robot: boolean };

export type Reply = { say: string; emotion: Emotion; thinkingMs: number };

export type Turn = {
  id: string;
  /** ISO 8601 */
  at: string;
  device: string;
  text: string;
  reply?: Reply;
};

export type ConsoleSettings = {
  autosendMs: number;
  fontSizePx: number;
  /** 入力ページの下に空ける余白（キーボードとのずれの調節） */
  bottomInsetPx: number;
  prompt: { user: string; host: string; dir: string };
};

// console → backend
export type ConsoleHelloMessage = { type: "hello"; role: "console"; device: string };
export type UtteranceMessage = { type: "utterance"; text: string };

// robot → backend
export type RobotHelloMessage = { type: "hello"; role: "robot" };
export type PlaybackDoneMessage = { type: "playback_done"; turnId: string; index: number };

export type ConsoleMessage = ConsoleHelloMessage | UtteranceMessage;
export type RobotMessage = RobotHelloMessage | PlaybackDoneMessage;
export type ClientMessage = ConsoleMessage | RobotMessage;

// backend → console・robot（両方に配信）
export type WelcomeMessage = { type: "welcome"; settings: ConsoleSettings; history: Turn[] };
export type StatusMessage = {
  type: "status";
  session: SessionState;
  activeDevice: string;
  health: Health;
};
export type TurnStartedMessage = { type: "turn_started"; turn: Turn };
export type TurnRepliedMessage = { type: "turn_replied"; turnId: string } & Reply;

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
  | TurnRepliedMessage;
export type ServerMessage = BroadcastMessage | SpeechMessage;
