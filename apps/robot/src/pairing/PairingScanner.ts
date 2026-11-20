// PairingScanner：登録の画面（S02g）。トークンがない・無効なとき、カメラの映像を全面に出し、
// QRを合わせる枠を描いて、一定間隔でQRを探す（imple 3節）。
// 見つけた登録のQR（公開URLとコード）はonCodeで渡す。登録の送信と結果の表示はmain.tsとRobotLinkが受け持つ。
// 字幕の行（モックのy=0〜40）は空けて、その下にカメラの映像を出す（キャンバス800×600の上に重ねる）。
// カメラが使えないときは、映像の代わりの面と枠だけを出し、間をおいてやり直す。

import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { prepareQrReader, readPairingQr } from "./qrReader";

const SVG_NS = "http://www.w3.org/2000/svg";
/** キャンバスの大きさと、カメラの映像を出す範囲（モックのcamBox(0, 40, 800, 560)） */
const CANVAS = { w: 800, h: 600 };
const CAM = { x: 0, y: 40, w: 800, h: 560 };
/** 枠は映像の短い辺の6割の正方形（モック） */
const GUIDE = Math.min(CAM.w, CAM.h) * 0.6;
/** QRを探すときの画像の幅の上限（Core m7で重くしすぎないため） */
const SCAN_MAX_WIDTH = 640;
const CAMERA_RETRY_MS = 5000;

export type PairingScannerOptions = {
  intervalMs: number;
  onCode: (result: { publicUrl: string; code: string }) => void;
};

export class PairingScanner {
  private readonly el: HTMLDivElement;
  private readonly video: HTMLVideoElement;
  private readonly frame: HTMLCanvasElement;
  private stream: MediaStream | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private busy = false;

  constructor(
    root: HTMLElement,
    private readonly options: PairingScannerOptions,
  ) {
    prepareQrReader({
      locateFile: (path: string, prefix: string) =>
        path.endsWith(".wasm") ? wasmUrl : prefix + path,
    });

    this.el = document.createElement("div");
    this.el.id = "pairing-scanner";
    this.el.hidden = true;
    this.el.style.width = `${CANVAS.w}px`;
    this.el.style.height = `${CANVAS.h}px`;

    this.video = document.createElement("video");
    this.video.className = "pairing-camera";
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.style.left = `${CAM.x}px`;
    this.video.style.top = `${CAM.y}px`;
    this.video.style.width = `${CAM.w}px`;
    this.video.style.height = `${CAM.h}px`;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "pairing-guide");
    svg.setAttribute("viewBox", `0 0 ${CANVAS.w} ${CANVAS.h}`);
    svg.setAttribute("aria-hidden", "true");
    const frame = document.createElementNS(SVG_NS, "rect");
    frame.setAttribute("class", "pairing-frame");
    frame.setAttribute("x", String(CAM.x));
    frame.setAttribute("y", String(CAM.y));
    frame.setAttribute("width", String(CAM.w));
    frame.setAttribute("height", String(CAM.h));
    frame.setAttribute("stroke-width", "2");
    svg.appendChild(frame);
    const guide = document.createElementNS(SVG_NS, "rect");
    guide.setAttribute("x", String(CAM.x + (CAM.w - GUIDE) / 2));
    guide.setAttribute("y", String(CAM.y + (CAM.h - GUIDE) / 2));
    guide.setAttribute("width", String(GUIDE));
    guide.setAttribute("height", String(GUIDE));
    guide.setAttribute("stroke-width", "6");
    guide.setAttribute("stroke-dasharray", "24 12");
    svg.appendChild(guide);

    this.frame = document.createElement("canvas");
    this.el.append(this.video, svg);
    root.appendChild(this.el);
  }

  get active(): boolean {
    return this.running;
  }

  /** カメラを開き、QRを探し始める。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.el.hidden = false;
    void this.openCamera();
    this.schedule();
  }

  /** 探すのをやめ、カメラを閉じる（登録できたら、カメラは使わない）。 */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.el.hidden = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.video.srcObject = null;
  }

  private async openCamera(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      if (!this.running) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play();
    } catch (e) {
      console.warn("[pairing] camera unavailable", e);
      if (this.running)
        setTimeout(() => this.running && !this.stream && void this.openCamera(), CAMERA_RETRY_MS);
    }
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.scan().finally(() => this.schedule());
    }, this.options.intervalMs);
  }

  private async scan(): Promise<void> {
    const { videoWidth: w, videoHeight: h } = this.video;
    if (this.busy || !this.stream || w === 0 || h === 0) return;
    this.busy = true;
    try {
      const scale = Math.min(1, SCAN_MAX_WIDTH / w);
      this.frame.width = Math.round(w * scale);
      this.frame.height = Math.round(h * scale);
      const ctx = this.frame.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(this.video, 0, 0, this.frame.width, this.frame.height);
      const image = ctx.getImageData(0, 0, this.frame.width, this.frame.height);
      const result = await readPairingQr(image);
      if (result && this.running) this.options.onCode(result);
    } catch (e) {
      console.warn("[pairing] scan failed", e);
    } finally {
      this.busy = false;
    }
  }
}
