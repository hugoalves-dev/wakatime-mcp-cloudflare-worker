# WakaTime MCP for Cloudflare Workers

An authenticated remote MCP server for WakaTime summaries. The Worker exposes `wakatime_summaries` and `wakatime_today` over Streamable HTTP at `/mcp`. WakaTime API reads use a single account's OAuth 2.0 token; MCP clients authenticate via OAuth 2.1 (ChatGPT and other OAuth-capable clients).

## Configure WakaTime OAuth

Create an OAuth app at [wakatime.com/apps](https://wakatime.com/apps). Request the `read_summaries` scope and register the callback URL for each deployment, exactly as configured in the Worker environment. The production callback uses `https://<worker-name>.<account-subdomain>.workers.dev/oauth/callback`; local development uses `http://localhost:8787/oauth/callback`.

Configure `WAKATIME_OAUTH_CLIENT_ID` and `WAKATIME_OAUTH_REDIRECT_URI` as Worker secrets, along with `WAKATIME_OAUTH_CLIENT_SECRET` and `WAKATIME_OWNER_EMAIL`. Do not add these to `vars` in `wrangler.jsonc`; Wrangler deploys may overwrite dashboard-managed values.

The OAuth coordinator is a named Durable Object. Wrangler creates and migrates it during deployment; it serializes state consumption and token refreshes and stores the current token pair in strongly consistent Durable Object storage. Do not bind another application to this coordinator.


Wrangler invocation logs are disabled because Cloudflare includes full request URLs in those logs and the OAuth callback URL contains the one-use authorization code and state. Workers Logs remain enabled; the Worker does not log OAuth values.

## Authentication architecture

The Worker uses two OAuth flows:

1. ChatGPT discovers the MCP server at `/mcp`, registers through DCR or CIMD, and requests an OAuth authorization code using PKCE.
2. The consent page redirects the browser to WakaTime OAuth with `email read_summaries` scopes. The callback exchanges the code server-side, verifies the signed-in account against the configured `WAKATIME_OWNER_EMAIL`, and only then issues the MCP authorization code back to the client.

**Dynamic registration does not authenticate an account owner.** `WAKATIME_OWNER_EMAIL` is mandatory for new MCP client authorizations; missing or mismatched identities fail closed. Configure it as a Cloudflare Worker secret with the email address confirmed on your WakaTime account.

The old `MCP_AUTH_TOKEN` static bearer bypass, owner-password consent form, and `/oauth/start` endpoint are removed. Clients now authenticate exclusively via OAuth 2.1, while the separate `wakatime_connect` MCP tool can renew account authorization for already-authorized clients.

All client IDs, token exchanges and stored credentials remain server-side. The WakaTime OAuth app callback should be configured as:

```text
https://wakatime-mcp.hugoalves-java.workers.dev/oauth/callback
```

### Cloudflare secrets

Configure the following in the Worker environment before connecting a new client:

```text
WAKATIME_OAUTH_CLIENT_ID
WAKATIME_OAUTH_CLIENT_SECRET
WAKATIME_OAUTH_REDIRECT_URI
WAKATIME_OWNER_EMAIL
```

The owner email is an identity allowlist, not a shared password. Do not include secrets in `wrangler.jsonc`. The Worker persists WakaTime access and refresh tokens in its SQLite-backed Durable Object; MCP OAuth grant storage uses the `OAUTH_KV` namespace.

The previous Durable Object class could not be provisioned reliably by the earlier CI migration. A new `WakaTimeOAuthCoordinator` SQLite class uses migration `v2-wakatime-sqlite`; previously stored tokens in another Durable Object class are not automatically transferred.

### Local development

Use Node.js 24, `npm ci`, and `npm run dev`. For local OAuth, provide the four environment settings in an ignored `.dev.vars` file and update `ORIGIN` in `src/mcp-oauth.ts` to your local Worker URL.

### ChatGPT MCP

Use the URL `https://wakatime-mcp.hugoalves-java.workers.dev/mcp` and **OAuth** authentication. Choose DCR if available. Approve the MCP consent, then authorize the configured owner account on WakaTime. No manual MCP bearer token or owner password is required.

Tools: `wakatime_summaries`, `wakatime_today`, and `wakatime_connect`. Only `wakatime_connect` returns an upstream OAuth authorization link; it must be invoked from an already OAuth-authenticated MCP client.

## Checks and CI

Run local checks with:

```sh
npm test
npm run build
```

The build typechecks TypeScript and runs Wrangler's deployment dry run. Tests and build do not require live WakaTime or Cloudflare credentials.

GitHub Actions runs separate `test`, `build`, and `deploy` jobs. Deployment runs only on a push to `main`. Configure repository Actions secrets `CLOUDFLARE_API_TOKEN` with permission to deploy Workers and `CLOUDFLARE_ACCOUNT_ID` for the Cloudflare account. CI never reads or prints OAuth credentials or tokens.
