import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { OAUTH_REDIRECT_URI, OAUTH_SCOPE, requireEnv } from "../../lib/env";
import { getTokens, saveTokens } from "../../lib/repo/tokens";
import { NamedError } from "../../lib/types";

export function oauthClient(): OAuth2Client {
  return new google.auth.OAuth2(
    requireEnv("GOOGLE_CLIENT_ID"),
    requireEnv("GOOGLE_CLIENT_SECRET"),
    OAUTH_REDIRECT_URI(),
  );
}

/**
 * access_type=offline AND prompt=consent are both required: without them Google
 * returns no refresh token on a repeat authorization and the next run silently
 * has no way to renew.
 */
export function consentUrl(state: string): string {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [OAUTH_SCOPE],
    state,
    include_granted_scopes: true,
  });
}

export async function exchangeCode(code: string): Promise<void> {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new NamedError(
      "no_refresh_token",
      "Google returned no refresh token. Revoke MyTube's access at " +
        "https://myaccount.google.com/permissions and run the login again.",
    );
  }
  saveTokens({
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token ?? null,
    expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
    scope: tokens.scope ?? OAUTH_SCOPE,
    tokenType: tokens.token_type ?? "Bearer",
  });
}

/** An authorized client, refreshing the access token when it is close to expiry. */
export async function authorizedClient(): Promise<OAuth2Client> {
  const row = getTokens();
  if (!row) {
    throw new NamedError(
      "not_authorized",
      "No Google account connected. Run `npm run oauth:login` (or click Connect Google in the UI).",
    );
  }
  const client = oauthClient();
  client.setCredentials({
    refresh_token: row.refresh_token,
    access_token: row.access_token ?? undefined,
    expiry_date: row.expires_at ? Date.parse(row.expires_at) : undefined,
  });
  // Persist refreshed tokens so a later process does not have to refresh again.
  client.on("tokens", (t) => {
    if (t.access_token) {
      saveTokens({
        refreshToken: t.refresh_token ?? row.refresh_token,
        accessToken: t.access_token,
        expiresAt: t.expiry_date ? new Date(t.expiry_date).toISOString() : null,
        scope: t.scope ?? row.scope,
        tokenType: t.token_type ?? row.token_type,
      });
    }
  });
  try {
    await client.getAccessToken();
  } catch (err) {
    throw new NamedError(
      "refresh_failed",
      `Google refused to refresh the token (${(err as Error).message}). Re-run \`npm run oauth:login\`.`,
    );
  }
  return client;
}

export function youtubeClient(auth: OAuth2Client) {
  return google.youtube({ version: "v3", auth });
}
