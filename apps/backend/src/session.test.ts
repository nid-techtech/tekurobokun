import { describe, expect, test } from "bun:test";
import type { BroadcastMessage, Health, Turn } from "@tekurobokun/protocol";
import { InputDeviceRegistry } from "./devices.ts";
import { type DialogueEngine, type DialogueResult, LlmError } from "./dialogue/engine.ts";
import { ConversationSession } from "./session.ts";

/** 返事を外から渡すまで待つDialogueEngine。 */
class ManualDialogue implements DialogueEngine {
  calls: { history: Turn[]; text: string }[] = [];
  private pending: { resolve: (r: DialogueResult) => void; reject: (e: Error) => void }[] = [];

  reply(history: Turn[], text: string): Promise<DialogueResult> {
    this.calls.push({ history, text });
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  answer(say: string): void {
    this.pending.shift()?.resolve({ raw: say, say, emotion: "happy", thinkingMs: 1200 });
  }
  fail(): void {
    this.pending.shift()?.reject(new LlmError("down"));
  }
}

function setup(options: { llm?: boolean; displayTurns?: number } = {}) {
  const dialogue = new ManualDialogue();
  const devices = new InputDeviceRegistry(["tablet", "phone"], "tablet");
  const health = {
    value: { backend: true, llm: options.llm ?? true, tts: true, robot: false } as Health,
    snapshot() {
      return { ...this.value };
    },
    markLlmDown() {
      this.value.llm = false;
    },
  };
  const emitted: BroadcastMessage[] = [];
  let id = 0;
  const session = new ConversationSession({
    dialogue,
    devices,
    health,
    emit: (m) => emitted.push(m),
    displayTurns: options.displayTurns ?? 50,
    now: () => new Date("2026-11-14T01:02:11.000Z"),
    newId: () => `t${++id}`,
  });
  return { session, dialogue, devices, health, emitted };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("ConversationSession", () => {
  test("発言→考え中→返事→待機中", async () => {
    const { session, dialogue, emitted } = setup();
    const done = session.handleUtterance("tablet", "  こんにちは ");
    expect(session.session).toBe("thinking");
    expect(emitted).toEqual([
      {
        type: "turn_started",
        turn: {
          id: "t1",
          at: "2026-11-14T10:02:11.000+09:00",
          device: "tablet",
          text: "こんにちは",
        },
      },
      expect.objectContaining({ type: "status", session: "thinking", activeDevice: "tablet" }),
    ]);

    dialogue.answer("やあ。");
    expect(await done).toBe("accepted");
    expect(session.session).toBe("idle");
    expect(emitted.slice(2)).toEqual([
      { type: "turn_replied", turnId: "t1", say: "やあ。", emotion: "happy", thinkingMs: 1200 },
      expect.objectContaining({ type: "status", session: "idle" }),
    ]);
    expect(session.history()).toEqual([
      {
        id: "t1",
        at: "2026-11-14T10:02:11.000+09:00",
        device: "tablet",
        text: "こんにちは",
        reply: { say: "やあ。", emotion: "happy", thinkingMs: 1200 },
      },
    ]);
  });

  test("考え中の発言は捨て、何も送らず記録しない", async () => {
    const { session, dialogue, emitted } = setup();
    const first = session.handleUtterance("tablet", "1つ目");
    const count = emitted.length;
    expect(await session.handleUtterance("tablet", "2つ目")).toBe("busy");
    expect(emitted).toHaveLength(count);
    expect(dialogue.calls).toHaveLength(1);
    dialogue.answer("a");
    await first;
    expect(session.history().map((t) => t.text)).toEqual(["1つ目"]);
  });

  test("有効でない端末・空の発言・LLMが落ちているときは捨てる", async () => {
    const { session, emitted } = setup();
    expect(await session.handleUtterance("phone", "こんにちは")).toBe("inactive_device");
    expect(await session.handleUtterance("tablet", "   ")).toBe("empty");
    const down = setup({ llm: false });
    expect(await down.session.handleUtterance("tablet", "こんにちは")).toBe("llm_unavailable");
    expect(emitted).toHaveLength(0);
    expect(down.emitted).toHaveLength(0);
  });

  test("切り替えた端末から受け付ける", async () => {
    const { session, dialogue, devices } = setup();
    devices.setActive("phone");
    const done = session.handleUtterance("phone", "スマホから");
    dialogue.answer("a");
    expect(await done).toBe("accepted");
    expect(session.history()[0]?.device).toBe("phone");
  });

  test("LLMが失敗したら、llmをfalseにして待機中へ戻る", async () => {
    const { session, dialogue, health, emitted } = setup();
    const done = session.handleUtterance("tablet", "こんにちは");
    dialogue.fail();
    await done;
    expect(session.session).toBe("idle");
    expect(health.value.llm).toBe(false);
    expect(emitted.at(-1)).toMatchObject({
      type: "status",
      session: "idle",
      health: { llm: false },
    });
    expect(emitted.some((m) => m.type === "turn_replied")).toBe(false);
    expect(session.history()[0]?.reply).toBeUndefined();
  });

  test("直近の履歴をDialogueEngineに渡す", async () => {
    const { session, dialogue } = setup();
    for (const text of ["1", "2"]) {
      const done = session.handleUtterance("tablet", text);
      await tick();
      dialogue.answer(`re${text}`);
      await done;
    }
    expect(dialogue.calls[1]?.history.map((t) => [t.text, t.reply?.say])).toEqual([["1", "re1"]]);
  });

  test("表示用の履歴は設定の件数まで", async () => {
    const { session, dialogue } = setup({ displayTurns: 2 });
    for (const text of ["1", "2", "3"]) {
      const done = session.handleUtterance("tablet", text);
      dialogue.answer("a");
      await done;
    }
    expect(session.history().map((t) => t.text)).toEqual(["2", "3"]);
  });

  test("historyは写しを返す", async () => {
    const { session, dialogue } = setup();
    const done = session.handleUtterance("tablet", "a");
    dialogue.answer("b");
    await done;
    const copy = session.history();
    (copy[0] as Turn).text = "changed";
    expect(session.history()[0]?.text).toBe("a");
  });
});
