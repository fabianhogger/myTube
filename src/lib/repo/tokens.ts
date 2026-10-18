import { getDb, nowIso } from "../db";

export type TokenRow = {
  provider: string;
  access_token: string | null;
  refresh_token: string;
  expires_at: string | null;
  scope: string;
  token_type: string;
};

export function saveTokens(t: {
  refreshToken: string;
  accessToken?: string | null;
  expiresAt?: string | null;
  scope: string;
  tokenType?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, scope, token_type, updated_at)
       VALUES ('google', @access_token, @refresh_token, @expires_at, @scope, @token_type, @now)
       ON CONFLICT(provider) DO UPDATE SET
         access_token  = excluded.access_token,
         -- Google omits the refresh token on re-consent sometimes; never clobber it with NULL
         refresh_token = COALESCE(NULLIF(excluded.refresh_token, ''), oauth_tokens.refresh_token),
         expires_at    = excluded.expires_at,
         scope         = excluded.scope,
         token_type    = excluded.token_type,
         updated_at    = @now`,
    )
    .run({
      access_token: t.accessToken ?? null,
      refresh_token: t.refreshToken,
      expires_at: t.expiresAt ?? null,
      scope: t.scope,
      token_type: t.tokenType ?? "Bearer",
      now: nowIso(),
    });
}

export function getTokens(): TokenRow | undefined {
  return getDb().prepare("SELECT * FROM oauth_tokens WHERE provider = 'google'").get() as TokenRow | undefined;
}

export function updateAccessToken(accessToken: string, expiresAt: string): void {
  getDb()
    .prepare(
      `UPDATE oauth_tokens SET access_token = ?, expires_at = ?, updated_at = ?
       WHERE provider = 'google'`,
    )
    .run(accessToken, expiresAt, nowIso());
}

export function clearTokens(): void {
  getDb().prepare("DELETE FROM oauth_tokens WHERE provider = 'google'").run();
}
