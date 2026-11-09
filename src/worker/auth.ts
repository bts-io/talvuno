/**
 * Better Auth, email and password, one owner per deployment. Mounted at /api/auth/*.
 *
 * - Public sign-up is closed (`/sign-up/email` answers 404). The owner is created once, by POST /api/setup,
 *   through the server API. The `owner_claim` row (primary key id = 1) makes that atomic: a second account
 *   can never be created, even by two racing setup requests.
 * - Sessions live in D1 behind an HttpOnly, SameSite=Lax cookie, Secure on https (`__Secure-talvuno.session_token`).
 *   No cookie cache, so a sign-out applies at once. Better Auth checks Origin on its own state-changing routes;
 *   our routes do the same in src/worker/middleware.ts.
 * - Sign-in attempts are rate limited in D1 (`rate_limit`), so the limit holds across isolates.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { PASSWORD_MAX, PASSWORD_MIN } from "../contracts";
import { createDb, schema } from "./db";
import { OIDC_PROVIDER_ID, oidcConfig, oidcSignature } from "./oidc";

export const AUTH_BASE_PATH = "/api/auth";
export const COOKIE_PREFIX = "talvuno";

/** The deployment's public origin. Twilio callbacks and Better Auth both rely on it. */
export const publicOrigin = (env: Env) => new URL(env.PUBLIC_URL).origin;

function build(env: Env, secret: string) {
  const db = createDb(env.DB);
  const oidc = oidcConfig(env);
  const baseURL = publicOrigin(env);
  const secure = new URL(baseURL).protocol === "https:";
  return betterAuth({
    appName: "Talvuno",
    baseURL,
    basePath: AUTH_BASE_PATH,
    secret,
    trustedOrigins: [baseURL],
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        rateLimit: schema.rateLimit,
      },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN,
      maxPasswordLength: PASSWORD_MAX,
      autoSignIn: true,
    },
    disabledPaths: ["/sign-up/email", "/link-social"],
    plugins: oidc
      ? [
          genericOAuth({
            config: [
              {
                providerId: OIDC_PROVIDER_ID,
                discoveryUrl: oidc.discoveryUrl,
                clientId: oidc.clientId,
                clientSecret: oidc.clientSecret,
                scopes: ["openid", "email", "profile"],
                pkce: true,
                disableSignUp: true,
                // The single-owner guard for SSO, sign-in only. Anything but a verified email equal to the existing
                // owner's (including every attempt before an owner exists) maps to an empty email, which Better Auth
                // answers with an error redirect before it reads or writes any user or account row.
                mapProfileToUser: async (profile) => {
                  const email = typeof profile.email === "string" ? profile.email.trim().toLowerCase() : "";
                  const [claim] = await db
                    .select({ email: schema.ownerClaim.email })
                    .from(schema.ownerClaim)
                    .limit(1);
                  const allowed =
                    email !== "" &&
                    profile.emailVerified === true &&
                    claim !== undefined &&
                    claim.email.toLowerCase() === email;
                  if (!allowed) return { email: "", emailVerified: false };
                  const name = typeof profile.name === "string" ? profile.name.trim() : "";
                  return { email, emailVerified: true, name: name || email.split("@")[0] };
                },
              },
            ],
          }),
        ]
      : [],
    // The guard above already limits SSO to the owner's verified email, so the provider may link to the owner.
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: [OIDC_PROVIDER_ID],
        requireLocalEmailVerified: false,
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: env.RATE_LIMIT_DISABLED !== "true",
      storage: "database",
      window: 60,
      max: 60,
      customRules: { "/sign-in/email": { window: 60, max: 5 } },
    },
    telemetry: { enabled: false },
    databaseHooks: {
      user: {
        create: {
          // The single-owner guard. The insert fails on the primary key for any second account.
          before: async (u) => {
            const claimed = await db
              .insert(schema.ownerClaim)
              .values({ id: 1, email: u.email.toLowerCase(), claimedAt: new Date() })
              .onConflictDoNothing()
              .returning({ id: schema.ownerClaim.id });
            if (claimed.length === 0)
              throw new APIError("FORBIDDEN", {
                message: "This Talvuno already has an owner",
                code: "OWNER_EXISTS",
              });
            return { data: u };
          },
        },
      },
    },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      useSecureCookies: secure,
      defaultCookieAttributes: { httpOnly: true, secure, sameSite: "lax" },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      database: { generateId: () => crypto.randomUUID() },
    },
  });
}

export type Auth = ReturnType<typeof build>;
export type AuthUser = Auth["$Infer"]["Session"]["user"];
export type AuthSession = Auth["$Infer"]["Session"]["session"];

const cache = new WeakMap<Env, { signature: string; auth: Auth }>();

/** Better Auth for this Worker's env, or null when BETTER_AUTH_SECRET is not set (no accounts possible). */
export function createAuth(env: Env): Auth | null {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) return null;
  const signature = `${secret}|${oidcSignature(env)}`;
  let hit = cache.get(env);
  if (!hit || hit.signature !== signature) {
    hit = { signature, auth: build(env, secret) };
    cache.set(env, hit);
  }
  return hit.auth;
}
