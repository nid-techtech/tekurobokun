import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConsoleSettings,
  parseServerMessage,
  type ServerMessage,
} from "@tekurobokun/protocol";
import { DeviceAuth, MemoryDeviceStore } from "./device_auth.ts";
import { DEFAULT_STUB_DATA, StubDialogueEngine } from "./dialogue/stub.ts";
import { HealthMonitor } from "./health.ts";
import { InputSourceRegistry } from "./input_sources.ts";
import { CLOSE_REVOKED, Server, WS_PATH } from "./server.ts";
import { ConversationSession } from "./session.ts";
import { StubSpeechRecognizer } from "./stt/stub.ts";
import { encodeWav } from "./tts/engine.ts";
import { StubTtsEngine } from "./tts/stub.ts";

// スタブのバックエンドを立て、WebSocketで入力ページのふりをして会話を通す。

const settings: ConsoleSettings = {
  autosendMs: 3000,
  fontSizePx: 18,
  bottomInsetPx: 0,
  prompt: { user: "user", host: "host", dir: "~" },
};
const staticDir = mkdtempSync(join(tmpdir(), "tekurobo-static-"));
writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>console</title>");

const health = new HealthMonitor(
  { llm: async () => true, tts: async () => true, stt: async () => true },
  60_000,
);
const sources = new InputSourceRegistry(["tablet", "phone"], "tablet");
const pairing = { codeTtlMs: 60_000, maxFailures: 5, failureWindowMs: 60_000, lockMs: 300_000 };
const auth = new DeviceAuth({
  store: new MemoryDeviceStore(),
  pairing,
  consoles: ["tablet", "phone"],
});
const paired: string[] = [];
const server = new Server({
  host: "127.0.0.1",
  port: 0,
  staticDir,
  settings,
  health,
  auth,
  onPaired: (d) => paired.push(d.name),
});
const session = new ConversationSession({
  dialogue: new StubDialogueEngine({ ...DEFAULT_STUB_DATA, delayMs: 50 }),
  tts: new StubTtsEngine({ delayMs: 10 }),
  stt: new StubSpeechRecognizer({ delayMs: 10, utterances: ["mic-text"] }),
  sources,
  health,
  emit: (m) => server.broadcast(m),
  sendToRobot: (m) => server.sendToRobot(m),
  displayTurns: 50,
  speakingGraceMs: 5000,
});
server.attach(session);
health.onChange(() => session.broadcastStatus());

/** 登録してトークンを得る（DeviceAuthを直接呼ぶ） */
async function register(role: "robot" | "console", device?: string) {
  const { code } = auth.issueCode();
  const result = await auth.pair({ role, device, code, origin: "test" });
  if (!result.ok) throw new Error(result.reason);
  return { token: result.token, id: result.device.id };
}
const tokens = { tablet: "", phone: "", robot: "" };

beforeAll(async () => {
  tokens.tablet = (await register("console", "tablet")).token;
  tokens.phone = (await register("console", "phone")).token;
  tokens.robot = (await register("robot")).token;
  server.start();
  await health.checkNow();
});
afterAll(() => {
  server.stop();
  rmSync(staticDir, { recursive: true, force: true });
});

