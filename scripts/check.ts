// checkコマンド（bun run check）。型検査・lint・テスト・i18n・トークンの検査を順に実行し、
// 通った検査は1行、失敗した検査は失敗した部分だけを表示する。CIも同じコマンドを呼ぶ。

import { checkI18n } from "./check_i18n.ts";
import { checkTokens } from "./check_tokens.ts";
import { ROOT } from "./source_scan.ts";

type Result = { ok: boolean; detail: string[]; warnings?: string[] };
type Step = { name: string; run: () => Promise<Result> };

/** コマンドを実行し、失敗したときだけ、filterで絞った出力を返す。 */
function command(cmd: string[], filter: (line: string) => boolean = () => true) {
  return async (): Promise<Result> => {
    const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code === 0) return { ok: true, detail: [] };
    const lines = `${out}\n${err}`.split(/\r?\n/).filter((l) => l.trim() !== "");
    const filtered = lines.filter(filter);
    return { ok: false, detail: filtered.length > 0 ? filtered : lines.slice(-30) };
  };
}

const steps: Step[] = [
  {
    // 辞書の変更を型に反映してから型検査する。
    name: "i18nのコンパイル",
    run: command(["bun", "run", "--filter", "@tekurobokun/i18n", "compile:messages"], (l) =>
      /error|warn/i.test(l),
    ),
  },
  {
    name: "tsc（全ワークスペース）",
    run: command(["bun", "run", "--filter", "*", "typecheck"], (l) => /error TS/.test(l)),
  },
  {
    name: "tsc（scripts）",
    run: command(["bun", "x", "tsc", "-p", "."], (l) => /error TS/.test(l)),
  },
  {
    // 1件を1行で出す（::error file=…,line=…::内容）。
    name: "Biome",
    run: command(
      ["bun", "x", "biome", "check", "--reporter=github", "--max-diagnostics=50", "."],
      (l) => l.startsWith("::"),
    ),
  },
  { name: "bun test", run: command(["bun", "test", "--only-failures"]) },
  {
    name: "i18nの検査",
    run: async () => {
      const { errors, warnings } = await checkI18n();
      return { ok: errors.length === 0, detail: errors, warnings };
    },
  },
  {
    name: "トークンの検査",
    run: async () => {
      const errors = await checkTokens();
      return { ok: errors.length === 0, detail: errors };
    },
  },
];

let failed = 0;
for (const step of steps) {
  const result = await step
    .run()
    .catch(
      (e: unknown): Result => ({ ok: false, detail: [e instanceof Error ? e.message : String(e)] }),
    );
  console.log(`${result.ok ? "✓" : "✗"} ${step.name}`);
  for (const line of result.detail) console.log(`    ${line}`);
  for (const line of result.warnings ?? []) console.log(`    (警告) ${line}`);
  if (!result.ok) failed++;
}

console.log(failed === 0 ? "\ncheck: すべて通過" : `\ncheck: ${failed}件の検査が失敗`);
process.exit(failed === 0 ? 0 : 1);
