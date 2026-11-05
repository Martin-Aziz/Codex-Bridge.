import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist/public", emptyOutDir: true },
  server: { host: "127.0.0.1", proxy: { "/v1": { target: "http://127.0.0.1:49441", changeOrigin: true, configure: proxy => proxy.on("proxyReq", req => req.removeHeader("origin")) } } }
});
