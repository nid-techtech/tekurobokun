// RobotLink：バックエンドとのWebSocketの接続と自動再接続（imple 3節）。
// つながるたびにhelloで機体として名乗る。受け取ったメッセージは検証してから渡す。

import { parseServerMessage, type RobotMessage, type ServerMessage } from "@tekurobokun/protocol";

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
  private readonly createSocket: (url: string) => SocketLike;
  private readonly setTimer: (fn: () => void, ms: number) => void;

  constructor(
    private readonly url: string,
    private readonly handlers: RobotLinkHandlers,
    options: RobotLinkOptions = {},
  ) {
    this.createSocket = options.createSocket ?? ((u) => new WebSocket(u));
    this.setTimer = options.setTimer ?? ((fn, ms) => void setTimeout(fn, ms));
  }

  get connected(): boolean {
    return this.ws?.readyState === OPEN;
  }

  connect(): void {
    let ws: SocketLike;
    try {
      ws = this.createSocket(this.url);
    } catch (e) {
      // URLが不正なときなど。設定の誤りに気づけるよう出して、間をおいてやり直す。
      console.error("[link] cannot open", this.url, e);
      this.retryLater();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = RETRY_MIN_MS;
      this.send({ type: "hello", role: "robot" });
      this.handlers.onOpen();
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const message = parseServerMessage(event.data);
      if (message) this.handlers.onMessage(message);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.handlers.onClose();
      this.retryLater();
    };
    // onerrorのあとには必ずoncloseが来るので、再接続はoncloseに任せる。
  }

  send(message: RobotMessage): boolean {
    if (!this.connected || !this.ws) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  private retryLater(): void {
    this.setTimer(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
  }
}
