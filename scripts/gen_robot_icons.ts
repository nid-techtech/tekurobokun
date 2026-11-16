// 機体アプリのアイコン（Windowsのicon.ico、macOSのicon.icns、各サイズのPNG）を、マスターSVGから書き出す（T5-4）。
// 書き出しは機体アプリのTauri CLI（tauri icon）で行い、apps/robot/src-tauri/icons/ を置き換える。
// マスターSVGを変えたら、もう一度実行する。入力ページのアイコンは gen_console_icons.ts。
//   bun run robot:icons

import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const master = resolve(root, "docs/brand/tekurobokun_icon_master.svg");
const outDir = resolve(root, "apps/robot/src-tauri/icons");

const proc = Bun.spawn(
  ["bun", "run", "--filter", "@tekurobokun/robot", "tauri", "icon", master, "-o", outDir],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
const code = await proc.exited;
if (code !== 0) {
  console.error(`tauri icon が失敗した（終了コード ${code}）`);
  process.exit(code);
}
// tauri iconはAndroid・iOS用も書き出すが、機体アプリはデスクトップ（Windows）だけなので消す。
for (const dir of ["android", "ios"]) {
  await rm(resolve(outDir, dir), { recursive: true, force: true });
}
console.log("書き出した：apps/robot/src-tauri/icons/");
