import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConsoleSettings,
  parseServerMessage,
  type ServerMessage,
} from "@tekurobokun/protocol";
import { InputDeviceRegistry } from "./devices.ts";
import { DEFAULT_STUB_DATA, StubDialogueEngine } from "./dialogue/stub.ts";
import { HealthMonitor } from "./health.ts";
import { Server, WS_PATH } from "./server.ts";
import { ConversationSession } from "./session.ts";
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

const health = new HealthMonitor({ llm: async () => true, tts: async () => true }, 60_000);
const devices = new InputDeviceRegistry(["tablet", "phone"], "tablet");
const server = new Server({ port: 0, staticDir, settings, health });
const session = new ConversationSession({
  dialogue: new StubDialogueEngine({ ...DEFAULT_STUB_DATA, delayMs: 50 }),
  tts: new StubTtsEngine({ delayMs: 10 }),
  devices,
  health,
  emit: (m) => server.broadcast(m),
  sendToRobot: (m) => server.sendToRobot(m),
  displayTurns: 50,
  speakingGraceMs: 5000,
});
server.attach(session);
health.onChange(() => session.broadcastStatus());

beforeAll(async () => {
  server.start();
  await health.checkNow();
});
afterAll(() => {
  server.stop();
  rmSync(staticDir, { recursive: true, force: true });
});

/** 受け取ったメッセージを溜め、条件に合うものを待てるWebSocketのクライアント。 */
async function connect(hello: object) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${WS_PATH}`);
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
  ws.send(JSON.stringify(hello));
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
  return { ws, received, waitFor };
}

describe("Server", () => {
  test("入力ページを配信し、ディレクトリの外は返さない", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    expect(await (await fetch(`${base}/`)).text()).toContain("console");
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/..%2f..%2fpackage.json`)).status).toBe(404);
  });

  test("helloにwelcomeとstatusを返し、発言→考え中→返事→待機中を全員に配信する", async () => {
    const tablet = await connect({ type: "hello", role: "console", device: "tablet" });
    const phone = await connect({ type: "hello", role: "console", device: "phone" });

    const welcome = await tablet.waitFor((m) => m.type === "welcome");
    expect(welcome).toEqual({ type: "welcome", settings, history: [] });
    await tablet.waitFor((m) => m.type === "status" && m.session === "idle");

    // 有効でない端末（phone）の発言は捨てる
    phone.ws.send(JSON.stringify({ type: "utterance", text: "スマホから" }));
    tablet.ws.send(JSON.stringify({ type: "utterance", text: "こんにちは" }));
    const started = await phone.waitFor((m) => m.type === "turn_started");
    expect(started).toMatchObject({ turn: { device: "tablet", text: "こんにちは" } });

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
    const late = await connect({ type: "hello", role: "console", device: "tablet" });
    const lateWelcome = await late.waitFor((m) => m.type === "welcome");
    expect(lateWelcome.type === "welcome" && lateWelcome.history).toHaveLength(1);

    for (const c of [tablet, phone, late]) c.ws.close();
  });

  test("形式の崩れた返事はneutralで届く", async () => {
    const tablet = await connect({ type: "hello", role: "console", device: "tablet" });
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
    const tablet = await connect({ type: "hello", role: "console", device: "tablet" });
    await tablet.waitFor((m) => m.type === "status");
    const robot = await connect({ type: "hello", role: "robot" });
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
    const tablet = await connect({ type: "hello", role: "console", device: "tablet" });
    const robot = await connect({ type: "hello", role: "robot" });
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
    const tablet = await connect({ type: "hello", role: "console", device: "tablet" });
    const robot = await connect({ type: "hello", role: "robot" });
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
});
