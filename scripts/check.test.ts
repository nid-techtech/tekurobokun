import { describe, expect, test } from "bun:test";
import { compareDicts, JAPANESE, placeholders, usedKeys } from "./check_i18n.ts";
import { COLOR, copyPairs, PX, unversioned } from "./check_tokens.ts";
import { findInSource, stripCssComments, stripScriptComments } from "./source_scan.ts";

describe("stripScriptComments", () => {
  test("行コメントとブロックコメントを消し、行番号を保つ", () => {
    const src = 'const a = 1; // 日本語\n/* 色 #fff\n 8px */\nconst b = "x";';
    const out = stripScriptComments(src);
    expect(out.split("\n")).toHaveLength(4);
    expect(out).not.toMatch(JAPANESE);
    expect(out).toContain('const b = "x";');
  });
  test("文字列とテンプレートの中は残す", () => {
    const src = `const u = "http://a"; const t = \`a $\{f({ x: "// b" })} // c\`; // d`;
    const out = stripScriptComments(src);
    expect(out).toContain('"http://a"');
    expect(out).toContain('"// b"');
    expect(out).toContain("// c`");
    expect(out).not.toContain("// d");
  });
});

test("stripCssComments", () => {
  expect(stripCssComments("a { /* #000 */ color: red; }")).not.toMatch(COLOR);
});

describe("直書きの検出", () => {
  test("日本語", () => {
    expect(findInSource("a.ts", 'el.textContent = "待機中";\n// 待機中', JAPANESE)).toEqual([
      { file: "a.ts", line: 1, text: "待機中" },
    ]);
    expect(findInSource("a.ts", 'm["status.ready"]()', JAPANESE)).toEqual([]);
  });
  test("色", () => {
    for (const s of ["#fff", "#0f0a", "#000000", "#00000080", "rgb(0,0,0)", "rgba(", "hsl("]) {
      expect(s).toMatch(COLOR);
    }
    for (const s of ["#facial-container", "#debug-hud", "var(--color-ink)"]) {
      expect(s).not.toMatch(COLOR);
    }
  });
  test("px", () => {
    expect("padding: 8px").toMatch(PX);
    expect("font: 13.5px").toMatch(PX);
    expect("offsetX(px)").not.toMatch(PX);
    expect("var(--space-2)").not.toMatch(PX);
  });
});

describe("i18n", () => {
  test("プレースホルダを集める", () => {
    expect(placeholders("{b}と{a}")).toBe("a,b");
  });
  test("キーの過不足とプレースホルダの不一致", () => {
    const source = { $schema: "s", "a.x": "{n}秒", "a.y": "y" };
    expect(compareDicts("en", source, { "a.x": "{n}s", "a.y": "y" })).toEqual([]);
    expect(compareDicts("en", source, { "a.x": "{m}s", "a.z": "z" })).toEqual([
      "en: プレースホルダが原文と違う a.x",
      "en: キーがない a.y",
      "en: 原文にないキー a.z",
    ]);
  });
  test("使っているキー", () => {
    expect(usedKeys('m["status.ready"](); m[ "input.autosend" ]({ seconds })')).toEqual([
      "status.ready",
      "input.autosend",
    ]);
  });
});

describe("トークン", () => {
  test("版を外した名前", () => {
    expect(unversioned("tekurobokun_icon_master_v12.svg")).toBe("tekurobokun_icon_master.svg");
  });
  test("写しとspecs/の組", () => {
    const { pairs, errors } = copyPairs([
      "x_SPEC_v1.md",
      "x_tokens_v2.css",
      "x_brand_v1.md",
      "x_icon_master_v3.svg",
    ]);
    expect(errors).toEqual([]);
    expect(pairs).toEqual([
      ["packages/theme/tokens.css", "roadmap/specs/x_tokens_v2.css"],
      ["docs/brand/x_brand.md", "roadmap/specs/x_brand_v1.md"],
      ["docs/brand/x_icon_master.svg", "roadmap/specs/x_icon_master_v3.svg"],
    ]);
  });
});
