// 入力ページのアイコン（PWA用のPNGとファビコン）を、マスターSVGから書き出す（T2-9）。
// 書き出しは機体アプリのTauri CLI（tauri icon）で行う。マスターSVGを変えたら、もう一度実行する。
//   bun run console:icons

import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const master = resolve(root, "docs/brand/tekurobokun_icon_master.svg");
const outDir = resolve(root, "apps/console/public/icons");
/** 32はファビコン、192・512はPWAのインストールに要る大きさ。 */
const sizes = [32, 192, 512];

const proc = Bun.spawn(
  [
    "bun",
    "run",
    "--filter",
    "@tekurobokun/robot",
    "tauri",
    "icon",
    master,
    "-o",
    outDir,
    "-p",
    sizes.join(","),
  ],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
const code = await proc.exited;
if (code !== 0) {
  console.error(`tauri icon が失敗した（終了コード ${code}）`);
  process.exit(code);
}
console.log(
  `書き出した：${sizes.map((s) => `${s}x${s}.png`).join("、")} → apps/console/public/icons/`,
);
