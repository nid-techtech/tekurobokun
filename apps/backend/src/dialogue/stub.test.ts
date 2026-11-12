import { describe, expect, test } from "bun:test";
import { LlmError } from "./engine.ts";
import { DEFAULT_STUB_DATA, type StubData, StubDialogueEngine } from "./stub.ts";

const data: StubData = { ...DEFAULT_STUB_DATA, delayMs: 0 };

describe("StubDialogueEngine", () => {
  test("決まった返事を順に返す", async () => {
    const engine = new StubDialogueEngine(data);
    const first = await engine.reply([], "こんにちは");
    const second = await engine.reply([], "こんにちは");
    expect(first).toMatchObject(data.replies[0] ?? {});
    expect(second).toMatchObject(data.replies[1] ?? {});
    expect(first.raw).toBe(JSON.stringify(data.replies[0]));
  });

  test("崩れの語で、JSONでない出力をneutralで返す", async () => {
    const result = await new StubDialogueEngine(data).reply([], `返事が${data.malformedTrigger}る`);
    expect(result).toMatchObject({
      raw: data.malformedRaw,
      say: data.malformedRaw,
      emotion: "neutral",
    });
  });

  test("失敗の語で、LlmErrorを投げる", async () => {
    await expect(new StubDialogueEngine(data).reply([], data.failTrigger)).rejects.toBeInstanceOf(
      LlmError,
    );
  });
});
