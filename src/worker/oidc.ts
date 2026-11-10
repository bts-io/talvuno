/** Optional OpenID Connect sign-in. Off unless the discovery URL, client id and client secret are all set. */
export const OIDC_PROVIDER_ID = "oidc";
export const DEFAULT_OIDC_LABEL = "Sign in with SSO";
/** AGPL section 13: where users of a running copy can get its source. Forks point SOURCE_URL at their own. */
export const DEFAULT_SOURCE_URL = "https://github.com/bts-io/talvuno";

export function oidcConfig(env: Env) {
  const discoveryUrl = env.OIDC_DISCOVERY_URL?.trim();
  const clientId = env.OIDC_CLIENT_ID?.trim();
  const clientSecret = env.OIDC_CLIENT_SECRET?.trim();
  if (!discoveryUrl || !clientId || !clientSecret) return null;
  return { discoveryUrl, clientId, clientSecret };
}

export const oidcEnabled = (env: Env) => oidcConfig(env) !== null;

/** Changes whenever the SSO settings do, so a cached Better Auth instance is rebuilt. */
export const oidcSignature = (env: Env) => {
  const c = oidcConfig(env);
  return c ? `${c.discoveryUrl}|${c.clientId}|${c.clientSecret}` : "off";
};

/** Only http and https links may reach the About page: anything else (javascript:, data:) falls back to the default. */
export function safeSourceUrl(raw: string | undefined) {
  const value = raw?.trim();
  if (!value) return DEFAULT_SOURCE_URL;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:" ? value : DEFAULT_SOURCE_URL;
  } catch {
    return DEFAULT_SOURCE_URL;
  }
}

/** What the login, setup and Settings screens may know: whether to show the SSO button, its label, and the source link. */
export const authConfig = (env: Env) => ({
  oidc: oidcEnabled(env),
  oidcLabel: env.OIDC_BUTTON_LABEL?.trim() || DEFAULT_OIDC_LABEL,
  sourceUrl: safeSourceUrl(env.SOURCE_URL),
});
