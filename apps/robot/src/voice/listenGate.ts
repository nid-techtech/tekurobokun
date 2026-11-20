// 機体がマイクで聞いてよいか（imple 3節のVoiceCapture）。DOMに依存しない判定だけを置く。
// 聞くのは、登録済みでつながっていて、statusが待機中（自分が声を検出した聞き取り中を含む）、入力元がrobot、
// マイクが一時停止でなく、LLM・VOICEVOX・STTが応答していて、音声を再生していない（終わってから余裕の時間も）ときだけ。
// 走行中の停止（drive.micResumeMs）はPhase 9で足す。

import { ROBOT_SOURCE, type StatusMessage } from "@tekurobokun/protocol";

export type ListenConditions = {
  paired: boolean;
  connected: boolean;
  status: StatusMessage | null;
  /** 送った1発話の結果（考え中・待機中など）をまだ受け取っていない */
  awaitingResult: boolean;
  /** 音声を再生している */
  playing: boolean;
  /** 最後に再生が終わった時刻（ms） */
  playbackEndedAt: number;
  nowMs: number;
  /** 再生が終わってから聞き始めるまでの余裕（半二重） */
  halfDuplexGraceMs: number;
};

export function shouldListen(c: ListenConditions): boolean {
  const { status } = c;
  if (!c.paired || !c.connected || !status) return false;
  if (status.inputSource !== ROBOT_SOURCE || status.micPaused) return false;
  if (!status.health.llm || !status.health.tts || !status.health.stt) return false;
  // 送った1発話を文字にしている間（バックエンドは聞き取り中のまま）は聞かない。
  if (c.awaitingResult) return false;
  if (status.session !== "idle" && status.session !== "listening") return false;
  return !c.playing && c.nowMs >= c.playbackEndedAt + c.halfDuplexGraceMs;
}
