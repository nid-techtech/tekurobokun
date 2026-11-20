// 字幕の中身を決める（表示のDOMはCaptionOverlay）。
// 考え中は来場者の発言（turn_started.turn.text）、話し中は機体が読み上げている文（speech.text）。
// 調べ中は、前置きを読み上げている間はその文、読み上げの後は検索語（turn_search_started.query。S02i）。

import type { SessionState } from "@tekurobokun/protocol";

export type CaptionSource = {
  /** バックエンドの状態。つながっていないときはnull */
  session: SessionState | null;
  /** いまのターンの来場者の発言 */
  userText: string | null;
  /** いま読み上げている文 */
  sentence: string | null;
  /** いまのターンの検索語（調べていなければnull） */
  searchQuery?: string | null;
};

/** speakerがsearchのとき、textは検索語。 */
export type CaptionContent = { speaker: "you" | "robot" | "search"; text: string };

/** 出す字幕。出さないときはnull。話し中の読み上げの前と文の間は、空にする。 */
export function captionFor({
  session,
  userText,
  sentence,
  searchQuery = null,
}: CaptionSource): CaptionContent | null {
  if (sentence) return { speaker: "robot", text: sentence };
  if (session === "thinking" && userText) return { speaker: "you", text: userText };
  if (session === "searching" && searchQuery) return { speaker: "search", text: searchQuery };
  return null;
}
