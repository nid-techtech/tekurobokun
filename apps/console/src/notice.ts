// 全面の案内を出すかどうかの判定（imple 4節）。DOMに依存しない。
// - offline（S01f）：バックエンドにつながっていない、まだwelcome・statusが届いていない、
//   またはLLM・VOICEVOXのどちらかが応答しない（スペックシート6節「モックとの差分」）
// - inactive（S01g）：有効な端末が自分ではない
// どちらでもなければnull。状況が戻れば、届いたstatusで自動で元の表示に戻る。

import type { StatusMessage } from "@tekurobokun/protocol";

export type NoticeKind = "offline" | "inactive";

export type NoticeInput = {
  connected: boolean;
  /** welcomeで設定を受け取ったか */
  welcomed: boolean;
  status: Pick<StatusMessage, "activeDevice" | "health"> | null;
  /** この端末の名前（URLの?device=） */
  device: string;
};

export function noticeFor({ connected, welcomed, status, device }: NoticeInput): NoticeKind | null {
  if (!connected || !welcomed || !status) return "offline";
  if (!status.health.llm || !status.health.tts) return "offline";
  if (status.activeDevice !== device) return "inactive";
  return null;
}
