import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { buildMetaName, buildVersionFile } from "./src/lib/web-build";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Public hostname when the dev server sits behind a TLS reverse proxy
// (e.g. dev.example.com on :443). The browser must reach HMR through the
// proxy, not the local port.
const publicHost = process.env.FOUNDRY_WEB_PUBLIC_HOST?.trim();

/**
 * Names the build after what it contains: a hash of its output files' names,
 * which carry their contents' hashes, so a rebuild of the same sources keeps
 * the name. The page carries it in a meta tag of index.html; the deployment
 * says which build it serves in version.json, next to index.html, so a page
 * finds out a newer build was deployed from whatever serves the files.
 */
function foundryBuildVersion(): Plugin {
  let build: string | undefined;
  return {
    name: "foundry-build-version",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, { bundle }) {
        const files = Object.keys(bundle ?? {})
          .filter((file) => !file.endsWith(".html"))
          .sort();
        build = createHash("sha256")
          .update(files.join("\n"))
          .digest("hex")
          .slice(0, 16);
        return [
          {
            tag: "meta",
            attrs: { name: buildMetaName, content: build },
            injectTo: "head",
          },
        ];
      },
    },
    generateBundle: {
      order: "post",
      handler() {
        if (!build) this.error("index.html was not built: no build name");
        this.emitFile({
          type: "asset",
          fileName: buildVersionFile,
          source: `${JSON.stringify({ build })}\n`,
        });
      },
    },
  };
}

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
  plugins: [react(), foundryBuildVersion()],
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
