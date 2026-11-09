#!/usr/bin/env bun
// Generates src/client/routeTree.gen.ts without starting Vite, so `bun run check` works on a clean clone.
// `vite dev` / `vite build` regenerate it through the TanStack Start plugin; the output is gitignored.
import { fileURLToPath } from "node:url";
import { Generator, getConfig } from "@tanstack/router-generator";

const root = fileURLToPath(new URL("..", import.meta.url));
const config = getConfig(
  {
    routesDirectory: "src/client/routes",
    generatedRouteTree: "src/client/routeTree.gen.ts",
    autoCodeSplitting: true,
  },
  root,
);
await new Generator({ config, root }).run();
console.log("routeTree.gen.ts up to date");
