import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
    ...(publicHost && {
      allowedHosts: [publicHost],
      hmr: { host: publicHost, protocol: "wss", clientPort: 443 },
    }),
  },
});
