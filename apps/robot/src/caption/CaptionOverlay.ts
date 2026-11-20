import { m } from "@tekurobokun/i18n";
import type { CaptionConfig } from "../config/config";
import type { CaptionContent } from "./caption";

// FacialEngineとは独立した、字幕1行のDOMオーバーレイ（モックS02f）。
// 1行に入らない長さは、行の右端を揃えて左側を切り捨てる（端末が流れるように末尾側を出す）。
// 文字数を数えず、CSS（row-reverse＋overflow）で切るため、書体の読み込みに左右されない。

export class CaptionOverlay {
  private readonly container: HTMLDivElement;
  private readonly line: HTMLSpanElement;

  constructor(root: HTMLElement, layout: CaptionConfig) {
    this.container = document.createElement("div");
    this.container.id = "caption-overlay";
    this.container.hidden = true;
    this.container.style.left = `${layout.x}px`;
    this.container.style.top = `${layout.y}px`;
    this.container.style.width = `${layout.maxWidth}px`;
    this.container.style.height = `${layout.lineHeight}px`;
    this.container.style.fontSize = `${layout.fontSize}px`;
    this.container.style.lineHeight = `${layout.lineHeight}px`;
    this.line = document.createElement("span");
    this.container.appendChild(this.line);
    root.appendChild(this.container);
  }

  /** 話し手の付かない1行を出す（登録の画面の案内。S02g）。 */
  setText(text: string): void {
    this.line.textContent = text;
    this.container.hidden = false;
  }

  /** 字幕を出す。nullなら消す。 */
  set(content: CaptionContent | null): void {
    if (!content) {
      this.container.hidden = true;
      this.line.textContent = "";
      return;
    }
    const who = content.speaker === "you" ? m["log.you"]() : m["log.robot"]();
    this.line.textContent = m["face.caption_line"]({ who, text: content.text });
    this.container.hidden = false;
  }
}
