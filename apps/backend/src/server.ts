// Server：Bun.serveで、入力ページ（apps/consoleのビルド成果物）の配信とWebSocketを受け持つ（imple 3節）。
// 接続ごとに役割（console・robot）を覚え、メッセージをConversationSessionへ渡し、配信する。

import { resolve, sep } from "node:path";
import {
  type BroadcastMessage,
  type ConsoleSettings,
  parseClientMessage,
  type ServerMessage,
  type SpeechMessage,
} from "@tekurobokun/protocol";
import type { Server as BunServer, ServerWebSocket } from "bun";
import type { HealthMonitor } from "./health.ts";
import type { ConversationSession } from "./session.ts";

export const WS_PATH = "/ws";
const TOPIC_ALL = "all";
const TOPIC_ROBOT = "robot";

type WsData = { role: "console" | "robot" | null; device: string };

export type ServerOptions = {
  port: number;
  /** 入力ページのビルド成果物のディレクトリ */
  staticDir: string;
  settings: ConsoleSettings;
  health: HealthMonitor;
  log?: (line: string) => void;
};

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
      port: this.options.port,
      fetch: (req, server) => {
        const url = new URL(req.url);
        if (url.pathname === WS_PATH) {
          const data: WsData = { role: null, device: "" };
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
          if (this.robots.delete(ws)) this.options.health.setRobot(this.robots.size > 0);
          if (ws.data.role) this.log(`${ws.data.role} disconnected ${ws.data.device}`.trim());
        },
      },
    });
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  /** 入力ページと機体の両方に配信する。 */
  broadcast(message: BroadcastMessage): void {
    this.server?.publish(TOPIC_ALL, JSON.stringify(message));
  }

  /** 機体にだけ送る（Phase 3の音声）。 */
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
      ws.data.role = message.role;
      ws.data.device = message.role === "console" ? message.device : "";
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
      return;
    }

    if (message.type === "utterance" && ws.data.role === "console") {
      void session.handleUtterance(ws.data.device, message.text);
    }
    // playback_doneはPhase 3で扱う。
  }
}
