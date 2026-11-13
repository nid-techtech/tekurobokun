import { describe, expect, test } from "bun:test";
import type { Health, StatusMessage } from "@tekurobokun/protocol";
import type { FacialConfig } from "../config/config";
import configDefault from "../config/config.default.json";
import { displayStateFor } from "./displayState";
import { FaceState } from "./FaceState";
import { IdleAnimator, seededRandom } from "./IdleAnimator";
import { eyeShapes, faceShapes, mouthShapes, type Shape } from "./shapes";

const facial = configDefault.facial as FacialConfig;
const { lipSync, render } = configDefault;
const idle = { ...configDefault.idle, seed: 1 };

const circles = (shapes: Shape[]) =>
  shapes.flatMap((s) => (s.type === "circle" ? [[s.x, s.y, s.r]] : []));

describe("shapes（モックS02a〜S02dとの対応）", () => {
  // 左目の中心は 400 - 216 = 184、右目は 616、高さは149
  test("通常の目は外側111・内側82の同心円、口は5分割の角丸の四角", () => {
    const shapes = faceShapes({ eyes: "neutral", mouthRatio: 1, orbitAngle: 0 }, facial, 22);
    expect(circles(shapes)).toEqual([
      [184, 149, 111],
      [184, 149, 82],
      [616, 149, 111],
      [616, 149, 82],
    ]);
    const rect = shapes.find((s) => s.type === "rect");
    expect(rect).toMatchObject({ x: 53, y: 430 - 143 / 2, w: 694, h: 143, cornerRadius: 14 });
    expect(shapes.filter((s) => s.type === "line")).toHaveLength(4);
  });

  test("happyは上半分の弧2本", () => {
    const shapes = eyeShapes("happy", 184, "left", facial);
    expect(shapes).toEqual([
      expect.objectContaining({ type: "arc", x: 184, y: 169, r: 111, start: Math.PI }),
      expect.objectContaining({ type: "arc", x: 184, y: 169, r: 82, stop: Math.PI * 2 }),
    ]);
  });

  test("surprisedは内側の円が小さくなる", () => {
    expect(circles(eyeShapes("surprised", 184, "left", facial))).toEqual([
      [184, 149, 111],
      [184, 149, 34],
    ]);
  });

  test("curiousは内側の円が右上を見て、片目だけ小さい", () => {
    expect(circles(eyeShapes("curious", 184, "left", facial))[1]).toEqual([202, 131, 70]);
    expect(circles(eyeShapes("curious", 616, "right", facial))[1]).toEqual([634, 131, 52]);
  });

  test("troubledは内側の円を下げ、上まぶたの線が顔の中央側で高い", () => {
    const left = eyeShapes("troubled", 184, "left", facial);
    expect(circles(left)[1]).toEqual([184, 163, 76]);
    expect(left[2]).toMatchObject({ type: "line", x1: 67, y1: 119, x2: 301, y2: 89 });
    const right = eyeShapes("troubled", 616, "right", facial);
    expect(right[2]).toMatchObject({ y1: 89, y2: 119 });
  });

  test("loadingは内側の円が中心から26離れて回る", () => {
    expect(circles(eyeShapes("loading", 184, "left", facial))[1]).toEqual([184, 123, 56]);
    const quarter = circles(eyeShapes("loading", 184, "left", facial, { orbitAngle: Math.PI / 2 }));
    expect(quarter[1]?.[0]).toBeCloseTo(210);
    expect(quarter[1]?.[1]).toBeCloseTo(149);
  });

  test("まばたきは横線、きょろきょろは内側の円を左右にずらす", () => {
    expect(eyeShapes("blink", 184, "left", facial)).toEqual([
      expect.objectContaining({ type: "line", x1: 73, y1: 149, x2: 295, y2: 149 }),
    ]);
    expect(circles(eyeShapes("look_left", 184, "left", facial, { lookOffsetX: 22 }))[1]).toEqual([
      162, 149, 82,
    ]);
    expect(circles(eyeShapes("look_right", 184, "left", facial, { lookOffsetX: 22 }))[1]).toEqual([
      206, 149, 82,
    ]);
  });

  test("sleepは閉じた目：両端が目の中心の高さで、下へ90の半径でふくらむ弧（モックS02e）", () => {
    const [arc] = eyeShapes("sleep", 184, "left", facial);
    if (arc?.type !== "arc") throw new Error("expected an arc");
    const end = (a: number) => [arc.x + arc.r * Math.cos(a), arc.y + arc.r * Math.sin(a)];
    const [x1, y1] = end(arc.start);
    const [x2, y2] = end(arc.stop);
    expect(arc.r).toBe(90);
    expect(x1).toBeCloseTo(264);
    expect(x2).toBeCloseTo(104);
    expect(y1).toBeCloseTo(149);
    expect(y2).toBeCloseTo(149);
    // 弧の最も低い点（真下）は、目の中心より下
    expect(arc.start).toBeLessThan(Math.PI / 2);
    expect(arc.stop).toBeGreaterThan(Math.PI / 2);
    expect(arc.y + arc.r).toBeGreaterThan(149);
  });

  test("offsetYで顔全体が上下にずれる", () => {
    const base = faceShapes({ eyes: "sleep", mouthRatio: 0.5, orbitAngle: 0 }, facial, 22);
    const moved = faceShapes(
      { eyes: "sleep", mouthRatio: 0.5, orbitAngle: 0, offsetY: -10 },
      facial,
      22,
    );
    expect(moved).toHaveLength(base.length);
    for (const [i, s] of moved.entries()) {
      const b = base[i];
      if (s.type === "line" && b?.type === "line") {
        expect([s.y1, s.y2]).toEqual([b.y1 - 10, b.y2 - 10]);
      } else if (s.type !== "line" && b && b.type !== "line") {
        expect(s.y).toBe(b.y - 10);
      }
    }
  });

  test("話し中の口は高さだけが変わり、中心の高さは変わらない", () => {
    const small = mouthShapes(facial, 0.45)[0];
    const large = mouthShapes(facial, 1.3)[0];
    if (small?.type !== "rect" || large?.type !== "rect") throw new Error("rect expected");
    expect(small.h).toBeCloseTo(143 * 0.45);
    expect(large.h).toBeCloseTo(143 * 1.3);
    expect(small.y + small.h / 2).toBeCloseTo(430);
    expect(large.y + large.h / 2).toBeCloseTo(430);
    expect(small.w).toBe(large.w);
  });
});

