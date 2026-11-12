import { describe, expect, test } from "bun:test";
import type { ServerMessage } from "@tekurobokun/protocol";
import { RobotLink, type SocketLike } from "./RobotLink";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  receive(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const events: string[] = [];
  const messages: ServerMessage[] = [];
  const link = new RobotLink(
    "ws://backend.test/ws",
    {
      onMessage: (m) => messages.push(m),
      onOpen: () => events.push("open"),
      onClose: () => events.push("close"),
    },
    {
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      setTimer: (fn, ms) => timers.push({ fn, ms }),
    },
  );
  return { link, sockets, timers, events, messages };
}

describe("RobotLink", () => {
  test("つながったらhelloで機体として名乗る", () => {
    const { link, sockets, events } = setup();
    link.connect();
    sockets[0]?.open();
    expect(sockets[0]?.sent.map((s) => JSON.parse(s))).toEqual([{ type: "hello", role: "robot" }]);
    expect(events).toEqual(["open"]);
    expect(link.connected).toBe(true);
  });

  test("検証を通ったメッセージだけを渡す", () => {
    const { link, sockets, messages } = setup();
    link.connect();
    sockets[0]?.open();
    sockets[0]?.receive("not json");
    sockets[0]?.receive(JSON.stringify({ type: "speech", turnId: "t1" }));
    sockets[0]?.receive(
      JSON.stringify({
        type: "status",
        session: "thinking",
        activeDevice: "tablet",
        health: { backend: true, llm: true, tts: true, robot: true },
      }),
    );
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
});
