// トークンの検査：packages/theme/tokens.css・docs/brand/ と roadmap/specs/ の一致、
// apps/*/src の色（#…・rgb(…）とpxの直書き。

import { fileExists, findInSource, formatFinding, listFiles, readText } from "./source_scan.ts";

/** 色の直書き（#rgb・#rgba・#rrggbb・#rrggbbaa、rgb()・hsl()など）。 */
export const COLOR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgba?|hsla?)\(/;
/** pxの直書き。 */
export const PX = /\b\d+(?:\.\d+)?px\b/;

/** specs/の版つきのファイル名（tekurobokun_tokens_v1.css）から、版を外した名前を返す。 */
export const unversioned = (name: string) => name.replace(/_v\d+(\.[^.]+)$/, "$1");

/** 写しとspecs/の正本の組。 */
export function copyPairs(specNames: string[]): { pairs: [string, string][]; errors: string[] } {
  const errors: string[] = [];
  const pairs: [string, string][] = [];
  const tokens = specNames.filter((n) => /_tokens_v\d+\.css$/.test(n));
  if (tokens.length !== 1) errors.push(`specs/のトークンが1つでない（${tokens.length}件）`);
  for (const n of tokens) pairs.push(["packages/theme/tokens.css", `roadmap/specs/${n}`]);
  for (const n of specNames.filter((n) => /_(brand_v\d+\.md|icon_master_v\d+\.svg)$/.test(n))) {
    pairs.push([`docs/brand/${unversioned(n)}`, `roadmap/specs/${n}`]);
  }
  return { pairs, errors };
}

export async function checkTokens(): Promise<string[]> {
  const specNames = listFiles("roadmap/specs/*").map((p) => p.slice("roadmap/specs/".length));
  const { pairs, errors } = copyPairs(specNames);
  for (const [copy, spec] of pairs) {
    if (!(await fileExists(copy))) errors.push(`写しがない ${copy}（${spec}）`);
    else if ((await readText(copy)) !== (await readText(spec))) {
      errors.push(`specs/と一致しない ${copy}（${spec}）`);
    }
  }

  for (const file of listFiles("apps/*/src/**/*.{ts,css,html}", "apps/*/index.html")) {
    const src = await readText(file);
    for (const f of findInSource(file, src, COLOR)) errors.push(`色の直書き ${formatFinding(f)}`);
    for (const f of findInSource(file, src, PX)) errors.push(`pxの直書き ${formatFinding(f)}`);
  }
  return errors;
}