describe("IdleAnimator", () => {
  const timing = {
    blinkMinMs: 1000,
    blinkMaxMs: 2000,
    blinkDurationMs: 100,
    lookMinMs: 5000,
    lookMaxMs: 6000,
    lookDurationMs: 1000,
  };

  const run = (seed: number, untilMs = 20000) => {
    const animator = new IdleAnimator(timing, 0, seededRandom(seed));
    const frames: string[] = [];
    for (let t = 0; t <= untilMs; t += 50) {
      const f = animator.frame(t);
      frames.push(`${f.blink ? "b" : "-"}${f.look}`);
    }
    return frames;
  };

  test("同じ種なら同じ並び、違う種なら違う並び", () => {
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
  });

  test("まばたきの間隔は設定の範囲に収まり、長さは設定のとおり", () => {
    const animator = new IdleAnimator(timing, 0, seededRandom(3));
    const starts: number[] = [];
    let wasBlink = false;
    let blinkFrames = 0;
    for (let t = 0; t <= 60000; t += 10) {
      const { blink } = animator.frame(t);
      if (blink && !wasBlink) starts.push(t);
      if (blink) blinkFrames++;
      wasBlink = blink;
    }
    const gaps = starts.slice(1).map((s, i) => s - (starts[i] ?? 0));
    expect(starts[0]).toBeGreaterThanOrEqual(1000);
    expect(starts[0]).toBeLessThanOrEqual(2010);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(1100);
      expect(gap).toBeLessThanOrEqual(2110);
    }
    expect(blinkFrames).toBe(starts.length * 10);
  });

  test("よそ見は左右どちらにも向き、その間だけ正面以外", () => {
    const frames = run(11, 120000);
    expect(frames.some((f) => f.endsWith("-1"))).toBe(true);
    expect(frames.some((f) => f.endsWith("1") && !f.endsWith("-1"))).toBe(true);
    expect(frames.filter((f) => !f.endsWith("0")).length).toBeLessThan(frames.length / 3);
  });
});

