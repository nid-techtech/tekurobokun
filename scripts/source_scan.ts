// checkコマンドの検査で使う、ソースの読み込みとコメントの除去。

import { fileURLToPath } from "node:url";
import { Glob } from "bun";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** 検査の対象から外すパス（生成物・テスト・依存）。 */
const EXCLUDED = [/\/node_modules\//, /\/dist\//, /\/src\/paraglide\//, /\.test\.ts$/];

/**
 * ROOTからの相対パスで、パターンのどれかに合うファイルを返す（区切りは/）。
 * BunのGlobは入れ子の{}を扱わないため、パターンを分けて渡す。
 * 1件もなければ例外にする（検査が対象なしで黙って通るのを防ぐ）。
 */
export function listFiles(...patterns: string[]): string[] {
  const files = new Set<string>();
  for (const pattern of patterns) {
    for (const p of new Glob(pattern).scanSync({ cwd: ROOT })) files.add(p.replaceAll("\\", "/"));
  }
  const result = [...files].filter((p) => !EXCLUDED.some((re) => re.test(`/${p}`))).sort();
  if (result.length === 0) throw new Error(`検査の対象が見つからない: ${patterns.join(" ")}`);
  return result;
}

export function fileExists(relPath: string): Promise<boolean> {
  return Bun.file(`${ROOT}${relPath}`).exists();
}

export function readText(relPath: string): Promise<string> {
  return Bun.file(`${ROOT}${relPath}`).text();
}

const blank = (s: string) => s.replace(/[^\n]/g, " ");

/**
 * TypeScript・JavaScriptのコメントを空白に置き換える（改行は残すので行番号は変わらない）。
 * 文字列とテンプレートリテラルの中は残す。正規表現リテラルは扱わない。
 */
export function stripScriptComments(src: string): string {
  let out = "";
  let i = 0;
  // テンプレートの${}の入れ子。値は、その${の時点での波かっこの深さ。
  const templateStack: number[] = [];
  let braceDepth = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === "`" || (c === "}" && templateStack.at(-1) === braceDepth)) {
      if (c === "}") templateStack.pop();
      let j = i + 1;
      while (j < src.length && src[j] !== "`" && !(src[j] === "$" && src[j + 1] === "{")) {
        j += src[j] === "\\" ? 2 : 1;
      }
      if (src[j] === "$") {
        templateStack.push(braceDepth);
        out += src.slice(i, j + 2);
        i = j + 2;
      } else {
        out += src.slice(i, j + 1);
        i = j + 1;
      }
    } else {
      if (c === "{") braceDepth++;
      if (c === "}") braceDepth--;
      out += c;
      i++;
    }
  }
  return out;
}

/** CSSのコメントを空白に置き換える。 */
export function stripCssComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, blank);
}

/** HTMLのコメントを空白に置き換える。 */
export function stripHtmlComments(src: string): string {
  return src.replace(/<!--[\s\S]*?-->/g, blank);
}

export function stripComments(relPath: string, src: string): string {
  if (relPath.endsWith(".css")) return stripCssComments(src);
  if (relPath.endsWith(".html")) return stripHtmlComments(src);
  return stripScriptComments(src);
}

export type Finding = { file: string; line: number; text: string };

/** コメントを除いた本文から、パターンに合う箇所を行ごとに返す。 */
export function findInSource(relPath: string, src: string, pattern: RegExp): Finding[] {
  const global = new RegExp(pattern.source, "g");
  const findings: Finding[] = [];
  stripComments(relPath, src)
    .split("\n")
    .forEach((line, index) => {
      const matches = line.match(global);
      if (matches) findings.push({ file: relPath, line: index + 1, text: matches.join(" ") });
    });
  return findings;
}

export const formatFinding = (f: Finding) => `${f.file}:${f.line}  ${f.text}`;
