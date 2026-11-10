/** Set by `define` in vite.config.ts at build time; unset under the integration tests, which skip Vite. */
declare const __BUILD_ID__: string | undefined;

/**
 * Worker secrets, which `wrangler types` cannot see from a clean checkout. Set them with `wrangler secret put`
 * (production) or in `.dev.vars` (local). Optional here because the Worker must start and answer /setup and
 * /api/health before Twilio is configured; each feature checks for the ones it needs.
 */
interface Env {
  BETTER_AUTH_SECRET?: string;
  /** Required by POST /api/setup. Without it, setup is refused with 503. */
  SETUP_TOKEN?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_API_KEY_SID?: string;
  TWILIO_API_KEY_SECRET?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_TWIML_APP_SID?: string;
  /** Tests only: replaces https://api.twilio.com so the REST client can be pointed at a mock. */
  TWILIO_API_BASE?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /** Optional single sign-on. Enabled only when the first three are all set (src/worker/oidc.ts). */
  OIDC_DISCOVERY_URL?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_BUTTON_LABEL?: string;
  /** AGPL section 13: the source link shown in Settings. Defaults to the upstream repository. Point it at your fork if you modify Talvuno. */
  SOURCE_URL?: string;
  /** "true" sends Content-Security-Policy-Report-Only instead of enforcing the policy. For debugging a self-hosted install. */
  CSP_REPORT_ONLY?: string;
  /** Tests only: turns off Better Auth's sign-in rate limit. */
  RATE_LIMIT_DISABLED?: string;
}
