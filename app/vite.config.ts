import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// 前端（Vite + React）。root 指向 web/，build 輸出到 web-dist/（由 Fastify 服務）。
// dev 時 vite 跑在 5174，/api 反向代理到後端（預設 5173）。
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, "web-dist"),
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5173",
        changeOrigin: true,
      },
    },
  },
});
