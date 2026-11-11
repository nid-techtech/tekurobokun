// 原文の辞書（ja.json）から疑似ロケール（ja-x-pseudo.json）を生成する。
// 文字列を約4割伸ばし、全角の角かっこで囲む。プレースホルダ（{name}）は保つ。
// 直書きの取りこぼしと、長さによる崩れを画面で確かめるために使う（開発時だけ有効）。

import { pseudoMessages } from "../src/pseudo.ts";

const dir = new URL("../messages/", import.meta.url);
const source: Record<string, string> = await Bun.file(new URL("ja.json", dir)).json();
await Bun.write(
  new URL("ja-x-pseudo.json", dir),
  `${JSON.stringify(pseudoMessages(source), null, 2)}\n`,
);
