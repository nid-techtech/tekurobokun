import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig, type Plugin } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// 無音検出（Silero VAD、@ricky0123/vad-web）が実行時に読むファイル。外から読み込まないよう、アプリに同梱する。
// vad-webは、モデルとワークレットを「baseAssetPath＋決まったファイル名」で、ONNX RuntimeのWASMを
// 「onnxWASMBasePath＋決まったファイル名」で読むため、ハッシュを付けずに /vad/ の下へそのままの名前で出す。
// 開発サーバーでは同じパスで配り、ビルドではdist/vad/に書き出す（src/voice/SileroDetector.tsのVAD_ASSET_PATH）。
const requireHere = createRequire(import.meta.url);
const vadPackage = requireHere.resolve("@ricky0123/vad-web/package.json");
const vadDist = join(dirname(vadPackage), "dist");
// onnxruntime-webはvad-webの依存なので、vad-webの場所から探す。
const requireVad = createRequire(vadPackage);
const VAD_ASSETS: Record<string, string> = {
  "silero_vad_v5.onnx": join(vadDist, "silero_vad_v5.onnx"),
  "vad.worklet.bundle.min.js": join(vadDist, "vad.worklet.bundle.min.js"),
  "ort-wasm-simd-threaded.wasm": requireVad.resolve("onnxruntime-web/ort-wasm-simd-threaded.wasm"),
  "ort-wasm-simd-threaded.mjs": requireVad.resolve("onnxruntime-web/ort-wasm-simd-threaded.mjs"),
};
const CONTENT_TYPES: Record<string, string> = {
  ".onnx": "application/octet-stream",
  ".wasm": "application/wasm",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
};

function vadAssets(): Plugin {
  return {
    name: "tekurobo-vad-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = /^\/vad\/([^?#]+)/.exec(req.url ?? "");
        const path = match?.[1] ? VAD_ASSETS[match[1]] : undefined;
        if (!match?.[1] || !path) return next();
        const ext = match[1].slice(match[1].lastIndexOf("."));
        res.setHeader("Content-Type", CONTENT_TYPES[ext] ?? "application/octet-stream");
        res.end(readFileSync(path));
      });
    },
    generateBundle() {
      for (const [name, path] of Object.entries(VAD_ASSETS)) {
        this.emitFile({ type: "asset", fileName: `vad/${name}`, source: readFileSync(path) });
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [vadAssets()],
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
