import type { Auth, AuthSession, AuthUser } from "./auth";
import type { Db } from "./db";

export type Variables = {
  db: Db;
  auth: Auth | null;
  user: AuthUser | null;
  session: AuthSession | null;
  requestId: string;
};

export type AppEnv = { Bindings: Env; Variables: Variables };
