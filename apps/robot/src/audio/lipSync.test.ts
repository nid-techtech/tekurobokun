import { describe, expect, test } from "bun:test";
import { followOpenness, targetOpenness } from "./lipSync";

const params = { floor: 0.01, gain: 5, attack: 0.5, release: 0.25 };

describe("lipSync", () => {
  test("無音は0、大きい音は1で頭打ち", () => {
    expect(targetOpenness(0, params)).toBe(0);
    expect(targetOpenness(0.005, params)).toBe(0);
    expect(targetOpenness(0.11, params)).toBeCloseTo(0.5);
    expect(targetOpenness(0.9, params)).toBe(1);
  });

  test("開くときはattack、閉じるときはreleaseの割合で近づく", () => {
    expect(followOpenness(0, 0.9, params)).toBeCloseTo(0.5);
    expect(followOpenness(1, 0, params)).toBeCloseTo(0.75);
  });

  test("同じ音が続けば目標に収まる", () => {
    let v = 0;
    for (let i = 0; i < 50; i++) v = followOpenness(v, 0.11, params);
    expect(v).toBeCloseTo(0.5);
  });
});
