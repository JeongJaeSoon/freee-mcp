import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { loadConfig } from '../config.js';
import { generatePKCE, buildAuthUrl } from '../auth/oauth.js';
import { generateApiKey } from '../auth/api-keys.js';
import { OAuthTokenResponseSchema } from '../auth/tokens.js';
import { createTokenData } from '../auth/token-utils.js';
import { TokenStore, UserTokenData } from '../store/token-store.js';
import { USER_AGENT } from '../constants.js';

// In-memory PKCE state store (short-lived, 5 min TTL)
const pendingSetups = new Map<string, { codeVerifier: string; createdAt: number }>();

// Cleanup expired entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of pendingSetups) {
    if (now - value.createdAt > 5 * 60 * 1000) {
      pendingSetups.delete(key);
    }
  }
}, 60 * 1000);

export function createSetupRouter(tokenStore: TokenStore, baseUrl: string): Router {
  const router = Router();

  // GET /setup - Show setup page
  router.get('/setup', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>freee MCP Setup</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 50px auto; padding: 0 20px; color: #333; }
    h1 { color: #2c3e50; }
    .btn { display: inline-block; padding: 12px 24px; background: #2ecc71; color: white; text-decoration: none; border-radius: 6px; font-size: 16px; }
    .btn:hover { background: #27ae60; }
    .note { background: #f8f9fa; padding: 16px; border-radius: 6px; margin-top: 20px; border-left: 4px solid #3498db; }
  </style>
</head>
<body>
  <h1>freee MCP Setup</h1>
  <p>freee アカウントを連携して、MCP サーバーを利用できるようにします。</p>
  <a href="/setup/auth" class="btn">freee アカウントで連携する</a>
  <div class="note">
    <p>連携が完了すると API Key が発行されます。</p>
    <p>API Key を MCP クライアントの設定に追加してください。</p>
  </div>
</body>
</html>`);
  });

  // GET /setup/auth - Start OAuth flow
  router.get('/setup/auth', async (_req: Request, res: Response) => {
    try {
      await loadConfig();
      const { codeVerifier, codeChallenge } = generatePKCE();
      const state = crypto.randomBytes(16).toString('hex');

      pendingSetups.set(state, { codeVerifier, createdAt: Date.now() });

      // Use server's callback URL instead of local redirect
      const redirectUri = `${baseUrl}/setup/callback`;
      const authUrl = buildAuthUrl(codeChallenge, state, redirectUri);
      res.redirect(authUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).send(`<h1>Error</h1><p>${message}</p>`);
    }
  });

  // GET /setup/callback - OAuth callback
  router.get('/setup/callback', async (req: Request, res: Response) => {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      res.status(400).send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Error</title></head>
<body><h1>Authentication Error</h1><p>${String(oauthError)}</p></body></html>`);
      return;
    }

    if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
      res.status(400).send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Error</title></head>
<body><h1>Error</h1><p>Missing required parameters.</p></body></html>`);
      return;
    }

    const pending = pendingSetups.get(state);
    if (!pending) {
      res.status(400).send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Error</title></head>
<body><h1>Error</h1><p>Invalid or expired state. Please try again.</p></body></html>`);
      return;
    }
    pendingSetups.delete(state);

    try {
      const config = await loadConfig();
      const redirectUri = `${baseUrl}/setup/callback`;

      // Exchange code for tokens
      const tokenResponse = await fetch(config.oauth.tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: config.freee.clientId,
          client_secret: config.freee.clientSecret,
          code,
          redirect_uri: redirectUri,
          code_verifier: pending.codeVerifier,
        }),
      });

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        throw new Error(`Token exchange failed: ${tokenResponse.status} ${errorText}`);
      }

      const jsonData: unknown = await tokenResponse.json();
      const parseResult = OAuthTokenResponseSchema.safeParse(jsonData);
      if (!parseResult.success) {
        throw new Error(`Invalid token response: ${parseResult.error.message}`);
      }

      const tokenData = createTokenData(parseResult.data, { scope: config.oauth.scope });

      // Generate API Key and store tokens
      const apiKey = generateApiKey();
      const userData: UserTokenData = {
        apiKey,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: tokenData.expires_at,
        companyId: '0', // Will be set when user calls freee_set_current_company
        createdAt: Date.now(),
      };

      await tokenStore.save(apiKey, userData);

      // Show API Key to user
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Setup Complete - freee MCP</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 50px auto; padding: 0 20px; color: #333; }
    h1 { color: #27ae60; }
    .key-box { background: #2c3e50; color: #2ecc71; padding: 16px; border-radius: 6px; font-family: monospace; font-size: 14px; word-break: break-all; cursor: pointer; }
    .config-box { background: #f8f9fa; padding: 16px; border-radius: 6px; font-family: monospace; font-size: 13px; white-space: pre; overflow-x: auto; }
    .warning { background: #fff3cd; padding: 12px; border-radius: 6px; border-left: 4px solid #ffc107; margin: 16px 0; }
  </style>
</head>
<body>
  <h1>Setup Complete!</h1>
  <p>Your API Key:</p>
  <div class="key-box" onclick="navigator.clipboard.writeText('${apiKey}')" title="Click to copy">${apiKey}</div>
  <div class="warning">This key will only be shown once. Please save it now.</div>
  <p>Add the following to your MCP client configuration:</p>
  <div class="config-box">{
  "mcpServers": {
    "freee": {
      "url": "${baseUrl}/mcp",
      "headers": {
        "Authorization": "Bearer ${apiKey}"
      }
    }
  }
}</div>
</body>
</html>`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Error</title></head>
<body><h1>Setup Error</h1><p>${message}</p></body></html>`);
    }
  });

  return router;
}
