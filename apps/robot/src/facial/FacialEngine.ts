// FacialEngine：FaceStateが決めた顔を、p5で800×600のキャンバスに描く（imple 3節）。
// 表情が変わらない間は描画頻度を下げ、形が前のフレームと同じなら描き直さない。
// 色はトークン（--color-face-bg・--color-face-ink）から読む。

import p5 from "p5";
import type { FacialConfig, RenderConfig } from "../config/config";
import type { FaceState } from "./FaceState";
import { FACIAL_CANVAS_HEIGHT, FACIAL_CANVAS_WIDTH, faceShapes, type Shape } from "./shapes";

export type FacialEngineOptions = {
  facial: FacialConfig;
  render: RenderConfig;
  lookOffsetX: number;
  /** 再生中の音の大きさ（RMS） */
  level: () => number;
};

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export class FacialEngine {
  private lastKey = "";
  private fps = 0;

  constructor(
    container: HTMLElement,
    private readonly face: FaceState,
    options: FacialEngineOptions,
  ) {
    new p5((s: p5) => {
      const background = token("--color-face-bg");
      const ink = token("--color-face-ink");

      s.setup = () => {
        s.createCanvas(FACIAL_CANVAS_WIDTH, FACIAL_CANVAS_HEIGHT);
        this.setFps(s, options.render.idleFps);
      };

      s.draw = () => {
        const now = performance.now();
        const scene = this.face.scene(now, options.level());
        this.setFps(s, this.face.animating ? options.render.activeFps : options.render.idleFps);

        // 前のフレームと同じ形なら描き直さない（キャンバスはそのまま残る）。
        const key = `${scene.eyes}|${scene.mouthRatio.toFixed(3)}|${scene.orbitAngle.toFixed(2)}|${(scene.offsetY ?? 0).toFixed(1)}`;
        if (key === this.lastKey) return;
        this.lastKey = key;

        s.background(background);
        s.noFill();
        s.stroke(ink);
        for (const shape of faceShapes(scene, options.facial, options.lookOffsetX)) {
          drawShape(s, shape);
        }
      };
    }, container);
  }

  private setFps(s: p5, fps: number): void {
    if (fps === this.fps) return;
    this.fps = fps;
    s.frameRate(fps);
  }
}

function drawShape(s: p5, shape: Shape): void {
  s.strokeWeight(shape.weight);
  switch (shape.type) {
    case "circle":
      s.circle(shape.x, shape.y, shape.r * 2);
      return;
    case "arc":
      s.arc(shape.x, shape.y, shape.r * 2, shape.r * 2, shape.start, shape.stop, s.OPEN);
      return;
    case "line":
      s.line(shape.x1, shape.y1, shape.x2, shape.y2);
      return;
    case "rect":
      s.rect(shape.x, shape.y, shape.w, shape.h, shape.cornerRadius);
      return;
  }
}
