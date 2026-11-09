---
title: Single sign-on
description: Optional sign-in through an OpenID Connect provider, with an Authentik walkthrough.
---

Sign-in with an OpenID Connect (OIDC) provider is optional and off by default. Email and password sign-in always works.

## Turn it on

It is on when all three of these are set. Set the secret with `bunx wrangler secret put`.

| Name | What it is for |
| --- | --- |
| `OIDC_DISCOVERY_URL` | The provider's `.well-known/openid-configuration` URL. |
| `OIDC_CLIENT_ID` | The client ID. |
| `OIDC_CLIENT_SECRET` | The client secret. |
| `OIDC_BUTTON_LABEL` | Optional. The button text. The default is "Sign in with SSO". |

## The callback URL

Register this redirect URI with the provider:

```text
${PUBLIC_URL}/api/auth/callback/oidc
```

For example, `https://talvuno.example.com/api/auth/callback/oidc`. Talvuno asks for the scopes `openid email profile` and uses PKCE.

## Only the owner can sign in

Talvuno still has one owner. A sign-in through the provider is accepted only when the provider reports the email as verified and it equals the owner's email, ignoring case. Anything else is refused, and no user or account is created.

SSO is sign-in only. The owner is always created on `/setup` first. Until then every SSO attempt is refused and the setup page shows no SSO button. Sign-up stays closed.

## Walkthrough with Authentik

1. In Authentik, open Applications, then Providers, and create an OAuth2/OpenID Provider. Use a confidential client. Set the redirect URI above as a strict match. Keep the default scopes (`openid`, `email`, `profile`).
2. Create an Application that uses this provider, and note its slug.
3. Copy the client ID and client secret from the provider.
4. Set `OIDC_DISCOVERY_URL` to `https://<your-authentik-host>/application/o/<slug>/.well-known/openid-configuration`. Set `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` to the values you copied.
5. Make sure the Authentik user has the owner's email address and that Authentik treats it as verified.

Other OIDC providers work the same way, as long as they publish a discovery document and report a verified email.

## If it is refused

The sign-in page shows "Single sign-on was refused" when the email does not match the owner's, or is not verified. Use the provider account whose verified email matches the owner. If the provider cannot be reached, the page offers email and password instead.
