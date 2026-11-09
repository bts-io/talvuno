import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * @twilio/voice-sdk is browser only. These checks fail the build if it can reach SSR or the Worker:
 * 1. only src/client/lib/voice-sdk.ts may name the package, and only through a dynamic import();
 * 2. after `vite build` (bun run test builds first), the server bundle must not contain the SDK.
 */
const ROOT = join(import.meta.dirname, "../..");
const HELPER = "src/client/lib/voice-sdk.ts";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe("voice SDK boundary", () => {
  it("is imported only by the lazy helper", () => {
    const offenders = files(join(ROOT, "src"))
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .map((f) => relative(ROOT, f))
      .filter((f) => f !== HELPER && readFileSync(join(ROOT, f), "utf8").includes("@twilio/voice-sdk"));
    expect(offenders).toEqual([]);
  });

  it("the helper never imports it statically", () => {
    const src = readFileSync(join(ROOT, HELPER), "utf8");
    expect(src).not.toMatch(/^\s*import\s+(?!type\b)[^;]*["']@twilio\/voice-sdk["']/m);
    expect(src).toMatch(/import\("@twilio\/voice-sdk"\)/);
  });

  const serverDir = join(ROOT, "dist/server");
  it.runIf(existsSync(serverDir))("the built Worker bundle does not contain the SDK", () => {
    const bundle = files(serverDir)
      .filter((f) => f.endsWith(".js"))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    // Strings that only exist inside the real SDK. The SSR stub in vite.config.ts may appear in the bundle (it
    // throws on use), so its marker is not a failure.
    for (const needle of ["voice-js.", "eventgw.twilio.com", "PStream"])
      expect(bundle.includes(needle), needle).toBe(false);
  });
});
