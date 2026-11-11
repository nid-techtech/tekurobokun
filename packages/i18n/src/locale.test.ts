import { describe, expect, test } from "bun:test";
import { intlLocale, isAllowedLocale, PSEUDO_LOCALE, publicLocales, resolveLocale } from "./locale.ts";

describe("resolveLocale", () => {
  test("URLの指定を優先する", () => {
    expect(resolveLocale({ query: "ja", current: "ja", dev: false })).toBe("ja");
  });
  test("開発時は?locale=pseudoで疑似ロケールになる", () => {
    expect(resolveLocale({ query: "pseudo", current: "ja", dev: true })).toBe(PSEUDO_LOCALE);
    expect(resolveLocale({ query: PSEUDO_LOCALE, current: "ja", dev: true })).toBe(PSEUDO_LOCALE);
  });
  test("公開版では疑似ロケールを使わない（URLでも保持でも）", () => {
    expect(resolveLocale({ query: "pseudo", current: "ja", dev: false })).toBe("ja");
    expect(resolveLocale({ query: null, current: PSEUDO_LOCALE, dev: false })).toBe("ja");
  });
  test("保持しているロケールを使う", () => {
    expect(resolveLocale({ query: null, current: PSEUDO_LOCALE, dev: true })).toBe(PSEUDO_LOCALE);
  });
  test("知らないロケールは原文の言語にフォールバックする", () => {
    expect(resolveLocale({ query: "fr", current: "de", dev: true })).toBe("ja");
    expect(resolveLocale({ query: "", current: "", dev: false })).toBe("ja");
  });
});

test("公開版の言語に疑似ロケールを含めない", () => {
  expect(publicLocales).toEqual(["ja"]);
  expect(isAllowedLocale(PSEUDO_LOCALE, false)).toBe(false);
  expect(isAllowedLocale(PSEUDO_LOCALE, true)).toBe(true);
});

test("Intlには疑似ロケールの代わりに原文の言語を渡す", () => {
  expect(intlLocale(PSEUDO_LOCALE)).toBe("ja");
  expect(intlLocale("ja")).toBe("ja");
});
