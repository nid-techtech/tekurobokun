// Server：Bun.serveで、入力ページ（apps/consoleのビルド成果物）の配信とWebSocketを受け持つ（imple 3節）。
// 待ち受け先は設定のhost（本番は127.0.0.1。cloudflaredがlocalhost:8787へつなぐ）。
// 接続ごとに、登録済みの端末かどうか・役割（console・robot）を覚え、メッセージをConversationSessionへ渡し、配信する。
//
// 登録とトークン（imple 3節・4節）：
// - helloのトークンをDeviceAuthで確かめる。通れば以後の会話のメッセージを受け付け、welcome・statusを送る
// - トークンがない・無効・無効化済みなら、auth_requiredを送り、helloとpair以外を捨てる（接続は切らない）
// - pairは登録コードをトークンと交換する。接続元はCF-Connecting-IPヘッダー、なければ接続のアドレス
// - 無効化した端末の接続は切る（disconnectDevice）

import { resolve, sep } from "node:path";
import {
  type BroadcastMessage,
  type ConsoleSettings,
  type DeviceRole,
  type PairMessage,
  parseClientMessage,
  type ServerMessage,
  type SpeechMessage,
} from "@tekurobokun/protocol";
import type { Server as BunServer, ServerWebSocket } from "bun";
import type { DeviceAuth, DeviceRecord } from "./device_auth.ts";
import type { HealthMonitor } from "./health.ts";
import type { ConversationSession } from "./session.ts";

export const WS_PATH = "/ws";
const TOPIC_ALL = "all";
const TOPIC_ROBOT = "robot";
/** 無効化で切るときのWebSocketのclose code（アプリ用の範囲） */
export const CLOSE_REVOKED = 4001;

type WsData = {
  /** 登録済みと確かめた役割。確かめるまではnull */
  role: DeviceRole | null;
  /** consoleの名前（robotは空） */
  device: string;
  /** 登録済みの端末のid。確かめるまではnull */
  deviceId: string | null;
  /** 接続元（失敗の制限に使う） */
  origin: string;
};

export type ServerOptions = {
  /** 公開用ポートの待ち受け先 */
  host?: string;
  port: number;
  /** 入力ページのビルド成果物のディレクトリ */
  staticDir: string;
  settings: ConsoleSettings;
  health: HealthMonitor;
  auth: DeviceAuth;
  /** 登録できたとき（管理用APIのできごと） */
  onPaired?: (device: DeviceRecord) => void;
  /** 登録済みの端末の接続・切断（管理用APIの状態の更新） */
  onConnectionsChanged?: () => void;
  log?: (line: string) => void;
};

/** 接続元：CF-Connecting-IP（cloudflaredが付ける）、なければ接続のアドレス。 */
export function originOf(req: Request, address: string | undefined): string {
  return req.headers.get("cf-connecting-ip")?.trim() || address || "unknown";
}

/** 静的ファイルの応答。ディレクトリの外は返さない。 */
async function serveStatic(staticDir: string, pathname: string): Promise<Response> {
  const root = resolve(staticDir);
  const rel = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const path = resolve(root, `.${rel}`);
  if (path !== root && !path.startsWith(root + sep))
    return new Response("Not Found", { status: 404 });
  const file = Bun.file(path);
  if (await file.exists()) return new Response(file);
  if (!(await Bun.file(resolve(root, "index.html")).exists())) {
    return new Response(
      "The console is not built. Run: bun run --filter @tekurobokun/console build",
      { status: 503 },
    );
  }
  return new Response("Not Found", { status: 404 });
}

export class Server {
  private server: BunServer<WsData> | null = null;
  private session: ConversationSession | null = null;
  private readonly robots = new Set<ServerWebSocket<WsData>>();
  /** 登録済みと確かめた接続 */
  private readonly authed = new Set<ServerWebSocket<WsData>>();
  private readonly log: (line: string) => void;

  constructor(private readonly options: ServerOptions) {
    this.log = options.log ?? (() => {});
  }

  /** 会話のセッションをつなぐ（セッションは配信の関数としてbroadcastを受け取るため、あとからつなぐ）。 */
  attach(session: ConversationSession): void {
    this.session = session;
  }

  get port(): number {
    return this.server?.port ?? this.options.port;
  }

