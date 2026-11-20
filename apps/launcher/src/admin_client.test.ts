import { describe, expect, test } from "bun:test";
import type { AdminEventMessage, AdminStatus } from "@tekurobokun/protocol";
import {
  AdminClient,
  AdminError,
  type AdminTransport,
  type HttpMethod,
  type SocketLike,
} from "./admin_client.ts";

const STATUS: AdminStatus = {
  session: "idle",
  inputSource: "robot",
  micPaused: false,
  health: { backend: true, llm: true, tts: true, stt: true, robot: false },
  llmModel: "main",
  searchCount: { month: "2026-11", count: 12 },
  devices: [],
  publicUrl: "https://tekurobo.example.com",
};

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  close(): void {
    this.closed = true;
  }
  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(): void {
    this.onclose?.();
  }
}

function setup(transport: AdminTransport = async () => ({ status: 204, body: "" })) {
  const sockets: FakeSocket[] = [];
  const scheduled: { fn: () => void; ms: number }[] = [];
  const statuses: AdminStatus[] = [];
  const events: AdminEventMessage[] = [];
  const connection: boolean[] = [];
  const client = new AdminClient({
    port: 8788,
    transport,
    socket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    handlers: {
      onStatus: (s) => statuses.push(s),
      onEvent: (e) => events.push(e),
      onConnection: (c) => connection.push(c),
    },
    schedule: (fn, ms) => scheduled.push({ fn, ms }),
  });
  return { client, sockets, scheduled, statuses, events, connection };
}

describe("AdminClient：HTTP", () => {
  test("各操作は決まったメソッド・パス・本文で呼ぶ", async () => {
    const calls: [HttpMethod, string, string | undefined][] = [];
    const { client } = setup(async (method, path, body) => {
      calls.push([method, path, body]);
      return { status: 204, body: "" };
    });
    await client.setInputSource("phone");
    await client.setMic(true);
    await client.reset();
    await client.setLlmModel("sub");
    await client.revoke("dev 1");
    expect(calls).toEqual([
      ["PUT", "/admin/input-source", '{"source":"phone"}'],
      ["PUT", "/admin/mic", '{"paused":true}'],
      ["POST", "/admin/reset", undefined],
      ["PUT", "/admin/llm-model", '{"alias":"sub"}'],
      ["DELETE", "/admin/devices/dev%201", undefined],
    ]);
  });

  test("登録コードの応答を検証して返す", async () => {
    const body = {
      code: "K7QM-4X2P",
      expiresAt: "2026-11-21T13:02:00+09:00",
      qr: "x/pair#K7QM-4X2P",
    };
    const { client } = setup(async () => ({ status: 201, body: JSON.stringify(body) }));
    expect(await client.issueCode()).toEqual(body);
  });

  test("200番台でない・つながらないときはAdminError", async () => {
    const bad = setup(async () => ({ status: 404, body: '{"error":"no such device"}' }));
    await expect(bad.client.revoke("x")).rejects.toBeInstanceOf(AdminError);
    const down = setup(async () => {
      throw new Error("connection refused");
    });
    await expect(down.client.reset()).rejects.toBeInstanceOf(AdminError);
    const broken = setup(async () => ({ status: 201, body: "{}" }));
    await expect(broken.client.issueCode()).rejects.toBeInstanceOf(AdminError);
  });
});

describe("AdminClient：/admin/events", () => {
  test("statusを受けたらつながったとみなし、状態とできごとを渡す", () => {
    const { client, sockets, statuses, events, connection } = setup();
    client.connect();
    expect(sockets[0]?.url).toBe("ws://127.0.0.1:8788/admin/events");
    expect(client.connected).toBe(false);
    sockets[0]?.receive({ type: "status", ...STATUS });
    expect(client.connected).toBe(true);
    expect(statuses).toEqual([STATUS]);
    sockets[0]?.receive({
      type: "event",
      at: "2026-11-21T13:02:58+09:00",
      kind: "paired",
      detail: "robot robot abc",
    });
    sockets[0]?.receive({ type: "event", kind: "nonsense" });
    expect(events.map((e) => e.kind)).toEqual(["paired"]);
    expect(connection).toEqual([true]);
  });

  test("切れたら間隔を広げながら再接続し、つながったら間隔を戻す", () => {
    const { client, sockets, scheduled, connection } = setup();
    client.connect();
    sockets[0]?.receive({ type: "status", ...STATUS });
    sockets[0]?.drop();
    expect(client.connected).toBe(false);
    expect(connection).toEqual([true, false]);
    expect(scheduled.map((s) => s.ms)).toEqual([1000]);
    scheduled[0]?.fn();
    sockets[1]?.drop();
    scheduled[1]?.fn();
    sockets[2]?.drop();
    scheduled[2]?.fn();
    sockets[3]?.drop();
    scheduled[3]?.fn();
    sockets[4]?.drop();
    expect(scheduled.map((s) => s.ms)).toEqual([1000, 2000, 4000, 5000, 5000]);
    scheduled[4]?.fn();
    sockets[5]?.receive({ type: "status", ...STATUS });
    sockets[5]?.drop();
    expect(scheduled.at(-1)?.ms).toBe(1000);
  });

  test("closeしたら再接続しない", () => {
    const { client, sockets, scheduled } = setup();
    client.connect();
    client.close();
    expect(sockets[0]?.closed).toBe(true);
    sockets[0]?.drop();
    expect(scheduled).toEqual([]);
  });
});
