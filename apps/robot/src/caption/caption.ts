// 字幕の中身を決める（表示のDOMはCaptionOverlay）。
// 考え中は来場者の発言（turn_started.turn.text）、話し中は機体が読み上げている文（speech.text）。

import type { SessionState } from "@tekurobokun/protocol";

export type CaptionSource = {
  /** バックエンドの状態。つながっていないときはnull */
  session: SessionState | null;
  /** いまのターンの来場者の発言 */
  userText: string | null;
  /** いま読み上げている文 */
  sentence: string | null;
};

export type CaptionContent = { speaker: "you" | "robot"; text: string };

/** 出す字幕。出さないときはnull。話し中の読み上げの前と文の間は、空にする。 */
export function captionFor({ session, userText, sentence }: CaptionSource): CaptionContent | null {
  if (sentence) return { speaker: "robot", text: sentence };
  if (session === "thinking" && userText) return { speaker: "you", text: userText };
  return null;
}
