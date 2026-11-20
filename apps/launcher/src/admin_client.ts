// AdminClient（imple 3節）：backendの管理用API（127.0.0.1:8788）の呼び出しと、/admin/events の購読。
// HTTPはRust（admin_request）を通す（WebViewのfetchではCORSに当たるため）。テストでは差し替える。
// /admin/events はWebSocketで購読し、切れたら間隔を広げながら再接続する（backendの起動前・再起動中も）。

import {
  ADMIN_PATHS,
  type AdminEventMessage,
  type AdminStatus,
  type InputSource,
  type LlmAlias,
  type PairingCode,
  parseAdminEvent,
  parsePairingCode,
} from "@tekurobokun/protocol";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";
export type AdminTransport = (
  method: HttpMethod,
  path: string,
  body?: string,
) => Promise<{ status: number; body: string }>;

/** WebSocketのうち使うところ（テストで差し替える）。 */
export type SocketLike = {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  close(): void;
};
export type SocketFactory = (url: string) => SocketLike;

/** ブラウザのWebSocketをSocketLikeとして使う。 */
export function browserSocket(url: string): SocketLike {
  const ws = new WebSocket(url);
  const socket: SocketLike = {
    onopen: null,
    onmessage: null,
    onclose: null,
    close: () => ws.close(),
  };
  ws.onopen = () => socket.onopen?.();
  ws.onmessage = (event) => socket.onmessage?.(event);
  ws.onclose = () => socket.onclose?.();
  return socket;
}

export type AdminHandlers = {
  onStatus: (status: AdminStatus) => void;
  onEvent: (event: AdminEventMessage) => void;
  /** 購読がつながった（最初のstatusを受けた）・切れた */
  onConnection: (connected: boolean) => void;
};

export class AdminError extends Error {}

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 5000;

export type AdminClientOptions = {
  port: number;
  transport: AdminTransport;
  socket: SocketFactory;
  handlers: AdminHandlers;
  retryMinMs?: number;
  retryMaxMs?: number;
  schedule?: (fn: () => void, ms: number) => void;
};

export class AdminClient {
  private ws: SocketLike | null = null;
  private retryMs: number;
  private stopped = false;
  private isConnected = false;
  private readonly schedule: (fn: () => void, ms: number) => void;

  constructor(private readonly options: AdminClientOptions) {
    this.retryMs = options.retryMinMs ?? RETRY_MIN_MS;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  }

  get connected(): boolean {
    return this.isConnected;
  }

  get eventsUrl(): string {
    return `ws://127.0.0.1:${this.options.port}${ADMIN_PATHS.events}`;
  }

  // ===== HTTP =====

  private async call(method: HttpMethod, path: string, body?: unknown): Promise<string> {
    let res: { status: number; body: string };
    try {
      res = await this.options.transport(
        method,
        path,
        body === undefined ? undefined : JSON.stringify(body),
      );
    } catch (e) {
      throw new AdminError(e instanceof Error ? e.message : String(e));
    }
    if (res.status < 200 || res.status >= 300) {
      throw new AdminError(`${method} ${path}: ${res.status} ${res.body}`);
    }
    return res.body;
  }

  async issueCode(): Promise<PairingCode> {
    const code = parsePairingCode(await this.call("POST", ADMIN_PATHS.pairingCodes));
    if (!code) throw new AdminError("unexpected response from /admin/pairing-codes");
    return code;
  }

  async revoke(id: string): Promise<void> {
    await this.call("DELETE", `${ADMIN_PATHS.devices}/${encodeURIComponent(id)}`);
  }

  async setInputSource(source: InputSource): Promise<void> {
    await this.call("PUT", ADMIN_PATHS.inputSource, { source });
  }

  async setMic(paused: boolean): Promise<void> {
    await this.call("PUT", ADMIN_PATHS.mic, { paused });
  }

  async reset(): Promise<void> {
    await this.call("POST", ADMIN_PATHS.reset);
  }

  async setLlmModel(alias: LlmAlias): Promise<void> {
    await this.call("PUT", ADMIN_PATHS.llmModel, { alias });
  }

  // ===== /admin/events =====

  /** 購読を始める（切れたら再接続を続ける）。 */
  connect(): void {
    this.stopped = false;
    this.open();
  }

  /** 購読をやめる（再接続しない）。 */
  close(): void {
    this.stopped = true;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setConnected(false);
  }

  private open(): void {
    let ws: SocketLike;
    try {
      ws = this.options.socket(this.eventsUrl);
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;
    ws.onmessage = (event) => {
      if (this.ws !== ws || typeof event.data !== "string") return;
      const message = parseAdminEvent(event.data);
      if (!message) return;
      if (message.type === "status") {
        const { type: _, ...status } = message;
        this.retryMs = this.options.retryMinMs ?? RETRY_MIN_MS;
        this.setConnected(true);
        this.options.handlers.onStatus(status);
      } else {
        this.options.handlers.onEvent(message);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setConnected(false);
      this.retry();
    };
    // onerrorのあとには必ずoncloseが来るので、再接続はoncloseに任せる。
  }

  private retry(): void {
    if (this.stopped) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, this.options.retryMaxMs ?? RETRY_MAX_MS);
    this.schedule(() => {
      if (!this.stopped && this.ws === null) this.open();
    }, wait);
  }

  private setConnected(connected: boolean): void {
    if (this.isConnected === connected) return;
    this.isConnected = connected;
    this.options.handlers.onConnection(connected);
  }
}