  start(): void {
    const { staticDir } = this.options;
    this.server = Bun.serve({
      hostname: this.options.host,
      port: this.options.port,
      fetch: (req, server) => {
        const url = new URL(req.url);
        if (url.pathname === WS_PATH) {
          const origin = originOf(req, server.requestIP(req)?.address);
          const data: WsData = { role: null, device: "", deviceId: null, origin };
          return server.upgrade(req, { data })
            ? undefined
            : new Response("Expected a WebSocket", { status: 400 });
        }
        if (req.method !== "GET" && req.method !== "HEAD") {
          return new Response("Method Not Allowed", { status: 405 });
        }
        return serveStatic(staticDir, url.pathname);
      },
      websocket: {
        data: {} as WsData,
        message: (ws, message) => {
          if (typeof message !== "string") return;
          this.onMessage(ws, message);
        },
        close: (ws) => {
          if (this.robots.delete(ws) && this.robots.size === 0) {
            // 話し中なら先に待機中へ戻し、health.robotの変化で配信するstatusに反映させる。
            this.session?.robotDisconnected();
            this.options.health.setRobot(false);
          }
          if (this.authed.delete(ws)) {
            this.log(`${ws.data.role} disconnected ${ws.data.device}`.trim());
            this.options.onConnectionsChanged?.();
          }
        },
      },
    });
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  /** その端末がいまつながっているか。 */
  isConnected(deviceId: string): boolean {
    for (const ws of this.authed) if (ws.data.deviceId === deviceId) return true;
    return false;
  }

  /** 無効化した端末の接続を切る。端末は再接続し、auth_required（revoked）を受け取る。 */
  disconnectDevice(deviceId: string): void {
    for (const ws of [...this.authed]) {
      if (ws.data.deviceId === deviceId) ws.close(CLOSE_REVOKED, "revoked");
    }
  }

  /** 登録済みの入力ページと機体の両方に配信する。 */
  broadcast(message: BroadcastMessage): void {
    this.server?.publish(TOPIC_ALL, JSON.stringify(message));
  }

  /** 登録済みの機体にだけ送る（音声）。 */
  sendToRobot(message: SpeechMessage): void {
    this.server?.publish(TOPIC_ROBOT, JSON.stringify(message));
  }

  private send(ws: ServerWebSocket<WsData>, message: ServerMessage): void {
    ws.send(JSON.stringify(message));
  }

  private onMessage(ws: ServerWebSocket<WsData>, raw: string): void {
    const session = this.session;
    const message = parseClientMessage(raw);
    if (!message || !session) return;

    if (message.type === "hello") {
      if (ws.data.role) return; // 名乗り直しは受け付けない
      const result = this.options.auth.verify(message.token);
      // 役割と名前は登録したときのもの。名乗った役割・名前と違うトークンは通さない。
      const name = message.role === "console" ? message.device : "";
      if (
        !result.ok ||
        result.device.role !== message.role ||
        (message.role === "console" && result.device.name !== name)
      ) {
        this.send(ws, { type: "auth_required", reason: result.ok ? "invalid" : result.reason });
        return;
      }
      ws.data.role = message.role;
      ws.data.device = name;
      ws.data.deviceId = result.device.id;
      this.authed.add(ws);
      ws.subscribe(TOPIC_ALL);
      if (message.role === "robot") {
        ws.subscribe(TOPIC_ROBOT);
        this.robots.add(ws);
      }
      this.log(`${message.role} connected ${ws.data.device}`.trim());
      this.send(ws, {
        type: "welcome",
        settings: this.options.settings,
        history: session.history(),
      });
      this.send(ws, session.status());
      // 機体の接続でhealth.robotが変わると、HealthMonitorの通知で全員にstatusが届く。
      if (message.role === "robot") this.options.health.setRobot(true);
      this.options.onConnectionsChanged?.();
      return;
    }

    if (message.type === "pair") {
      if (!ws.data.role) void this.pair(ws, message);
      return;
    }

    // ここから先は、登録済みの接続だけ
    if (!ws.data.role) return;
    if (message.type === "utterance" && ws.data.role === "console") {
      void session.handleUtterance(ws.data.device, message.text);
    }
    if (message.type === "playback_done" && ws.data.role === "robot") {
      session.handlePlaybackDone(message.turnId, message.index);
    }
  }

  /** 登録コードをトークンと交換する。成功したら、端末はそのトークンでhelloを送り直す。 */
  private async pair(ws: ServerWebSocket<WsData>, message: PairMessage): Promise<void> {
    const result = await this.options.auth.pair({
      role: message.role,
      device: message.device,
      code: message.code,
      origin: ws.data.origin,
    });
    if (!result.ok) {
      this.log(`pairing failed from ${ws.data.origin}: ${result.reason}`);
      this.send(ws, { type: "pair_failed", reason: result.reason });
      return;
    }
    this.send(ws, { type: "paired", token: result.token });
    this.options.onPaired?.(result.device);
  }
}
