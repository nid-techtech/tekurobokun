// フェイシャルの形（S02a〜S02d）。描く図形を、p5に依存しない値の並びとして組み立てる。
// 目・口の基本座標は機体の設定（ヘボコン版の値）。表情ごとの目の崩し方はモックS02c・S02dの値。

import type { Emotion } from "@tekurobokun/protocol";
import type { FacialConfig } from "../config/config";

export const FACIAL_CANVAS_WIDTH = 800;
export const FACIAL_CANVAS_HEIGHT = 600;
const CENTER_X = FACIAL_CANVAS_WIDTH / 2;

/** 表示状態（imple 4節）。SLEEPの顔はPhase 4で描く。 */
export type DisplayState = "IDLE" | "SPEAKING" | "LOADING" | "SLEEP";

/** 目の形。emotionの5種に、考え中・まばたき・きょろきょろを足したもの。 */
export type EyeKind = Emotion | "loading" | "blink" | "look_left" | "look_right";

export type Shape =
  | { type: "circle"; x: number; y: number; r: number; weight: number }
  /** 円弧。角度はラジアンで、0が右、時計回り（画面のy軸が下向きのため） */
  | { type: "arc"; x: number; y: number; r: number; start: number; stop: number; weight: number }
  | { type: "line"; x1: number; y1: number; x2: number; y2: number; weight: number }
  | {
      type: "rect";
      x: number;
      y: number;
      w: number;
      h: number;
      cornerRadius: number;
      weight: number;
    };

/** モックS02c・S02dの目の崩し方（800×600の座標）。 */
const EYE = {
  /** happy：弧の弦を目の中心から下げる量 */
  happyDrop: 20,
  /** surprised：小さくなった内側の円の半径 */
  surprisedInnerR: 34,
  /** curious：内側の円を右上へずらす量と、左右の内側の円の半径 */
  curiousShift: 18,
  curiousInnerR: { left: 70, right: 52 },
  /** troubled：内側の円を下げる量・小さくする量、上まぶたの線の両端の高さ */
  troubledDrop: 14,
  troubledShrink: 6,
  troubledLidOverhang: 6,
  troubledLidRise: { outer: 30, inner: 60 },
  /** loading：内側の円の、目の中心からの距離と、小さくする量 */
  loadingOrbit: 26,
  loadingShrink: 26,
} as const;

type Side = "left" | "right";

/** 左右の目の中心のx。 */
export function eyeCenters({ eyes }: FacialConfig): { side: Side; x: number }[] {
  return [
    { side: "left", x: CENTER_X - eyes.offsetX },
    { side: "right", x: CENTER_X + eyes.offsetX },
  ];
}

export type EyeOptions = {
  /** loadingの内側の円の回転（ラジアン、0で真上） */
  orbitAngle?: number;
  /** きょろきょろで内側の円をずらす量 */
  lookOffsetX?: number;
};

/** 1つの目の図形。 */
export function eyeShapes(
  kind: EyeKind,
  x: number,
  side: Side,
  { eyes }: FacialConfig,
  options: EyeOptions = {},
): Shape[] {
  const { y, outerRadius: ro, innerRadius: ri, strokeWeight: weight } = eyes;
  const circle = (cx: number, cy: number, r: number): Shape => ({
    type: "circle",
    x: cx,
    y: cy,
    r,
    weight,
  });
  const outer = circle(x, y, ro);
  const look = options.lookOffsetX ?? 0;

  switch (kind) {
    case "happy": {
      // 上半分の弧（目を細めて笑う）
      const cy = y + EYE.happyDrop;
      const arc = (r: number): Shape => ({
        type: "arc",
        x,
        y: cy,
        r,
        start: Math.PI,
        stop: Math.PI * 2,
        weight,
      });
      return [arc(ro), arc(ri)];
    }
    case "surprised":
      return [outer, circle(x, y, EYE.surprisedInnerR)];
    case "curious":
      return [outer, circle(x + EYE.curiousShift, y - EYE.curiousShift, EYE.curiousInnerR[side])];
    case "troubled": {
      // 上まぶたの線で半分閉じる。線は外側が低く、内側（顔の中央）が高い八の字
      const rise = (end: Side) =>
        y - (end === side ? EYE.troubledLidRise.outer : EYE.troubledLidRise.inner);
      return [
        outer,
        circle(x, y + EYE.troubledDrop, ri - EYE.troubledShrink),
        {
          type: "line",
          x1: x - ro - EYE.troubledLidOverhang,
          y1: rise("left"),
          x2: x + ro + EYE.troubledLidOverhang,
          y2: rise("right"),
          weight,
        },
      ];
    }
    case "loading": {
      // 内側の円が外側の円の中を回る
      const angle = options.orbitAngle ?? 0;
      return [
        outer,
        circle(
          x + EYE.loadingOrbit * Math.sin(angle),
          y - EYE.loadingOrbit * Math.cos(angle),
          ri - EYE.loadingShrink,
        ),
      ];
    }
    case "blink":
      return [{ type: "line", x1: x - ro, y1: y, x2: x + ro, y2: y, weight }];
    case "look_left":
      return [outer, circle(x - look, y, ri)];
    case "look_right":
      return [outer, circle(x + look, y, ri)];
    default:
      return [outer, circle(x, y, ri)];
  }
}

/** 口の図形。heightRatioは基本の高さに対する割合（待機中は1）。 */
export function mouthShapes({ mouth }: FacialConfig, heightRatio = 1): Shape[] {
  const h = mouth.height * heightRatio;
  const left = CENTER_X - mouth.width / 2;
  const top = mouth.y - h / 2;
  const weight = mouth.strokeWeight;
  const shapes: Shape[] = [
    { type: "rect", x: left, y: top, w: mouth.width, h, cornerRadius: mouth.cornerRadius, weight },
  ];
  const segmentWidth = mouth.width / mouth.segments;
  for (let i = 1; i < mouth.segments; i++) {
    const lx = left + segmentWidth * i;
    shapes.push({ type: "line", x1: lx, y1: top, x2: lx, y2: top + h, weight });
  }
  return shapes;
}

/** 1フレームの顔を決める値。 */
export type Scene = {
  eyes: EyeKind;
  /** 口の高さの割合（待機中は1） */
  mouthRatio: number;
  orbitAngle: number;
};

/** 顔全体の図形。 */
export function faceShapes(scene: Scene, config: FacialConfig, lookOffsetX: number): Shape[] {
  const shapes: Shape[] = [];
  for (const { side, x } of eyeCenters(config)) {
    shapes.push(
      ...eyeShapes(scene.eyes, x, side, config, { orbitAngle: scene.orbitAngle, lookOffsetX }),
    );
  }
  shapes.push(...mouthShapes(config, scene.mouthRatio));
  return shapes;
}
