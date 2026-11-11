import p5 from "p5";
import type { FacialConfig } from "../config/config";

export const FACIAL_CANVAS_WIDTH = 800;
export const FACIAL_CANVAS_HEIGHT = 600;

const CENTER_X = FACIAL_CANVAS_WIDTH / 2;

// アニメーションなし。初期化時に1回描画するのみ（imple 4.8準拠）。
export class FacialEngine {
  constructor(container: HTMLElement, facialConfig: FacialConfig) {
    new p5((s: p5) => {
      s.setup = () => {
        s.createCanvas(FACIAL_CANVAS_WIDTH, FACIAL_CANVAS_HEIGHT);
        s.noLoop();
        s.background(255);
        s.noFill();
        s.stroke(0);
        drawEyes(s, facialConfig);
        drawMouth(s, facialConfig);
      };
    }, container);
  }
}

// 二重同心円の目（塗りつぶしなし太線）
function drawEyes(s: p5, { eyes }: FacialConfig): void {
  s.strokeWeight(eyes.strokeWeight);
  for (const cx of [CENTER_X - eyes.offsetX, CENTER_X + eyes.offsetX]) {
    s.circle(cx, eyes.y, eyes.outerRadius * 2);
    s.circle(cx, eyes.y, eyes.innerRadius * 2);
  }
}

// 横長矩形を縦線でsegments分割した口（塗りつぶしなし太線）
function drawMouth(s: p5, { mouth }: FacialConfig): void {
  s.strokeWeight(mouth.strokeWeight);
  const left = CENTER_X - mouth.width / 2;
  const top = mouth.y - mouth.height / 2;
  s.rect(left, top, mouth.width, mouth.height);

  const segmentWidth = mouth.width / mouth.segments;
  for (let i = 1; i < mouth.segments; i++) {
    const x = left + segmentWidth * i;
    s.line(x, top, x, top + mouth.height);
  }
}
