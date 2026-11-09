import { applyD1Migrations, env } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      /** Set by vitest.config.ts from ./migrations. */
      /** Set by vitest.config.ts. */
      SETUP_TOKEN: string;
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
