// SpeechRecognizer：機体のマイクの1発話（WAV）を文字にする（imple 3節・4節）。
// 実装はWhisperSpeechRecognizer（手元のwhisper-server）と
// StubSpeechRecognizer（WAVの長さに応じた決まった文）。
// 失敗（通信・時間切れ・応答の形）は例外で知らせ、ConversationSessionが`health.stt`を落とす。
// 声が入っていない（結果が空、または捨てた）のは失敗ではなく、空の文字を返す。

export type Recognition = { text: string; ms: number };

/** 文字にできなかったときの例外。 */
export class SttError extends Error {}

export interface SpeechRecognizer {
  /** 失敗はthrow（SttError）。声がなければ空の文字 */
  recognize(wav: Uint8Array): Promise<Recognition>;
  /** 応答の有無（HealthMonitorの問い合わせ） */
  probe(): Promise<boolean>;
}
