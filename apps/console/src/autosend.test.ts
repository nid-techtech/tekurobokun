import { describe, expect, test } from "bun:test";
import { Autosend, type AutosendTick } from "./autosend.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(delayMs: number) {
  const ticks: (AutosendTick | null)[] = [];
  let fired = 0;
  const autosend = new Autosend(
    delayMs,
    (t) => ticks.push(t),
    () => fired++,
    10,
  );
  return { autosend, ticks, fired: () => fired };
}

describe("Autosend", () => {
  test("止まってから待ち時間がたつと1回だけ送る", async () => {
    const { autosend, ticks, fired } = setup(60);
    autosend.restart();
    expect(ticks[0]).toEqual({ remainingMs: 60, fraction: 0 });
    await wait(120);
    expect(fired()).toBe(1);
    expect(ticks.at(-1)).toBeNull();
    expect(autosend.running).toBe(false);
    const between = ticks.slice(1, -1) as AutosendTick[];
    expect(between.every((t) => t.fraction > 0 && t.fraction < 1)).toBe(true);
  });

  test("入力が続く間は送らない（restartで数え直す）", async () => {
    const { autosend, fired } = setup(60);
    for (let i = 0; i < 4; i++) {
      autosend.restart();
      await wait(30);
    }
    expect(fired()).toBe(0);
    await wait(80);
    expect(fired()).toBe(1);
  });

  test("cancelで止め、表示を消す", async () => {
    const { autosend, ticks, fired } = setup(40);
    autosend.restart();
    autosend.cancel();
    expect(ticks.at(-1)).toBeNull();
    await wait(80);
    expect(fired()).toBe(0);
  });

  test("待ち時間が0なら自動送信しない", async () => {
    const { autosend, ticks, fired } = setup(0);
    autosend.restart();
    await wait(30);
    expect(fired()).toBe(0);
    expect(ticks).toEqual([null]);
  });
});
