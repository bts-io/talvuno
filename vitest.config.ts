import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const bindings = async () => ({
  TEST_MIGRATIONS: await readD1Migrations("./migrations"),
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-1234",
  SETUP_TOKEN: "test-setup-token-0123456789abcdef",
  PUBLIC_URL: "https://talvuno.test",
  // wrangler.jsonc carries the production label; tests start from the default.
  OIDC_BUTTON_LABEL: "",
  // Test-only Twilio values: no real account. TWILIO_API_BASE points the REST client at a URL tests mock.
  TWILIO_AUTH_TOKEN: "test-auth-token",
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
  TWILIO_API_KEY_SID: "SK00000000000000000000000000000000",
  TWILIO_API_KEY_SECRET: "test-api-key-secret",
  TWILIO_TWIML_APP_SID: "AP00000000000000000000000000000000",
  TWILIO_API_BASE: "https://twilio.mock",
});

// Three projects: pure unit tests in Node, the Hono API and OwnerHub in workerd with a migrated D1, and the
// built Worker (vite build first) for server-rendered documents and the bundle check.
export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node" } },
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: "./wrangler.jsonc" },
            main: "./src/worker/index.ts",
            miniflare: { bindings: await bindings() },
          })),
        ],
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          setupFiles: ["./tests/integration/setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: "./dist/server/wrangler.json" },
            miniflare: { bindings: await bindings() },
          })),
        ],
        test: {
          name: "ssr",
          include: ["tests/ssr/**/*.test.ts"],
          setupFiles: ["./tests/integration/setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
