import { describe, expect, test } from "bun:test";
import { fitBox, VIEWPORT_VARS, ViewportFit, type ViewportFitEnv } from "./viewport_fit.ts";

describe("fitBox", () => {
  test("見えている範囲の高さから下部マージンを引き、ずれの分だけ下げる", () => {
    expect(fitBox({ height: 400, offsetTop: 0 }, 0)).toEqual({ heightPx: 400, topPx: 0 });
    expect(fitBox({ height: 400, offsetTop: 120 }, 24)).toEqual({ heightPx: 376, topPx: 120 });
  });

  test("小数は丸め、負や不正な値は0にする", () => {
    expect(fitBox({ height: 400.6, offsetTop: 10.4 }, 0)).toEqual({ heightPx: 401, topPx: 10 });
    expect(fitBox({ height: 20, offsetTop: -5 }, 50)).toEqual({ heightPx: 0, topPx: 0 });
    expect(fitBox({ height: 300, offsetTop: 0 }, -10)).toEqual({ heightPx: 300, topPx: 0 });
    expect(fitBox({ height: 300, offsetTop: 0 }, Number.NaN)).toEqual({ heightPx: 300, topPx: 0 });
  });
});

type Listener = () => void;

function setup(opts: { installed?: boolean; fsEnabled?: boolean; viewport?: boolean } = {}) {
  const vvListeners = new Map<string, Set<Listener>>();
  const viewport = { height: 800, offsetTop: 0 };
  const vars = new Map<string, string>();
  const taps = new Set<Listener>();
  const fs = { active: false, requests: 0, reject: false };

  const env: ViewportFitEnv = {
    viewport:
      opts.viewport === false
        ? null
        : {
            get height() {
              return viewport.height;
            },
            get offsetTop() {
              return viewport.offsetTop;
            },
            addEventListener: (type, l) => {
              const set = vvListeners.get(type) ?? new Set();
              set.add(l);
              vvListeners.set(type, set);
            },
            removeEventListener: (type, l) => vvListeners.get(type)?.delete(l),
          },
    setVar: (name, value) => vars.set(name, value),
    tapTarget: {
      addEventListener: (_type, l) => taps.add(l),
      removeEventListener: (_type, l) => taps.delete(l),
    },
    fullscreen: {
      installed: () => opts.installed ?? false,
      enabled: () => opts.fsEnabled ?? true,
      active: () => fs.active,
      request: async () => {
        fs.requests++;
        if (fs.reject) throw new Error("denied");
        fs.active = true;
      },
    },
  };

  const emit = (type: "resize" | "scroll") => {
    for (const l of vvListeners.get(type) ?? []) l();
  };
  const tap = async () => {
    for (const l of [...taps]) l();
    await Promise.resolve();
  };
  return { fit: new ViewportFit(env), viewport, vars, taps, fs, emit, tap, vvListeners };
}

describe("ViewportFit", () => {
  test("開始時に、見えている範囲の高さと位置を渡す", () => {
    const { fit, vars } = setup();
    fit.start();
    expect(vars.get(VIEWPORT_VARS.height)).toBe("800px");
    expect(vars.get(VIEWPORT_VARS.top)).toBe("0px");
  });

  test("キーボードで範囲が縮み、ページがずらされたら追従する", () => {
    const { fit, viewport, vars, emit } = setup();
    fit.start();
    viewport.height = 450;
    emit("resize");
    expect(vars.get(VIEWPORT_VARS.height)).toBe("450px");
    viewport.offsetTop = 180;
    emit("scroll");
    expect(vars.get(VIEWPORT_VARS.top)).toBe("180px");
  });

  test("設定の下部マージンを引く", () => {
    const { fit, viewport, vars, emit } = setup();
    fit.start();
    fit.setBottomInset(32);
    expect(vars.get(VIEWPORT_VARS.height)).toBe("768px");
    viewport.height = 450;
    emit("resize");
    expect(vars.get(VIEWPORT_VARS.height)).toBe("418px");
  });

  test("visualViewportがなければ何も渡さない（CSSの既定の高さのまま）", () => {
    const { fit, vars } = setup({ viewport: false });
    fit.start();
    fit.setBottomInset(10);
    expect(vars.size).toBe(0);
  });

  test("PWAでないときは、タップで全画面にする", async () => {
    const { fit, fs, tap } = setup();
    fit.start();
    expect(fs.requests).toBe(0);
    await tap();
    expect(fs.requests).toBe(1);
    expect(fs.active).toBe(true);
    await tap();
    expect(fs.requests).toBe(1);
  });

  test("全画面を抜けたら、次のタップで戻す。断られても次のタップでやり直す", async () => {
    const { fit, fs, tap } = setup();
    fit.start();
    fs.reject = true;
    await tap();
    expect(fs.active).toBe(false);
    fs.reject = false;
    await tap();
    expect(fs.active).toBe(true);
    fs.active = false;
    await tap();
    expect(fs.requests).toBe(3);
    expect(fs.active).toBe(true);
  });

  test("PWAとして起動しているか、Fullscreen APIがなければ、タップを待たない", () => {
    const installed = setup({ installed: true });
    installed.fit.start();
    expect(installed.taps.size).toBe(0);
    const noApi = setup({ fsEnabled: false });
    noApi.fit.start();
    expect(noApi.taps.size).toBe(0);
  });

  test("stopで追従とタップの待ち受けをやめる", () => {
    const { fit, taps, vvListeners } = setup();
    fit.start();
    fit.stop();
    expect(taps.size).toBe(0);
    expect([...vvListeners.values()].every((s) => s.size === 0)).toBe(true);
  });
});
