import { Hono } from "hono";
import { ApiError } from "../lib/errors";
import { hubFor } from "../lib/hub";
import { requireOwner, sameOriginUpgrade } from "../middleware";
import type { AppEnv } from "../types";

/** GET /api/live: upgrades to a WebSocket held by the owner's OwnerHub. Mounted at /api/live. */
export const live = new Hono<AppEnv>();

live.get("/", requireOwner, sameOriginUpgrade, async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
    throw new ApiError(426, "upgrade_required", "Expected a WebSocket upgrade");
  return hubFor(c.env, c.get("user")!.id).fetch(c.req.raw);
});
