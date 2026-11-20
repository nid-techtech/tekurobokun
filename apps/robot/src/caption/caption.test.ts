import { describe, expect, test } from "bun:test";
import { captionFor } from "./caption";

describe("captionFor（モックS02f）", () => {
  test("考え中は来場者の発言を出す", () => {
    expect(captionFor({ session: "thinking", userText: "こんにちは", sentence: null })).toEqual({
      speaker: "you",
      text: "こんにちは",
    });
  });

  test("読み上げている文があれば、テクロボくんの発言を出す", () => {
    expect(captionFor({ session: "speaking", userText: "こんにちは", sentence: "やあ" })).toEqual({
      speaker: "robot",
      text: "やあ",
    });
  });

  test("話し中でも読み上げの前と文の間は出さない", () => {
    expect(captionFor({ session: "speaking", userText: "こんにちは", sentence: null })).toBeNull();
  });

  test("待機中とつながっていないときは出さない", () => {
    expect(captionFor({ session: "idle", userText: "こんにちは", sentence: null })).toBeNull();
    expect(captionFor({ session: null, userText: null, sentence: null })).toBeNull();
  });

  test("調べ中は、前置きの読み上げ中はその文、読み上げの後は検索語（S02i）", () => {
    const base = { session: "searching" as const, userText: "東京タワーの高さは？" };
    expect(captionFor({ ...base, sentence: "調べるね。", searchQuery: "東京タワー 高さ" })).toEqual(
      {
        speaker: "robot",
        text: "調べるね。",
      },
    );
    expect(captionFor({ ...base, sentence: null, searchQuery: "東京タワー 高さ" })).toEqual({
      speaker: "search",
      text: "東京タワー 高さ",
    });
    expect(captionFor({ ...base, sentence: null, searchQuery: null })).toBeNull();
    // 考え中に戻っても検索語は出さない
    expect(
      captionFor({ session: "thinking", userText: "a", sentence: null, searchQuery: "q" }),
    ).toEqual({ speaker: "you", text: "a" });
  });

  test("考え中でも発言がなければ出さない", () => {
    expect(captionFor({ session: "thinking", userText: null, sentence: null })).toBeNull();
  });
});
