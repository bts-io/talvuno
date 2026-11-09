import { defineConfig } from "drizzle-kit";

// Migrations are generated locally (`bun run db:generate`) into ./migrations and applied with
// `wrangler d1 migrations apply` (`bun run db:migrate:local` / `db:migrate:remote`; `bun run deploy` applies
// them remotely before it deploys). Never edit a migration that has been applied anywhere: add a new one.
export default defineConfig({
  dialect: "sqlite",
  casing: "snake_case",
  schema: "./src/worker/db/schema/index.ts",
  out: "./migrations",
});
