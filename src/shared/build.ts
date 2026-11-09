/** The build id, or "dev" where Vite never ran (integration tests, a bare `wrangler dev`). */
export const buildId = () => (typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev");

/** Paths the Hono app answers. Everything else is a page, rendered by TanStack Start. */
export const isWorkerOwned = (pathname: string) => pathname.startsWith("/api/") || pathname === "/api";
