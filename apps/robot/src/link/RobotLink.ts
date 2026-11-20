// RobotLink：バックエンドとのWebSocketの接続と自動再接続（imple 3節）。
// つながるたびに、保存したトークンを付けたhelloで機体として名乗る。受け取ったメッセージは検証してから渡す。
//
// 登録（S02g）：QRから読んだ公開URLとコードでpairを送る。接続先が違えば、その接続先につなぎ直してから送る。
// pairedを受けたら、接続先とトークンを保存し、同じ接続でhelloを送り直す。
// 無効・無効化済みのトークンでauth_requiredを受けたら、トークンを消す（接続先は残す）。

import {
  parseServerMessage,
  type RobotMessage,
  type ServerMessage,
  wsUrlFor,
} from "@tekurobokun/protocol";
import type { RobotCredentials } from "./credentials";

export type RobotLinkHandlers = {
  onMessage: (message: ServerMessage) => void;
  onOpen: () => void;
  onClose: () => void;
};

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 5000;

/** WebSocketのうち、RobotLinkが使う部分（テストで差し替える）。 */
export type SocketLike = {
  readonly readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  send(data: string): void;
  close(): void;
};

export type RobotLinkOptions = {
  createSocket?: (url: string) => SocketLike;
  setTimer?: (fn: () => void, ms: number) => void;
};

const OPEN = 1;

export class RobotLink {
  private ws: SocketLike | null = null;
  private retryMs = RETRY_MIN_MS;
  /** 接続し直すたびに増やす（古い接続・古い再接続の予定を無視するため） */
  private generation = 0;
  /** いまつないでいる（つなごうとしている）接続先 */
  private currentUrl: string | null = null;
  /** 送るのを待っている登録コード（接続先が開いたら送る） */
  private pendingPair: { url: string; code: string } | null = null;
  /** 断られたコード。QRを見せ続けられても送り直さない（失敗の制限に数えられないよう） */
  private readonly rejectedCodes = new Set<string>();
  private readonly createSocket: (url: string) => SocketLike;
  private readonly setTimer: (fn: () => void, ms: number) => void;

  constructor(
    private readonly credentials: RobotCredentials,
    private readonly handlers: RobotLinkHandlers,
    options: RobotLinkOptions = {},
  ) {
    this.createSocket = options.createSocket ?? ((u) => new WebSocket(u));
    this.setTimer = options.setTimer ?? ((fn, ms) => void setTimeout(fn, ms));
  }

  get connected(): boolean {
    return this.ws?.readyState === OPEN;
  }

  /** いまの接続先（表示用） */
  get url(): string | null {
    return this.currentUrl;
  }

  /** 登録が済んでいるか（接続先とトークンがある）。なければ登録の画面（S02g）を出す。 */
  get paired(): boolean {
    return this.credentials.url() !== null && this.credentials.token() !== null;
  }

  /** 保存した接続先につなぐ。接続先がなければ何もしない（QRを読むのを待つ）。 */
  connect(): void {
    const url = this.credentials.url();
    if (url !== null) this.open(url);
  }

  /** QRから読んだ公開URLとコードで登録する。同じコードを送っている途中・断られたコードなら何もしない。 */
  pair(publicUrl: string, code: string): void {
    let url: string;
    try {
      url = wsUrlFor(publicUrl);
    } catch {
      return;
    }
    if (this.rejectedCodes.has(code)) return;
    if (this.pendingPair?.url === url && this.pendingPair.code === code) return;
    this.pendingPair = { url, code };
    if (this.currentUrl === url && this.connected) {
      this.sendPair();
      return;
    }
    if (this.currentUrl !== url) this.open(url);
  }

  send(message: RobotMessage): boolean {
    if (!this.connected || !this.ws) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  private open(url: string): void {
    const generation = ++this.generation;
    const previous = this.ws;
    this.ws = null;
    if (previous) {
      // 古い接続のoncloseで再接続しないよう、先に外してから閉じる。
      previous.onclose = null;
      previous.close();
    }
    this.currentUrl = url;
    let ws: SocketLike;
    try {
      ws = this.createSocket(url);
    } catch (e) {
      // URLが不正なときなど。設定の誤りに気づけるよう出して、間をおいてやり直す。
      console.error("[link] cannot open", url, e);
      this.retryLater(generation);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = RETRY_MIN_MS;
      this.hello();
      if (this.pendingPair?.url === this.currentUrl) this.sendPair();
      this.handlers.onOpen();
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const message = parseServerMessage(event.data);
      if (!message) return;
      this.handle(message);
      this.handlers.onMessage(message);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.handlers.onClose();
      this.retryLater(generation);
    };
    // onerrorのあとには必ずoncloseが来るので、再接続はoncloseに任せる。
  }

  private handle(message: ServerMessage): void {
    if (message.type === "paired" && this.currentUrl !== null) {
      this.credentials.save(this.currentUrl, message.token);
      this.pendingPair = null;
      this.rejectedCodes.clear();
      this.hello();
    }
    if (message.type === "pair_failed" && this.pendingPair) {
      this.rejectedCodes.add(this.pendingPair.code);
      this.pendingPair = null;
    }
    if (message.type === "auth_required" && message.reason !== "missing") {
      this.credentials.clearToken();
    }
  }

  /** トークンは、いまの接続先が保存した接続先と同じときだけ付ける。 */
  private hello(): void {
    const token = this.credentials.url() === this.currentUrl ? this.credentials.token() : null;
    this.send({ type: "hello", role: "robot", token });
  }

  private sendPair(): void {
    if (!this.pendingPair) return;
    this.send({ type: "pair", role: "robot", code: this.pendingPair.code });
  }

  private retryLater(generation: number): void {
    this.setTimer(() => {
      const url = this.currentUrl;
      if (generation === this.generation && url !== null) this.open(url);
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
  }
}
