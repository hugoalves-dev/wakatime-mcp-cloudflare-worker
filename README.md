# WakaTime MCP for Cloudflare Workers

An authenticated remote MCP server for WakaTime summaries. The Worker exposes `wakatime_summaries` and `wakatime_today` over Streamable HTTP at `/mcp`. WakaTime API reads use a single account's OAuth 2.0 token; MCP clients may authenticate via OAuth 2.1 (ChatGPT and other OAuth-capable clients) or the existing static `MCP_AUTH_TOKEN` bearer credential.

## Configure WakaTime OAuth

Create an OAuth app at [wakatime.com/apps](https://wakatime.com/apps). Request the `read_summaries` scope and register the callback URL for each deployment, exactly as configured in the Worker environment. The production callback uses `https://<worker-name>.<account-subdomain>.workers.dev/oauth/callback`; local development uses `http://localhost:8787/oauth/callback`.

Configure `WAKATIME_OAUTH_CLIENT_ID` and `WAKATIME_OAUTH_REDIRECT_URI` as Worker secrets, along with `WAKATIME_OAUTH_CLIENT_SECRET` and `MCP_AUTH_TOKEN`. Do not add these to `vars` in `wrangler.jsonc`; Wrangler deploys may overwrite dashboard-managed values.

The OAuth coordinator is a named Durable Object. Wrangler creates and migrates it during deployment; it serializes state consumption and token refreshes and stores the current token pair in strongly consistent Durable Object storage. Do not bind another application to this coordinator.


Wrangler invocation logs are disabled because Cloudflare includes full request URLs in those logs and the OAuth callback URL contains the one-use authorization code and state. Workers Logs remain enabled; the Worker does not log OAuth values.

## Local development

Use Node.js 24 and npm. Create an ignored `.dev.vars` file with the OAuth settings and a long random MCP token:

```text
WAKATIME_OAUTH_CLIENT_ID=<your WakaTime OAuth client ID>
WAKATIME_OAUTH_CLIENT_SECRET=<your WakaTime OAuth client secret>
WAKATIME_OAUTH_REDIRECT_URI=http://localhost:8787/oauth/callback
MCP_AUTH_TOKEN=<a long random token for MCP clients>
```

Install dependencies and start the Worker:

```sh
npm ci
npm run dev
```

The MCP endpoint is `http://localhost:8787/mcp`. Clients can use the existing `Authorization: Bearer <MCP_AUTH_TOKEN>` header, or OAuth 2.1 authorization on a deployed instance. For local OAuth testing, change the `ORIGIN` constant in `src/mcp-oauth.ts` to `http://localhost:8787`.

Authorize the Worker once by requesting a setup URL with the MCP token:

```sh
curl -H 'Authorization: Bearer <MCP_AUTH_TOKEN>' http://localhost:8787/oauth/start
```

Open the returned `authorization_url` in a browser and approve access. WakaTime redirects to the callback, which atomically consumes the one-use state, exchanges the authorization code server-side, and stores the tokens in the Durable Object. The callback page reports success without showing credentials. If the refresh token is revoked or cannot be renewed, repeat this setup flow.

## Worker routes and tools

- `GET /oauth/start` requires the same `MCP_AUTH_TOKEN` as `/mcp` and returns a WakaTime authorization URL.
- `GET /oauth/callback` is the registered OAuth redirect. It requires a valid unexpired one-use state created by `/oauth/start`.
- `/mcp` accepts either the existing `MCP_AUTH_TOKEN` or an OAuth 2.1 access token scoped to `mcp:read`.
- `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`, `/authorize`, `/oauth/token`, and `/oauth/register` support OAuth client discovery and authorization.
- `GET /authorize` renders a consent page that displays the client's identity, requested scopes, and callback host. Approval requires the owner `MCP_AUTH_TOKEN`, supplied in the password field over HTTPS. No anonymous authorization is permitted.
- OAuth grants are stored in the Cloudflare `OAUTH_KV` namespace and are separate from the WakaTime account token in Durable Objects.
- `wakatime_summaries` accepts required valid `start` and `end` dates in `YYYY-MM-DD` format (`start` must be on or before `end`), plus optional `project` and IANA `timezone` values. Omitting `timezone` uses the WakaTime account's timezone.
- `wakatime_today` accepts optional `project` and `timezone` values. The default timezone is `Asia/Tokyo`.

Both tools call `GET https://api.wakatime.com/api/v1/users/current/summaries` with the documented `timezone` query parameter and `Authorization: Bearer <access_token>`. Today's date is calculated in the same timezone sent to WakaTime. Successful results preserve the complete summaries JSON envelope, including daily and aggregate fields.

Upstream failures return MCP tool results with `isError: true`. Diagnostics include HTTP status, status text, sanitized `error`/`errors` messages, endpoint, and query parameter names. Request context contains no query values. Known credentials and named credential values are redacted; unrelated response fields and raw non-JSON bodies are excluded. Network, OAuth, and response-stream exceptions use controlled messages. Requests are not retried automatically, except that an API 401 triggers one token refresh and one retry. HTTP 403 is returned without refreshing. HTTP 429 includes rate-limit guidance and a valid `Retry-After` header when supplied. WakaTime also documents 302 redirects as possible rate limiting; redirects are reported without following them.

## Deploy

After registering the production callback, store the four settings as Cloudflare Worker secrets (skip any that are already configured), then deploy:

```sh
npx wrangler secret put WAKATIME_OAUTH_CLIENT_ID
npx wrangler secret put WAKATIME_OAUTH_CLIENT_SECRET
npx wrangler secret put WAKATIME_OAUTH_REDIRECT_URI
npx wrangler secret put MCP_AUTH_TOKEN
npm run deploy
```

All four settings are managed as Worker secrets so deployments do not overwrite dashboard-managed credentials with placeholders. The OAuth access and refresh tokens are stored only in Durable Object storage. CI does not need or receive OAuth credentials or tokens.

Run the `/oauth/start` flow once for the deployed Worker as well, using its `/mcp` bearer token. The OAuth authorization code and state are handled by the OAuth redirect flow; do not copy or log callback query values. Reauthorize by repeating `/oauth/start` if WakaTime access is revoked or refresh fails.

## Configure an MCP client

Use the deployed Worker URL with `/mcp` and supply the MCP bearer token in the `Authorization` header. For clients with HTTP header configuration:

```json
{
  "url": "https://<worker-name>.<account-subdomain>.workers.dev/mcp",
  "headers": {
    "Authorization": "Bearer <MCP_AUTH_TOKEN>"
  }
}
```

OAuth-capable clients instead use the built-in OAuth discovery and authorization code + PKCE flow, which never exposes the WakaTime OAuth client secret or WakaTime access tokens. When asked for credentials on the Worker approval page, enter the *owner* `MCP_AUTH_TOKEN`, **not** the WakaTime OAuth secret.

### ChatGPT custom MCP setup

In **Plugins → Add custom MCP server**, set **Server URL** to `https://wakatime-mcp.hugoalves-java.workers.dev/mcp` and **Authentication** to **OAuth**. Use client metadata discovery (CIMD) if offered, otherwise Dynamic Client Registration (DCR). Do not provide the WakaTime OAuth app client ID and secret to ChatGPT; they are only for Worker-to-WakaTime authentication. Authorize on the Worker consent page with your existing `MCP_AUTH_TOKEN` owner password. If you lost that token, rotate its Cloudflare Worker secret first.

The MCP OAuth server uses the official `@cloudflare/workers-oauth-provider` library. OAuth state and tokens are in the dedicated Workers KV namespace `wakatime-mcp-oauth`. The Worker is currently bound to its workers.dev URL via `src/mcp-oauth.ts`; update the fixed origin if you migrate to a custom domain.

**Separate initial authorization:** OAuth access to the MCP server does not authorize the Worker's own WakaTime API account. Complete the existing `/oauth/start` → `/oauth/callback` setup once to populate the WakaTime Durable Object token store.

## Checks and CI

Run local checks with:

```sh
npm test
npm run build
```

The build typechecks TypeScript and runs Wrangler's deployment dry run. Tests and build do not require live WakaTime or Cloudflare credentials.

GitHub Actions runs separate `test`, `build`, and `deploy` jobs. Deployment runs only on a push to `main`. Configure repository Actions secrets `CLOUDFLARE_API_TOKEN` with permission to deploy Workers and `CLOUDFLARE_ACCOUNT_ID` for the Cloudflare account. CI never reads or prints OAuth credentials or tokens.
