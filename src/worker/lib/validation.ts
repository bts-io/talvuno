import type { Context } from "hono";

type Issue = { path: readonly PropertyKey[]; message: string };
type Result = { success: true } | { success: false; error: { issues: readonly Issue[] } };

/** zValidator hook: a failed body or query check answers 400 `{ error: "invalid", message, issues }`. */
export function validationHook(result: Result, c: Context): Response | undefined {
  if (result.success) return undefined;
  const issues = result.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
  return c.json({ error: "invalid", message: issues[0]?.message ?? "Invalid request", issues }, 400);
}
