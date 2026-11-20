import { afterEach, describe, expect, test } from "bun:test";
import {
  type AdminEvent,
  type AdminStatus,
  PAIRING_CODE_PATTERN,
  parseAdminEvent,
  parseAdminStatus,
  parsePairingCode,
} from "@tekurobokun/protocol";
import { AdminApi, isLocalRequest } from "./admin_api.ts";
import { DeviceAuth, MemoryDeviceStore } from "./device_auth.ts";
import { InputSourceRegistry } from "./input_sources.ts";

const pairing = { codeTtlMs: 60_000, maxFailures: 5, failureWindowMs: 60_000, lockMs: 300_000 };

function setup() {
  const auth = new DeviceAuth({ store: new MemoryDeviceStore(), pairing, consoles: ["tablet"] });
  const revoked: string[] = [];
  const sources = new InputSourceRegistry(["tablet"], "robot");
  const status = (): AdminStatus => ({
    session: "idle",
    inputSource: sources.active(),
    micPaused: sources.micPaused(),
    health: { backend: true, llm: true, tts: true, stt: true, robot: false },
    llmModel: "main",
    searchCount: { month: "2026-11", count: 0 },
    devices: auth.devices(),
    publicUrl: "http://192.168.0.10:8787",
  });
  const api = new AdminApi({
    port: 0,
    auth,
    publicUrl: "http://192.168.0.10:8787",
    status,
    onRevoked: (id) => revoked.push(id),
    sources,
  });
  api.start();
  const base = `http://127.0.0.1:${api.port}`;
  return { api, auth, revoked, base, sources };
}

let current: AdminApi | null = null;
afterEach(() => {
  current?.stop();
  current = null;
});

describe("isLocalRequest", () => {
  const req = (headers: Record<string, string>) =>
    new Request("http://127.0.0.1:8788/admin/status", { headers });

  test("Hostが127.0.0.1・localhostなら受け付ける", () => {
    expect(isLocalRequest(req({ host: "127.0.0.1:8788" }))).toBe(true);
    expect(isLocalRequest(req({ host: "localhost:8788" }))).toBe(true);
  });

  test("ほかのHost（DNSリバインディング）は断る", () => {
    expect(isLocalRequest(req({ host: "evil.example:8788" }))).toBe(false);
    expect(isLocalRequest(req({ host: "192.168.0.10:8788" }))).toBe(false);
  });

  test("Originが手元でなければ断る", () => {
    expect(isLocalRequest(req({ host: "127.0.0.1:8788", origin: "https://evil.example" }))).toBe(
      false,
    );
    expect(isLocalRequest(req({ host: "127.0.0.1:8788", origin: "http://tauri.localhost" }))).toBe(
      true,
    );
    expect(isLocalRequest(req({ host: "127.0.0.1:8788", origin: "null" }))).toBe(false);
  });
});

describe("AdminApi", () => {
  test("127.0.0.1で待ち受け、状態を返す", async () => {
    const { api, base } = setup();
    current = api;
    const res = await fetch(`${base}/admin/status`);
    expect(res.status).toBe(200);
    expect(parseAdminStatus(await res.json())).toMatchObject({ inputSource: "robot" });
  });

  test("登録コードを発行し、QRの中身に公開URLを入れる", async () => {
    const { api, base, auth } = setup();
    current = api;
    const res = await fetch(`${base}/admin/pairing-codes`, { method: "POST" });
    expect(res.status).toBe(201);
    const body = parsePairingCode(await res.json());
    expect(body?.code).toMatch(PAIRING_CODE_PATTERN);
    expect(body?.qr).toBe(`http://192.168.0.10:8787/pair#${body?.code}`);
    expect(body?.expiresAt).toMatch(/\+09:00$/);
    expect(auth.currentCode()?.code).toBe(body?.code);
  });

  test("端末を無効にし、接続を切る処理を呼ぶ。ないものは404", async () => {
    const { api, base, auth, revoked } = setup();
    current = api;
    const { code } = auth.issueCode();
    const paired = await auth.pair({ role: "robot", code, origin: "a" });
    if (!paired.ok) throw new Error(paired.reason);

    const res = await fetch(`${base}/admin/devices/${paired.device.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(revoked).toEqual([paired.device.id]);
    expect(auth.verify(paired.token)).toEqual({ ok: false, reason: "revoked" });

    const again = await fetch(`${base}/admin/devices/${paired.device.id}`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  test("入力元を切り替える。一覧にない入力元・形の違う本文は400", async () => {
    const { api, base, sources } = setup();
    current = api;
    const put = (body: string) =>
      fetch(`${base}/admin/input-source`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      });
    expect((await put(JSON.stringify({ source: "tablet" }))).status).toBe(204);
    expect(sources.active()).toBe("tablet");
    expect((await put(JSON.stringify({ source: "laptop" }))).status).toBe(400);
    expect((await put(JSON.stringify({ device: "robot" }))).status).toBe(400);
    expect((await put("not json")).status).toBe(400);
    expect(sources.active()).toBe("tablet");
    expect((await fetch(`${base}/admin/input-source`)).status).toBe(405);
  });

  test("マイクを一時停止・再開する。形の違う本文は400", async () => {
    const { api, base, sources } = setup();
    current = api;
    const put = (body: unknown) =>
      fetch(`${base}/admin/mic`, { method: "PUT", body: JSON.stringify(body) });
    expect((await put({ paused: true })).status).toBe(204);
    expect(sources.micPaused()).toBe(true);
    const status = parseAdminStatus(await (await fetch(`${base}/admin/status`)).json());
    expect(status?.micPaused).toBe(true);
    expect((await put({ paused: "no" })).status).toBe(400);
    expect((await put({ paused: false })).status).toBe(204);
    expect(sources.micPaused()).toBe(false);
  });

  test("違うメソッド・知らないパスは断る", async () => {
    const { api, base } = setup();
    current = api;
    expect((await fetch(`${base}/admin/status`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/admin/pairing-codes`)).status).toBe(405);
    expect((await fetch(`${base}/admin/unknown`)).status).toBe(404);
    expect(
      (await fetch(`${base}/admin/status`, { headers: { origin: "https://evil.example" } })).status,
    ).toBe(403);
  });

  test("/admin/eventsは、つないだときに状態を、そのあとできごとを流す", async () => {
    const { api, base, auth } = setup();
    current = api;
    const ws = new WebSocket(`${base.replace("http", "ws")}/admin/events`);
    const received: AdminEvent[] = [];
    const waitFor = (n: number) =>
      new Promise<void>((resolve) => {
        const check = () => (received.length >= n ? resolve() : setTimeout(check, 5));
        check();
      });
    ws.onmessage = (e) => {
      const ev = parseAdminEvent(String(e.data));
      if (ev) received.push(ev);
    };
    await waitFor(1);
    expect(received[0]).toMatchObject({ type: "status", inputSource: "robot" });

    const { code } = auth.issueCode();
    const paired = await auth.pair({ role: "robot", code, origin: "a" });
    if (!paired.ok) throw new Error(paired.reason);
    await fetch(`${base}/admin/devices/${paired.device.id}`, { method: "DELETE" });
    await waitFor(3);
    expect(received[1]).toMatchObject({
      type: "event",
      kind: "unpaired",
      detail: paired.device.id,
    });
    expect(received[2]).toMatchObject({ type: "status" });
    ws.close();
  });
});
