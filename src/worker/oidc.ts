/** Optional OpenID Connect sign-in. Off unless the discovery URL, client id and client secret are all set. */
export const OIDC_PROVIDER_ID = "oidc";
export const DEFAULT_OIDC_LABEL = "Sign in with SSO";

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

/** What the login and setup screens may know: whether to show the button, and its label. */
export const authConfig = (env: Env) => ({
  oidc: oidcEnabled(env),
  oidcLabel: env.OIDC_BUTTON_LABEL?.trim() || DEFAULT_OIDC_LABEL,
});
