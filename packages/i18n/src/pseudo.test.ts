import { expect, test } from "bun:test";
import { pseudoMessages, pseudoText } from "./pseudo.ts";

test("文字列を約4割伸ばして囲む", () => {
  expect(pseudoText("待機中")).toBe("［待機中～］");
  expect(pseudoText("つながっていません")).toBe("［つながっていません～～～～］");
});

test("プレースホルダは保ち、伸ばす量の計算から外す", () => {
  expect(pseudoText("{seconds}秒後に送ります")).toBe("［{seconds}秒後に送ります～～～］");
});

test("$schemaはそのまま残す", () => {
  expect(pseudoMessages({ $schema: "x", "a.b": "あ" })).toEqual({
    $schema: "x",
    "a.b": "［あ～］",
  });
});
