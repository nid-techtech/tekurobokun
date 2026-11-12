import { defineConfig } from "vite";

// 開発時は、入力ページをViteで配信し、WebSocket（/ws）をバックエンドへ中継する。
// バックエンドの接続先は、環境変数BACKEND_URLで変えられる（既定はconfig/backend.default.jsonのポート）。
const backend = process.env.BACKEND_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  server: {
    // タブレットからLANで開けるようにする
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      "/ws": { target: backend.replace(/^http/, "ws"), ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
