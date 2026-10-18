/**
 * Loopback OAuth consent for the YouTube Data API. Starts a tiny local server
 * on the redirect URI so the app itself does not need to be running.
 */
import crypto from "node:crypto";
import http from "node:http";
import { exec } from "node:child_process";
import { BASE_URL, OAUTH_REDIRECT_URI } from "../src/lib/env";
import { consentUrl, exchangeCode } from "../src/ingest/google/oauth";
import { getTokens } from "../src/lib/repo/tokens";
import { logger } from "../src/lib/log";

const log = logger("oauth:login");

async function main() {
  const state = crypto.randomBytes(16).toString("hex");
  const url = consentUrl(state);
  const redirect = new URL(OAUTH_REDIRECT_URI());
  const port = Number(redirect.port || 80);

  const done = new Promise<void>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url ?? "/", BASE_URL());
      if (reqUrl.pathname !== redirect.pathname) {
        res.writeHead(404).end("not found");
        return;
      }
      const error = reqUrl.searchParams.get("error");
      const code = reqUrl.searchParams.get("code");
      const gotState = reqUrl.searchParams.get("state");

      const finish = (status: number, body: string, err?: Error) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(
          `<!doctype html><meta charset="utf-8"><title>MyTube</title>
           <body style="font:16px system-ui;padding:3rem;max-width:34rem">${body}</body>`,
        );
        server.close();
        if (err) reject(err);
        else resolve();
      };

      if (error) return finish(400, `<h1>Denied</h1><p>Google returned: ${error}</p>`, new Error(error));
      if (gotState !== state) return finish(400, "<h1>State mismatch</h1>", new Error("state mismatch"));
      if (!code) return finish(400, "<h1>No code</h1>", new Error("no code in callback"));

      try {
        await exchangeCode(code);
        finish(200, "<h1>Connected</h1><p>You can close this tab and return to the terminal.</p>");
      } catch (err) {
        finish(500, `<h1>Token exchange failed</h1><pre>${(err as Error).message}</pre>`, err as Error);
      }
    });
    server.listen(port, () => log.info(`listening on ${OAUTH_REDIRECT_URI()}`));
    server.on("error", reject);
  });

  log.info("opening the Google consent screen. If it does not open, visit:\n\n" + url + "\n");
  exec(`xdg-open ${JSON.stringify(url)}`, () => {});

  await done;
  const row = getTokens();
  log.info(`refresh token stored (scope: ${row?.scope}). \`npm run ingest\` can now read your subscriptions.`);
}

main().catch((err) => {
  console.error(`\nOAuth login failed: ${err.message}`);
  process.exit(1);
});
