// 機体の表示状態を、接続の有無とstatusから決める（imple 4節）。

import type { StatusMessage } from "@tekurobokun/protocol";
import type { DisplayState } from "./shapes";

export function displayStateFor(connected: boolean, status: StatusMessage | null): DisplayState {
  if (!connected || !status?.health.llm || !status.health.tts) return "SLEEP";
  switch (status.session) {
    case "thinking":
      return "LOADING";
    case "speaking":
      return "SPEAKING";
    default:
      return "IDLE";
  }
}
