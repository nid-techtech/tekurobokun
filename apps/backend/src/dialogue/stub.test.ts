import { describe, expect, test } from "bun:test";
import { LlmError } from "./engine.ts";
import { DEFAULT_STUB_DATA, type StubData, StubDialogueEngine } from "./stub.ts";

const data: StubData = { ...DEFAULT_STUB_DATA, delayMs: 0 };
const noLoop = { antiLoop: false };

describe("StubDialogueEngine", () => {
  test("決まった返事を順に返す", async () => {
    const engine = new StubDialogueEngine(data);
    const first = await engine.reply([], "こんにちは", noLoop);
    const second = await engine.reply([], "こんにちは", noLoop);
    expect(first).toMatchObject(data.replies[0] ?? {});
    expect(second).toMatchObject(data.replies[1] ?? {});
    expect(first.raw).toBe(JSON.stringify({ ...data.replies[0], search: null }));
    expect(first.search).toBeNull();
  });

  test("崩れの語で、JSONでない出力をneutralで返す", async () => {
    const result = await new StubDialogueEngine(data).reply(
      [],
      `返事が${data.malformedTrigger}る`,
      noLoop,
    );
    expect(result).toMatchObject({
      raw: data.malformedRaw,
      say: data.malformedRaw,
      emotion: "neutral",
    });
  });

  test("失敗の語で、LlmErrorを投げる", async () => {
    await expect(
      new StubDialogueEngine(data).reply([], data.failTrigger, noLoop),
    ).rejects.toBeInstanceOf(LlmError);
  });

  test("検索の語で、発言を検索語にして前置きを返し、2回目は結果の有無で返事を変える", async () => {
    const engine = new StubDialogueEngine(data);
    const text = `長岡を${data.searchTrigger}`;
    const first = await engine.reply([], text, noLoop);
    expect(first).toMatchObject({ ...data.searchPreSay, search: text });
    const ok = await engine.replyWithResults([], text, text, [], noLoop);
    expect(ok).toMatchObject(data.searchReply);
    const failed = await engine.replyWithResults([], text, text, null, noLoop);
    expect(failed).toMatchObject(data.searchFailedReply);
  });

  test("質問の語で質問で終わる返事、antiLoopで意見の返事を返す", async () => {
    const engine = new StubDialogueEngine(data);
    expect(await engine.reply([], data.questionTrigger, noLoop)).toMatchObject(data.questionReply);
    expect(await engine.reply([], data.questionTrigger, { antiLoop: true })).toMatchObject(
      data.antiLoopReply,
    );
  });

  test("別名を切り替えて返す", async () => {
    const engine = new StubDialogueEngine(data);
    engine.setModel("sub");
    expect((await engine.reply([], "x", noLoop)).model).toBe("sub");
  });
});
