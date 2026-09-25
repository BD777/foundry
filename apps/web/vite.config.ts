import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Public hostname when the dev server sits behind a TLS reverse proxy
// (e.g. dev.example.com on :443). The browser must reach HMR through the
// proxy, not the local port.
const publicHost = process.env.FOUNDRY_WEB_PUBLIC_HOST?.trim();

export default defineConfig({
  build: {
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          "icons-vendor": ["lucide-react"],
          "chat-vendor": ["react-virtuoso", "streamdown"],
          "react-vendor": ["react", "react-dom/client", "react/jsx-runtime"],
          "ui-vendor": [
            "@radix-ui/react-context-menu",
            "@radix-ui/react-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-scroll-area",
            "@radix-ui/react-slot",
            "@radix-ui/react-toggle-group",
            "@radix-ui/react-tooltip",
          ],
        },
      },
    },
  },
  plugins: [react()],
  optimizeDeps: { include: ["react-diff-view", "diff"] },
  server: {
    port: 31983,
    // Serve only the web app and what it imports. Vite's default is the whole
    // pnpm workspace, which exposes server data such as apps/server/.data
    // (database, secret key) to anyone who can reach this port.
    fs: {
      allow: [
        at("./"),
        at("../../packages/protocol"),
        at("../../node_modules"),
      ],
      deny: [".env", ".env.*", "*.{crt,pem,key}", "**/.data/**"],
    },
    ...(publicHost && {
      allowedHosts: [publicHost],
      hmr: { host: publicHost, protocol: "wss", clientPort: 443 },
    }),
  },
});
