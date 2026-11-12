// ViewportFit：画面の高さを、キーボードを除いて実際に見えている範囲（visualViewport）に合わせる。
// interactive-widget=resizes-contentが効かないブラウザ・表示モードでは、キーボードが出てもページの高さが縮まず、
// ブラウザが入力欄の位置までページをずらす。見えている範囲の高さから下部マージンを引いた値を画面の高さにし、
// ずらした分（offsetTop）だけ画面を下げて打ち消す。値はCSSのカスタムプロパティで渡す（styles.cssの.term）。
// PWAとして起動していない（display-modeが全画面・スタンドアロンでない）ときは、最初のタップで全画面表示にする。

/** 画面の高さとずれを渡すカスタムプロパティ。 */
export const VIEWPORT_VARS = { height: "--viewport-height", top: "--viewport-top" } as const;

export type ViewportBox = { heightPx: number; topPx: number };

/** 見えている範囲の高さ・ずれと下部マージンから、画面の高さと位置を求める。 */
export function fitBox(
  viewport: { height: number; offsetTop: number },
  bottomInsetPx: number,
): ViewportBox {
  const inset = Number.isFinite(bottomInsetPx) && bottomInsetPx > 0 ? bottomInsetPx : 0;
  return {
    heightPx: Math.max(0, Math.round(viewport.height - inset)),
    topPx: Math.max(0, Math.round(viewport.offsetTop)),
  };
}

/** visualViewportのうち、使う部分。 */
export type VisualViewportLike = {
  readonly height: number;
  readonly offsetTop: number;
  addEventListener(type: "resize" | "scroll", listener: () => void): void;
  removeEventListener(type: "resize" | "scroll", listener: () => void): void;
};

/** 全画面表示まわりの、使う部分。 */
export type FullscreenLike = {
  /** PWAとして全画面・スタンドアロンで起動しているか */
  installed(): boolean;
  /** Fullscreen APIが使えるか */
  enabled(): boolean;
  /** いま全画面表示か */
  active(): boolean;
  request(): Promise<void>;
};

export type ViewportFitEnv = {
  /** visualViewportがないブラウザではnull（CSSの既定の高さのまま） */
  viewport: VisualViewportLike | null;
  setVar(name: string, value: string): void;
  /** タップを受け取る対象（document） */
  tapTarget: {
    addEventListener(type: "click", listener: () => void, options: { capture: true }): void;
    removeEventListener(type: "click", listener: () => void, options: { capture: true }): void;
  };
  fullscreen: FullscreenLike;
};

export class ViewportFit {
  private bottomInsetPx = 0;
  private readonly onViewport = () => this.update();
  private readonly onTap = () => this.enterFullscreen();

  constructor(private readonly env: ViewportFitEnv) {}

  /** 見えている範囲への追従と、全画面表示の待ち受けを始める。 */
  start(): void {
    this.env.viewport?.addEventListener("resize", this.onViewport);
    this.env.viewport?.addEventListener("scroll", this.onViewport);
    if (!this.env.fullscreen.installed() && this.env.fullscreen.enabled()) {
      this.env.tapTarget.addEventListener("click", this.onTap, { capture: true });
    }
    this.update();
  }

  stop(): void {
    this.env.viewport?.removeEventListener("resize", this.onViewport);
    this.env.viewport?.removeEventListener("scroll", this.onViewport);
    this.env.tapTarget.removeEventListener("click", this.onTap, { capture: true });
  }

  /** 設定の下部マージンを反映する。 */
  setBottomInset(px: number): void {
    this.bottomInsetPx = px;
    this.update();
  }

  update(): void {
    const vv = this.env.viewport;
    if (!vv) return;
    const box = fitBox(vv, this.bottomInsetPx);
    this.env.setVar(VIEWPORT_VARS.height, `${box.heightPx}px`);
    this.env.setVar(VIEWPORT_VARS.top, `${box.topPx}px`);
  }

  /** タップのたびに、全画面表示でなければ全画面にする（来場者が戻る操作で抜けても、次のタップで戻す）。 */
  private enterFullscreen(): void {
    const fs = this.env.fullscreen;
    if (fs.active()) return;
    // 断られても（ユーザーの操作と見なされなかった等）、次のタップでやり直す。
    fs.request().catch(() => {});
  }
}

/** ブラウザの部品で組み立てる。 */
export function browserViewportFit(): ViewportFit {
  const root = document.documentElement;
  const installed = () =>
    ["fullscreen", "standalone"].some((mode) => matchMedia(`(display-mode: ${mode})`).matches);
  return new ViewportFit({
    viewport: window.visualViewport,
    setVar: (name, value) => root.style.setProperty(name, value),
    tapTarget: document,
    fullscreen: {
      installed,
      enabled: () => document.fullscreenEnabled === true,
      active: () => document.fullscreenElement !== null,
      request: () => root.requestFullscreen({ navigationUI: "hide" }),
    },
  });
}
