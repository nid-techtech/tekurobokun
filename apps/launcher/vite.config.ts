import { defineConfig } from "vite";

// Tauriの開発サーバー（tauri devが開く）。機体アプリ（1420）と同時に開発できるよう、ポートを分ける。
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    host: false,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // 画面の初期化で、トップレベルのawaitを使う（WebView2は新しいChromium）。
  esbuild: { target: "es2022" },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
  },
});