describe("FaceState", () => {
  const make = (reduced = false) =>
    new FaceState(
      { lipSync, idle, render, random: seededRandom(1), reducedMotion: () => reduced },
      0,
    );

  test("考え中は内側の円が回り、prefers-reduced-motionでは止まる", () => {
    const face = make();
    face.setState("LOADING", 0);
    expect(face.scene(0, 0)).toMatchObject({ eyes: "loading", orbitAngle: 0 });
    expect(face.scene(render.loadingTurnMs / 4, 0).orbitAngle).toBeCloseTo(Math.PI / 2);
    const still = make(true);
    still.setState("LOADING", 0);
    expect(still.scene(render.loadingTurnMs / 4, 0).orbitAngle).toBe(0);
  });

  test("話し中はemotionの目で、口は音の大きさに合わせて伸び縮みする", () => {
    const face = make();
    face.setState("SPEAKING", 0);
    face.setEmotion("happy");
    const quiet = face.scene(0, 0);
    expect(quiet.eyes).toBe("happy");
    expect(quiet.mouthRatio).toBeCloseTo(lipSync.minRatio);
    let loud = quiet;
    for (let i = 0; i < 30; i++) loud = face.scene(i * 33, 1);
    expect(loud.mouthRatio).toBeCloseTo(lipSync.minRatio + lipSync.rangeRatio);
  });

  test("話し終えたら、しばらく感情の目を残してから通常の目に戻る", () => {
    const face = make();
    face.setState("SPEAKING", 0);
    face.setEmotion("troubled");
    face.setState("IDLE", 1000);
    expect(face.scene(1000, 0)).toMatchObject({ eyes: "troubled", mouthRatio: 1 });
    expect(face.scene(1000 + render.emotionHoldMs, 0).eyes).toBe("neutral");
  });

  test("考え中に入ると、前の感情は消える", () => {
    const face = make();
    face.setState("SPEAKING", 0);
    face.setEmotion("happy");
    face.setState("LOADING", 100);
    face.setState("SPEAKING", 200);
    expect(face.scene(200, 0).eyes).toBe("neutral");
  });

  test("眠っている顔は閉じた目と少し開いた口で、ゆっくり上下に揺れる。prefers-reduced-motionでは止まる", () => {
    const face = make();
    face.setState("SLEEP", 0);
    const top = face.scene(0, 1);
    expect(top).toMatchObject({ eyes: "sleep", orbitAngle: 0 });
    expect(top.mouthRatio).toBeCloseTo(
      lipSync.minRatio + render.sleepMouthLevel * lipSync.rangeRatio,
    );
    expect(top.offsetY).toBeCloseTo(-render.sleepBobAmplitude);
    expect(face.scene(render.sleepBobCycleMs / 2, 0).offsetY).toBeCloseTo(render.sleepBobAmplitude);
    expect(face.scene(render.sleepBobCycleMs / 4, 0).offsetY).toBeCloseTo(0);
    expect(face.animating).toBe(true);

    const still = make(true);
    still.setState("SLEEP", 0);
    expect(still.scene(render.sleepBobCycleMs / 2, 0).offsetY).toBe(0);
    expect(still.animating).toBe(false);
  });

  test("眠っている顔から戻ると、通常の目に戻る", () => {
    const face = make();
    face.setState("SLEEP", 0);
    face.setState("IDLE", 1000);
    const scene = face.scene(1000, 0);
    expect(scene.eyes).not.toBe("sleep");
    expect(scene.offsetY ?? 0).toBe(0);
  });

  test("待機中はまばたき・きょろきょろをし、描画頻度を下げてよい", () => {
    const face = make();
    const eyes = new Set<string>();
    for (let t = 0; t < 60000; t += 20) eyes.add(face.scene(t, 0).eyes);
    expect([...eyes].sort()).toEqual(["blink", "look_left", "look_right", "neutral"]);
    expect(face.animating).toBe(false);
    face.setState("SPEAKING", 0);
    expect(face.animating).toBe(true);
  });
});

describe("displayStateFor", () => {
  const status = (session: StatusMessage["session"], health: Partial<Health> = {}) =>
    ({
      type: "status",
      session,
      activeDevice: "tablet",
      health: { backend: true, llm: true, tts: true, robot: true, ...health },
    }) as StatusMessage;

  test("statusから表示状態を決める", () => {
    expect(displayStateFor(true, status("idle"))).toBe("IDLE");
    expect(displayStateFor(true, status("thinking"))).toBe("LOADING");
    expect(displayStateFor(true, status("speaking"))).toBe("SPEAKING");
  });

  test("切断中・statusがまだない・LLMかVOICEVOXが落ちているときはSLEEP", () => {
    expect(displayStateFor(false, status("idle"))).toBe("SLEEP");
    expect(displayStateFor(true, null)).toBe("SLEEP");
    expect(displayStateFor(true, status("idle", { llm: false }))).toBe("SLEEP");
    expect(displayStateFor(true, status("idle", { tts: false }))).toBe("SLEEP");
  });
});
