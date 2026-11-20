// AdminApi：管理用API（imple 3節・4節）。127.0.0.1だけで待ち受け、トンネルには載せない。
// HTTPのJSONと、状態とできごとを流すWebSocket（/admin/events）。
//
// 受け持つのは、状態・登録コードの発行・端末の無効化・入力元の切り替え・マイクの一時停止と再開・できごと。
// 会話のリセットとモデルの別名（Phase 8）は、それぞれの項目で足す。
// 入力元とマイクのできごと（input_source・mic）は、どこから切り替えても出るよう、
// InputSourceRegistryの通知から出す（index.ts）。ここでは切り替えるだけ。
//
// ブラウザからの不正な呼び出し（DNSリバインディング・別のサイトからの要求）を防ぐため、
// Hostが127.0.0.1・localhostでない要求と、Originが手元（localhost系）でない要求は断る。

import {
  ADMIN_PATHS,
  type AdminEvent,
  type AdminEventKind,
  type AdminStatus,
  type PairingCode,
  pairingQrText,
  parseInputSourceRequest,
  parseMicRequest,
} from "@tekurobokun/protocol";
import type { Server as BunServer, ServerWebSocket } from "bun";
import type { DeviceAuth } from "./device_auth.ts";
import { toJstIso } from "./time.ts";

export const ADMIN_HOST = "127.0.0.1";
const TOPIC_EVENTS = "events";
const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "tauri.localhost"]);

export type AdminApiOptions = {
  port: number;
  auth: DeviceAuth;
  /** QRに入れる公開URL */
  publicUrl: string;
  /** いまの状態（session・入力元・health・端末など） */
  status: () => AdminStatus;
  /** 端末を無効にしたあと、その端末の接続を切る */
  onRevoked?: (id: string) => void;
  /** 入力元とマイクの切り替え（InputSourceRegistry） */
  sources: {
    /** 一覧にない入力元ならfalse */
    setActive(source: string): boolean;
    setMicPaused(paused: boolean): void;
  };
  now?: () => Date;
  log?: (line: string) => void;
};

const json = (body: unknown, status = 200) => Response.json(body, { status });
const error = (status: number, message: string) => json({ error: message }, status);
const noContent = () => new Response(null, { status: 204 });

/** 本文のJSON。読めなければnull。 */
async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/** Host・Originが手元のものか。 */
export function isLocalRequest(req: Request): boolean {
  const host = req.headers.get("host");
  if (host === null) return false;
  const hostname = host.replace(/:\d+$/, "");
  if (!LOCAL_HOSTNAMES.has(hostname)) return false;
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  try {
    return LOCAL_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export class AdminApi {
  private server: BunServer<undefined> | null = null;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(private readonly options: AdminApiOptions) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  get port(): number {
    return this.server?.port ?? this.options.port;
  }

  start(): void {
    this.server = Bun.serve<undefined>({
      hostname: ADMIN_HOST,
      port: this.options.port,
      fetch: (req, server) => this.handle(req, server),
      websocket: {
        open: (ws: ServerWebSocket<undefined>) => {
          ws.subscribe(TOPIC_EVENTS);
          ws.send(JSON.stringify(this.statusEvent()));
        },
        message: () => {},
      },
    });
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  /** できごとを流す。 */
  event(kind: AdminEventKind, detail = ""): void {
    this.publish({ type: "event", at: toJstIso(this.now()), kind, detail });
  }

  /** 状態を流す（変わったとき）。 */
  publishStatus(): void {
    this.publish(this.statusEvent());
  }

  private statusEvent(): AdminEvent {
    return { type: "status", ...this.options.status() };
  }

  private publish(event: AdminEvent): void {
    this.server?.publish(TOPIC_EVENTS, JSON.stringify(event));
  }

  private async handle(req: Request, server: BunServer<undefined>): Promise<Response | undefined> {
    if (!isLocalRequest(req)) return error(403, "forbidden");
    const { pathname } = new URL(req.url);
    const method = req.method;

    if (pathname === ADMIN_PATHS.events) {
      return server.upgrade(req, { data: undefined })
        ? undefined
        : error(400, "expected a WebSocket");
    }
    if (pathname === ADMIN_PATHS.status) {
      return method === "GET" ? json(this.options.status()) : error(405, "method not allowed");
    }
    if (pathname === ADMIN_PATHS.pairingCodes) {
      if (method !== "POST") return error(405, "method not allowed");
      const { code, expiresAt } = this.options.auth.issueCode();
      const body: PairingCode = {
        code,
        expiresAt: toJstIso(expiresAt),
        qr: pairingQrText(this.options.publicUrl, code),
      };
      this.log(`pairing code issued (expires ${body.expiresAt})`);
      return json(body, 201);
    }
    if (pathname === ADMIN_PATHS.inputSource) {
      if (method !== "PUT") return error(405, "method not allowed");
      const body = parseInputSourceRequest(await readJson(req));
      if (!body) return error(400, "expected { source: string }");
      if (!this.options.sources.setActive(body.source)) return error(400, "no such input source");
      return noContent();
    }
    if (pathname === ADMIN_PATHS.mic) {
      if (method !== "PUT") return error(405, "method not allowed");
      const body = parseMicRequest(await readJson(req));
      if (!body) return error(400, "expected { paused: boolean }");
      this.options.sources.setMicPaused(body.paused);
      return noContent();
    }
    const prefix = `${ADMIN_PATHS.devices}/`;
    if (pathname.startsWith(prefix)) {
      if (method !== "DELETE") return error(405, "method not allowed");
      const id = decodeURIComponent(pathname.slice(prefix.length));
      if (!(await this.options.auth.revoke(id))) return error(404, "no such device");
      this.options.onRevoked?.(id);
      this.event("unpaired", id);
      this.publishStatus();
      return noContent();
    }
    return error(404, "not found");
  }
}
