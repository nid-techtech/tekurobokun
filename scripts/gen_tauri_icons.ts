// Tauriのアプリ（機体アプリ・ランチャー）のアイコン（Windowsのicon.ico、macOSのicon.icns、各サイズのPNG）を、
// マスターSVGから書き出す（T5-4・T10-1）。書き出しは各アプリのTauri CLI（tauri icon）で行い、
// apps/{アプリ}/src-tauri/icons/ を置き換える。マスターSVGを変えたら、もう一度実行する。
// 入力ページのアイコンは gen_console_icons.ts。
//   bun run robot:icons      （= bun scripts/gen_tauri_icons.ts robot）
//   bun run launcher:icons   （= bun scripts/gen_tauri_icons.ts launcher）

import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const APPS = ["robot", "launcher"] as const;
type App = (typeof APPS)[number];

const app = process.argv[2] as App | undefined;
if (!app || !APPS.includes(app)) {
  console.error(`usage: bun scripts/gen_tauri_icons.ts ${APPS.join("|")}`);
  process.exit(2);
}

const root = resolve(import.meta.dir, "..");
const master = resolve(root, "docs/brand/tekurobokun_icon_master.svg");
const outDir = resolve(root, `apps/${app}/src-tauri/icons`);

const proc = Bun.spawn(
  ["bun", "run", "--filter", `@tekurobokun/${app}`, "tauri", "icon", master, "-o", outDir],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
const code = await proc.exited;
if (code !== 0) {
  console.error(`tauri icon が失敗した（終了コード ${code}）`);
  process.exit(code);
}
// tauri iconはAndroid・iOS用も書き出すが、どちらのアプリもデスクトップ（Windows）だけなので消す。
for (const dir of ["android", "ios"]) {
  await rm(resolve(outDir, dir), { recursive: true, force: true });
}
console.log(`書き出した：apps/${app}/src-tauri/icons/`);
