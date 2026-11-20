// 全面の案内を出すかどうかと、どの表示にするかの判定（imple 4節）。DOMに依存しない。
// - offline（S01f）：バックエンドにつながっていない、まだwelcome・statusが届いていない、
//   LLM・VOICEVOXのどちらかが応答しない、または入力元が機体のマイクでSTTが応答しない
// - inactive（S01g）：入力元が別のconsole
// どちらでもなければnull（入力元が自分なら入力ページ、機体のマイクならログ表示専用のS01h）。
// 状況が戻れば、届いたstatusで自動で元の表示に戻る。

import { ROBOT_SOURCE, type StatusMessage } from "@tekurobokun/protocol";

export type NoticeKind = "offline" | "inactive";

export type NoticeInput = {
  connected: boolean;
  /** welcomeで設定を受け取ったか */
  welcomed: boolean;
  status: Pick<StatusMessage, "inputSource" | "health"> | null;
  /** この端末の名前（URLの?device=） */
  device: string;
};

export function noticeFor({ connected, welcomed, status, device }: NoticeInput): NoticeKind | null {
  if (!connected || !welcomed || !status) return "offline";
  if (!status.health.llm || !status.health.tts) return "offline";
  // STTは機体のマイクの声にだけ使う。consoleが入力元なら、STTが落ちていても話しかけられる。
  if (status.inputSource === ROBOT_SOURCE) return status.health.stt ? null : "offline";
  if (status.inputSource !== device) return "inactive";
  return null;
}

/** 入力元が機体のマイクで、ログの表示だけにするか（S01h）。 */
export function isViewOnly(status: Pick<StatusMessage, "inputSource"> | null): boolean {
  return status?.inputSource === ROBOT_SOURCE;
}