/** 受け取ったメッセージを溜め、条件に合うものを待てるWebSocketのクライアント。 */
async function connect(hello: object | null, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${WS_PATH}`, { headers });
  const received: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  ws.onmessage = (e) => {
    const m = parseServerMessage(String(e.data));
    if (m) received.push(m);
    for (const w of waiters.splice(0)) w();
  };
  await new Promise((r) => {
    ws.onopen = r;
  });
  if (hello) ws.send(JSON.stringify(hello));
  const waitFor = async (pred: (m: ServerMessage) => boolean, ms = 2000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const found = received.find(pred);
      if (found) return found;
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
    throw new Error("timed out waiting for message");
  };
  const closed = new Promise<number>((r) => {
    ws.onclose = (e) => r(e.code);
  });
  return { ws, received, waitFor, closed };
}

describe("Server", () => {
  test("入力ページを配信し、ディレクトリの外は返さない", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    expect(await (await fetch(`${base}/`)).text()).toContain("console");
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/..%2f..%2fpackage.json`)).status).toBe(404);
  });

  test("helloにwelcomeとstatusを返し、発言→考え中→返事→待機中を全員に配信する", async () => {
    const tablet = await connect({
      type: "hello",
      role: "console",
      device: "tablet",
      token: tokens.tablet,
    });
    const phone = await connect({
      type: "hello",
      role: "console",
      device: "phone",
      token: tokens.phone,
    });

    const welcome = await tablet.waitFor((m) => m.type === "welcome");
    expect(welcome).toEqual({ type: "welcome", settings, history: [] });
    await tablet.waitFor((m) => m.type === "status" && m.session === "idle");

    // 有効でない端末（phone）の発言は捨てる
    phone.ws.send(JSON.stringify({ type: "utterance", text: "スマホから" }));
    tablet.ws.send(JSON.stringify({ type: "utterance", text: "こんにちは" }));
    const started = await phone.waitFor((m) => m.type === "turn_started");
    expect(started).toMatchObject({ turn: { source: "tablet", via: "text", text: "こんにちは" } });

    // 考え中に送った発言は捨てる
    await tablet.waitFor((m) => m.type === "status" && m.session === "thinking");
    tablet.ws.send(JSON.stringify({ type: "utterance", text: "もう一度" }));

    const replied = await tablet.waitFor((m) => m.type === "turn_replied");
    expect(replied).toMatchObject(DEFAULT_STUB_DATA.replies[0] ?? {});
    await tablet.waitFor(
      (m) =>
        m.type === "status" &&
        m.session === "idle" &&
        tablet.received.indexOf(m) > tablet.received.indexOf(replied),
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(tablet.received.filter((m) => m.type === "turn_started")).toHaveLength(1);
    expect(session.history().map((t) => t.text)).toEqual(["こんにちは"]);

    // 新しく接続した端末は、履歴をwelcomeで受け取る
    const late = await connect({
      type: "hello",
      role: "console",
      device: "tablet",
      token: tokens.tablet,
    });
    const lateWelcome = await late.waitFor((m) => m.type === "welcome");
    expect(lateWelcome.type === "welcome" && lateWelcome.history).toHaveLength(1);

    for (const c of [tablet, phone, late]) c.ws.close();
  });

  test("形式の崩れた返事はneutralで届く", async () => {
    const tablet = await connect({
      type: "hello",
      role: "console",
      device: "tablet",
      token: tokens.tablet,
    });
    await tablet.waitFor((m) => m.type === "status");
    tablet.ws.send(
      JSON.stringify({ type: "utterance", text: `返事が${DEFAULT_STUB_DATA.malformedTrigger}る` }),
    );
    const replied = await tablet.waitFor((m) => m.type === "turn_replied");
    expect(replied).toMatchObject({ say: DEFAULT_STUB_DATA.malformedRaw, emotion: "neutral" });
    await tablet.waitFor(
      (m) =>
        m.type === "status" &&
        m.session === "idle" &&
        tablet.received.indexOf(m) > tablet.received.indexOf(replied),
    );
    tablet.ws.close();
  });

  test("機体の接続でhealth.robotが変わり、statusが配信される", async () => {
    const tablet = await connect({
      type: "hello",
      role: "console",
      device: "tablet",
      token: tokens.tablet,
    });
    await tablet.waitFor((m) => m.type === "status");
    const robot = await connect({ type: "hello", role: "robot", token: tokens.robot });
    const up = await tablet.waitFor((m) => m.type === "status" && m.health.robot);
    robot.ws.close();
    await tablet.waitFor(
      (m) =>
        m.type === "status" &&
        !m.health.robot &&
        tablet.received.indexOf(m) > tablet.received.indexOf(up),
    );
    tablet.ws.close();
  });

  test("機体がいると話し中になり、音声が機体にだけ届き、最後のplayback_doneで待機中", async () => {
    const tablet = await connect({
      type: "hello",
      role: "console",
      device: "tablet",
      token: tokens.tablet,
    });
    const robot = await connect({ type: "hello", role: "robot", token: tokens.robot });
    await tablet.waitFor((m) => m.type === "status" && m.health.robot);

    tablet.ws.send(JSON.stringify({ type: "utterance", text: "話して" }));
    await tablet.waitFor((m) => m.type === "status" && m.session === "speaking");
    const last = await robot.waitFor((m) => m.type === "speech" && m.last);
    if (last.type !== "speech") throw new Error("unreachable");
    const speeches = robot.received.filter((m) => m.type === "speech");
    expect(speeches.map((m) => m.type === "speech" && m.index)).toEqual(speeches.map((_, i) => i));
    expect(tablet.received.some((m) => m.type === "speech")).toBe(false);

    robot.ws.send(
      JSON.stringify({ type: "playback_done", turnId: last.turnId, index: last.index }),
    );
    await tablet.waitFor(
      (m) =>
        m.type === "status" &&
        m.session === "idle" &&
        tablet.received.indexOf(m) > tablet.received.indexOf(last),
    );
    for (const c of [tablet, robot]) c.ws.close();
  });

  test("話し中に機体が切断したら、待機中に戻る", async () => {
    const tablet = await connect({
      type: "hello",
      role: "console",
      device: "tablet",
      token: tokens.tablet,
    });
    const robot = await connect({ type: "hello", role: "robot", token: tokens.robot });
    await tablet.waitFor((m) => m.type === "status" && m.health.robot);

    tablet.ws.send(JSON.stringify({ type: "utterance", text: "話して" }));
    const speaking = await tablet.waitFor((m) => m.type === "status" && m.session === "speaking");
    await robot.waitFor((m) => m.type === "speech");
    robot.ws.close();
    await tablet.waitFor(
      (m) =>
        m.type === "status" &&
        m.session === "idle" &&
        !m.health.robot &&
        tablet.received.indexOf(m) > tablet.received.indexOf(speaking),
    );
    expect(session.session).toBe("idle");
    tablet.ws.close();
  });

  test("入力元がrobotなら、機体のlisteningで聞き取り中、voiceをSTTで文字にして(mic)の発言にする", async () => {
    const tablet = await connect({
      type: "hello",
      role: "console",
      device: "tablet",
      token: tokens.tablet,
    });
    const robot = await connect({ type: "hello", role: "robot", token: tokens.robot });
    await tablet.waitFor((m) => m.type === "status" && m.health.robot);
    // consoleがいる入力元のままでは、機体の声を受け付けない
    robot.ws.send(JSON.stringify({ type: "listening", active: true }));
    await new Promise((r) => setTimeout(r, 50));
    expect(session.session).toBe("idle");

    sources.setActive("robot");
    session.broadcastStatus();
    robot.ws.send(JSON.stringify({ type: "listening", active: true }));
    await tablet.waitFor((m) => m.type === "status" && m.session === "listening");
    const wav = encodeWav(new Int16Array(16_000), 16_000);
    robot.ws.send(
      JSON.stringify({
        type: "voice",
        wav: Buffer.from(wav).toString("base64"),
        durationMs: 1000,
      }),
    );
    const started = await tablet.waitFor((m) => m.type === "turn_started");
    if (started.type !== "turn_started") throw new Error("unreachable");
    expect(started.turn).toMatchObject({ source: "robot", via: "mic", text: "mic-text" });
    await robot.waitFor((m) => m.type === "speech" && m.last);
    sources.setActive("tablet");
    session.robotDisconnected();
    for (const c of [tablet, robot]) c.ws.close();
    await tablet.closed;
  });

  test("トークンのない・知らない・役割や名前の違うトークンにはauth_requiredを返し、会話を受け付けない", async () => {
    const none = await connect({ type: "hello", role: "console", device: "tablet", token: null });
    expect(await none.waitFor((m) => m.type === "auth_required")).toEqual({
      type: "auth_required",
      reason: "missing",
    });
    const unknown = await connect({ type: "hello", role: "robot", token: "nope" });
    expect(await unknown.waitFor((m) => m.type === "auth_required")).toMatchObject({
      reason: "invalid",
    });
    // 機体のトークンでconsoleを名乗る・phoneのトークンでtabletを名乗る
    const wrongRole = await connect({
      type: "hello",
      role: "console",
      device: "tablet",
      token: tokens.robot,
    });
    expect(await wrongRole.waitFor((m) => m.type === "auth_required")).toMatchObject({
      reason: "invalid",
    });
    const wrongName = await connect({
      type: "hello",
      role: "console",
      device: "tablet",
      token: tokens.phone,
    });
    expect(await wrongName.waitFor((m) => m.type === "auth_required")).toMatchObject({
      reason: "invalid",
    });

    none.ws.send(JSON.stringify({ type: "utterance", text: "未登録から" }));
    await new Promise((r) => setTimeout(r, 150));
    expect(session.history().some((t) => t.text === "未登録から")).toBe(false);
    // 未登録の接続には配信しない
    expect(none.received.some((m) => m.type === "welcome" || m.type === "status")).toBe(false);
    for (const c of [none, unknown, wrongRole, wrongName]) c.ws.close();
  });

  test("pairでトークンを受け取り、そのトークンでhelloできる", async () => {
    const before = paired.length;
    const c = await connect(null);
    const { code } = auth.issueCode();
    c.ws.send(JSON.stringify({ type: "pair", role: "console", device: "phone", code }));
    const result = await c.waitFor((m) => m.type === "paired");
    if (result.type !== "paired") throw new Error("unreachable");
    expect(paired.slice(before)).toEqual(["phone"]);

    c.ws.send(
      JSON.stringify({ type: "hello", role: "console", device: "phone", token: result.token }),
    );
    await c.waitFor((m) => m.type === "welcome");

    // 同じコードは2回使えない
    const again = await connect(null);
    again.ws.send(JSON.stringify({ type: "pair", role: "robot", code }));
    expect(await again.waitFor((m) => m.type === "pair_failed")).toEqual({
      type: "pair_failed",
      reason: "invalid",
    });
    for (const x of [c, again]) x.ws.close();
  });

  test("失敗の制限は、CF-Connecting-IPの接続元ごとに数える", async () => {
    auth.issueCode();
    const attacker = await connect(null, { "CF-Connecting-IP": "203.0.113.5" });
    for (let i = 0; i < 5; i++) {
      attacker.ws.send(JSON.stringify({ type: "pair", role: "robot", code: "AAAA-AAAA" }));
    }
    await attacker.waitFor(
      () => attacker.received.filter((m) => m.type === "pair_failed").length === 5,
    );
    const { code } = auth.issueCode();
    attacker.ws.send(JSON.stringify({ type: "pair", role: "robot", code }));
    await attacker.waitFor((m) => m.type === "pair_failed" && m.reason === "rate_limited");

    // 別の接続元は通る
    const other = await connect(null, { "CF-Connecting-IP": "203.0.113.6" });
    other.ws.send(JSON.stringify({ type: "pair", role: "robot", code }));
    await other.waitFor((m) => m.type === "paired");
    for (const x of [attacker, other]) x.ws.close();
  });

  test("無効化した端末の接続を切り、再接続ではauth_required（revoked）", async () => {
    const { token, id } = await register("console", "tablet");
    const c = await connect({ type: "hello", role: "console", device: "tablet", token });
    await c.waitFor((m) => m.type === "welcome");
    expect(server.isConnected(id)).toBe(true);

    await auth.revoke(id);
    server.disconnectDevice(id);
    expect(await c.closed).toBe(CLOSE_REVOKED);
    expect(server.isConnected(id)).toBe(false);

    const again = await connect({ type: "hello", role: "console", device: "tablet", token });
    expect(await again.waitFor((m) => m.type === "auth_required")).toMatchObject({
      reason: "revoked",
    });
    again.ws.close();
  });
});
