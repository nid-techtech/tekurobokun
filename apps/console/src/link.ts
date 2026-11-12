// Link：バックエンドとのWebSocketの接続と自動再接続（imple 3節）。
// つながるたびにhelloで端末名を名乗る。

import { type ConsoleMessage, parseServerMessage, type ServerMessage } from "@tekurobokun/protocol";

export const WS_PATH = "/ws";

export type LinkHandlers = {
  onMessage: (message: ServerMessage) => void;
  onOpen: () => void;
  onClose: () => void;
};

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 5000;

export class Link {
  private ws: WebSocket | null = null;
  private retryMs = RETRY_MIN_MS;

  constructor(
    private readonly url: string,
    private readonly device: string,
    private readonly handlers: LinkHandlers,
  ) {}

  /** 入力ページを配信しているホストの/wsにつなぐ。 */
  static urlFor(location: Location): string {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}${WS_PATH}`;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = RETRY_MIN_MS;
      this.send({ type: "hello", role: "console", device: this.device });
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
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    };
    // onerrorのあとには必ずoncloseが来るので、再接続はoncloseに任せる。
  }

  send(message: ConsoleMessage): boolean {
    if (!this.connected || !this.ws) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }
}
