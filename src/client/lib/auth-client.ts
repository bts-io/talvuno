import { createAuthClient } from "better-auth/react";

/** Browser side of Better Auth: sign in and sign out. The owner is created by POST /api/setup, not here. */
export const authClient = createAuthClient({ basePath: "/api/auth" });
