import { describe, expect, test } from "bun:test";
import type { ServerMessage } from "@tekurobokun/protocol";
import { RobotCredentials, type StorageLike } from "./credentials";
import { RobotLink, type SocketLike } from "./RobotLink";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  receive(data: unknown): void {
    this.onmessage?.({
      data: typeof data === "string" ? data : JSON.stringify(data),
    } as MessageEvent);
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
  json(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function memoryStorage(
  init: Record<string, string> = {},
): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const URL_KEY = "tekurobokun.robot.backendUrl";
const TOKEN_KEY = "tekurobokun.robot.token";

function setup(
  init: Record<string, string> = { [URL_KEY]: "ws://backend.test/ws", [TOKEN_KEY]: "tok" },
  dev?: { url: string | null; token: string | null },
) {
  const storage = memoryStorage(init);
  const credentials = new RobotCredentials(storage, dev);
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const events: string[] = [];
  const messages: ServerMessage[] = [];
  const link = new RobotLink(
    credentials,
    {
      onMessage: (m) => messages.push(m),
      onOpen: () => events.push("open"),
      onClose: () => events.push("close"),
    },
    {
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      setTimer: (fn, ms) => timers.push({ fn, ms }),
    },
  );
  return { link, sockets, timers, events, messages, storage, credentials };
}

describe("RobotLink", () => {
  test("保存した接続先につなぎ、トークン付きのhelloで機体として名乗る", () => {
    const { link, sockets, events } = setup();
    expect(link.paired).toBe(true);
    link.connect();
    expect(sockets[0]?.url).toBe("ws://backend.test/ws");
    sockets[0]?.open();
    expect(sockets[0]?.json()).toEqual([{ type: "hello", role: "robot", token: "tok" }]);
    expect(events).toEqual(["open"]);
    expect(link.connected).toBe(true);
  });

  test("検証を通ったメッセージだけを渡す", () => {
    const { link, sockets, messages } = setup();
    link.connect();
    sockets[0]?.open();
    sockets[0]?.receive("not json");
    sockets[0]?.receive({ type: "speech", turnId: "t1" });
    sockets[0]?.receive({
      type: "status",
      session: "thinking",
      inputSource: "tablet",
      micPaused: false,
      health: { backend: true, llm: true, tts: true, stt: true, robot: true },
    });
    expect(messages).toEqual([expect.objectContaining({ type: "status", session: "thinking" })]);
  });

  test("切れたら間をおいて再接続し、間隔は5秒まで伸びる", () => {
    const { link, sockets, timers, events } = setup();
    link.connect();
    sockets[0]?.drop();
    expect(events).toEqual(["close"]);
    expect(link.send({ type: "playback_done", turnId: "t", index: 0 })).toBe(false);
    for (let i = 0; i < 4; i++) {
      timers.at(-1)?.fn();
      sockets.at(-1)?.drop();
    }
    expect(timers.map((t) => t.ms)).toEqual([1000, 2000, 4000, 5000, 5000]);

    // つながると間隔は元に戻る
    timers.at(-1)?.fn();
    sockets.at(-1)?.open();
    sockets.at(-1)?.drop();
    expect(timers.at(-1)?.ms).toBe(1000);
  });

  test("接続先がなければつながず、未登録", () => {
    const { link, sockets } = setup({});
    expect(link.paired).toBe(false);
    link.connect();
    expect(sockets).toHaveLength(0);
  });

  test("QRのURLにつないでpairを送り、pairedで保存してhelloを送り直す", () => {
    const { link, sockets, storage } = setup({});
    link.pair("https://tekurobo.example.test", "ABCD-EFGH");
    const ws = sockets[0];
    expect(ws?.url).toBe("wss://tekurobo.example.test/ws");
    ws?.open();
    expect(ws?.json()).toEqual([
      { type: "hello", role: "robot", token: null },
      { type: "pair", role: "robot", code: "ABCD-EFGH" },
    ]);
    ws?.receive({ type: "paired", token: "new-token" });
    expect(ws?.json().at(-1)).toEqual({ type: "hello", role: "robot", token: "new-token" });
    expect(storage.data.get(URL_KEY)).toBe("wss://tekurobo.example.test/ws");
    expect(storage.data.get(TOKEN_KEY)).toBe("new-token");
    expect(link.paired).toBe(true);
  });

  test("いまの接続先と同じURLなら、つなぎ直さずにpairを送る。同じコードは2度送らない", () => {
    const { link, sockets } = setup({ [URL_KEY]: "ws://192.168.0.10:8787/ws" });
    link.connect();
    sockets[0]?.open();
    link.pair("http://192.168.0.10:8787", "ABCD-EFGH");
    link.pair("http://192.168.0.10:8787", "ABCD-EFGH");
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.json().filter((m) => (m as { type: string }).type === "pair")).toHaveLength(
      1,
    );
  });

  test("断られたコードは、QRを見せ続けられても送り直さない", () => {
    const { link, sockets } = setup({ [URL_KEY]: "ws://192.168.0.10:8787/ws" });
    link.connect();
    sockets[0]?.open();
    link.pair("http://192.168.0.10:8787", "ABCD-EFG2");
    sockets[0]?.receive({ type: "pair_failed", reason: "expired" });
    link.pair("http://192.168.0.10:8787", "ABCD-EFG2");
    link.pair("http://192.168.0.10:8787", "WXYZ-2345");
    const pairs = sockets[0]?.json().filter((m) => (m as { type: string }).type === "pair");
    expect(pairs).toEqual([
      { type: "pair", role: "robot", code: "ABCD-EFG2" },
      { type: "pair", role: "robot", code: "WXYZ-2345" },
    ]);
  });

  test("別の接続先のQRなら、前の接続を閉じてつなぎ直す（前の接続の再接続はしない）", () => {
    const { link, sockets, timers } = setup();
    link.connect();
    sockets[0]?.open();
    link.pair("http://192.168.0.20:8787", "ABCD-EFGH");
    expect(sockets[0]?.closed).toBe(true);
    expect(sockets[1]?.url).toBe("ws://192.168.0.20:8787/ws");
    sockets[1]?.open();
    // 保存した接続先と違うため、トークンは付けない
    expect(sockets[1]?.json()[0]).toEqual({ type: "hello", role: "robot", token: null });
    expect(timers).toHaveLength(0);
  });

  test("無効・無効化済みのトークンなら消して未登録に戻る。missingでは消さない", () => {
    const { link, sockets, storage } = setup();
    link.connect();
    sockets[0]?.open();
    sockets[0]?.receive({ type: "auth_required", reason: "missing" });
    expect(link.paired).toBe(true);
    sockets[0]?.receive({ type: "auth_required", reason: "revoked" });
    expect(link.paired).toBe(false);
    expect(storage.data.has(TOKEN_KEY)).toBe(false);
    expect(storage.data.get(URL_KEY)).toBe("ws://backend.test/ws");
  });

  test("開発用の設定（url・token）があれば、保存したものより優先する", () => {
    const { link, sockets, credentials } = setup(
      { [URL_KEY]: "ws://stored.test/ws", [TOKEN_KEY]: "stored" },
      { url: "ws://127.0.0.1:8787/ws", token: "dev" },
    );
    expect(credentials.usingDevConfig).toBe(true);
    link.connect();
    sockets[0]?.open();
    expect(sockets[0]?.url).toBe("ws://127.0.0.1:8787/ws");
    expect(sockets[0]?.json()[0]).toEqual({ type: "hello", role: "robot", token: "dev" });
    sockets[0]?.receive({ type: "auth_required", reason: "invalid" });
    expect(link.paired).toBe(false);
  });
});
