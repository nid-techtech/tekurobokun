// 機体の表示状態を、接続の有無とstatusから決める（imple 4節）。
// STTの応答の有無は、入力元が機体のマイク（robot）のときだけ見る（consoleが入力元ならSTTを使わない）。
// 調べ中（searching）は、前置きを再生している間はSPEAKING、それ以外はLOADING（S02i）。

import { ROBOT_SOURCE, type StatusMessage } from "@tekurobokun/protocol";
import type { DisplayState } from "./shapes";

export function displayStateFor(
  connected: boolean,
  status: StatusMessage | null,
  playing = false,
): DisplayState {
  if (!connected || !status?.health.llm || !status.health.tts) return "SLEEP";
  if (status.inputSource === ROBOT_SOURCE && !status.health.stt) return "SLEEP";
  switch (status.session) {
    case "listening":
      return "LISTENING";
    case "thinking":
      return "LOADING";
    case "searching":
      return playing ? "SPEAKING" : "LOADING";
    case "speaking":
      return "SPEAKING";
    default:
      return "IDLE";
  }
}
