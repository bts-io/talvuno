import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The Twilio Voice SDK needs a browser (WebRTC, AudioContext) and must never reach the Worker bundle. The client
// loads it lazily through src/client/lib/voice-sdk.ts. If anything ever imports it during SSR, the server build
// gets a module that throws on first use instead of the real SDK, and tests/unit/voice-sdk-boundary.test.ts fails the build.
const noVoiceSdkOnServer: Plugin = {
  name: "no-voice-sdk-on-server",
  enforce: "pre",
  resolveId(id) {
    if (
      this.environment?.name === "ssr" &&
      (id === "@twilio/voice-sdk" || id.startsWith("@twilio/voice-sdk/"))
    )
      return "\0voice-sdk-stub";
  },
  load(id) {
    if (id === "\0voice-sdk-stub")
      return 'export const __TALVUNO_VOICE_SDK_STUB__ = true; export class Device { constructor() { throw new Error("@twilio/voice-sdk is browser only"); } }';
  },
};

const BUILD_ID = Date.now().toString(36);

// public/sw.js is copied as is, so its version placeholder is filled in after the client bundle is written.
// Every build then ships a different sw.js, which is what makes browsers install the new worker.
const stampServiceWorker: Plugin = {
  name: "stamp-service-worker",
  apply: "build",
  closeBundle: {
    order: "post",
    handler() {
      if (this.environment?.name !== "client") return;
      const file = join(process.cwd(), "dist", "client", "sw.js");
      if (existsSync(file))
        writeFileSync(file, readFileSync(file, "utf8").replaceAll("__BUILD_ID__", BUILD_ID));
    },
  },
};

export default defineConfig(() => ({
  define: {
    // Baked into the Worker bundle so logs and /api/health can name the build.
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  plugins: [
    noVoiceSdkOnServer,
    stampServiceWorker,
    cloudflare({ configPath: "./wrangler.jsonc", viteEnvironment: { name: "ssr" } }),
    tanstackStart({
      srcDirectory: "src/client",
      router: {
        entry: "router.tsx",
        routesDirectory: "routes",
        generatedRouteTree: "routeTree.gen.ts",
      },
      client: { entry: "client.tsx" },
      server: { entry: "../server.ts" },
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    sourcemap: true,
  },
}));
