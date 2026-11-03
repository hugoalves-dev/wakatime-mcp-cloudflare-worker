# WakaTime MCP for Cloudflare Workers

An authenticated remote MCP server for WakaTime summaries. The Worker exposes `wakatime_summaries` and `wakatime_today` over Streamable HTTP at `/mcp`. WakaTime API reads use a single account's OAuth 2.0 token; MCP clients continue to authenticate with the separate `MCP_AUTH_TOKEN`.

## Configure WakaTime OAuth

Create an OAuth app at [wakatime.com/apps](https://wakatime.com/apps). Request the `read_summaries` scope and register the callback URL for each deployment, exactly as configured by `WAKATIME_OAUTH_REDIRECT_URI` in `wrangler.jsonc`. The production callback uses `https://<worker-name>.<account-subdomain>.workers.dev/oauth/callback`; local development uses `http://localhost:8787/oauth/callback`.

Update the `vars` values in `wrangler.jsonc`:

- `WAKATIME_OAUTH_CLIENT_ID`: the OAuth app's client ID.
- `WAKATIME_OAUTH_REDIRECT_URI`: the callback URL registered for this deployment.

The OAuth coordinator is a named Durable Object. Wrangler creates and migrates it during deployment; it serializes state consumption and token refreshes and stores the current token pair in strongly consistent Durable Object storage. Do not bind another application to this coordinator.


Wrangler invocation logs are disabled because Cloudflare includes full request URLs in those logs and the OAuth callback URL contains the one-use authorization code and state. Workers Logs remain enabled; the Worker does not log OAuth values.

## Local development

Use Node.js 24 and npm. Create an ignored `.dev.vars` file with the OAuth client secret and a long random MCP token:

```text
WAKATIME_OAUTH_CLIENT_SECRET=<your WakaTime OAuth client secret>
MCP_AUTH_TOKEN=<a long random token for MCP clients>
```

After setting the OAuth client ID and local callback URL in `wrangler.jsonc`, install dependencies and start the Worker:

```sh
npm ci
npm run dev
```

The MCP endpoint is `http://localhost:8787/mcp`. Every MCP request must include `Authorization: Bearer <MCP_AUTH_TOKEN>`.

Authorize the Worker once by requesting a setup URL with the MCP token:

```sh
curl -H 'Authorization: Bearer <MCP_AUTH_TOKEN>' http://localhost:8787/oauth/start
```

Open the returned `authorization_url` in a browser and approve access. WakaTime redirects to the callback, which atomically consumes the one-use state, exchanges the authorization code server-side, and stores the tokens in the Durable Object. The callback page reports success without showing credentials. If the refresh token is revoked or cannot be renewed, repeat this setup flow.

## Worker routes and tools

- `GET /oauth/start` requires the same `MCP_AUTH_TOKEN` as `/mcp` and returns a WakaTime authorization URL.
- `GET /oauth/callback` is the registered OAuth redirect. It requires a valid unexpired one-use state created by `/oauth/start`.
- `/mcp` remains protected by `MCP_AUTH_TOKEN`.
- `wakatime_summaries` accepts required valid `start` and `end` dates in `YYYY-MM-DD` format (`start` must be on or before `end`), plus optional `project` and IANA `timezone` values. Omitting `timezone` uses the WakaTime account's timezone.
- `wakatime_today` accepts optional `project` and `timezone` values. The default timezone is `Asia/Tokyo`.

Both tools call `GET https://api.wakatime.com/api/v1/users/current/summaries` with the documented `timezone` query parameter and `Authorization: Bearer <access_token>`. Today's date is calculated in the same timezone sent to WakaTime. Successful results preserve the complete summaries JSON envelope, including daily and aggregate fields.

Upstream failures return MCP tool results with `isError: true`. Diagnostics include HTTP status, status text, sanitized `error`/`errors` messages, endpoint, and query parameter names. Request context contains no query values. Known credentials and named credential values are redacted; unrelated response fields and raw non-JSON bodies are excluded. Network, OAuth, and response-stream exceptions use controlled messages. Requests are not retried automatically, except that an API 401 triggers one token refresh and one retry. HTTP 403 is returned without refreshing. HTTP 429 includes rate-limit guidance and a valid `Retry-After` header when supplied. WakaTime also documents 302 redirects as possible rate limiting; redirects are reported without following them.

## Deploy

After registering the production callback and setting the production variables in `wrangler.jsonc`, store secrets in Cloudflare and deploy:

```sh
npx wrangler secret put WAKATIME_OAUTH_CLIENT_SECRET
npx wrangler secret put MCP_AUTH_TOKEN
npm run deploy
```

The OAuth client secret and MCP token are Cloudflare secrets. The client ID and redirect URI are non-secret Worker variables. The OAuth access and refresh tokens are stored only in Durable Object storage. CI does not need or receive OAuth credentials or tokens.

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

MCP clients need only `MCP_AUTH_TOKEN`; never provide them with the WakaTime OAuth client secret or OAuth tokens.

## Checks and CI

Run local checks with:

```sh
npm test
npm run build
```

The build typechecks TypeScript and runs Wrangler's deployment dry run. Tests and build do not require live WakaTime or Cloudflare credentials.

GitHub Actions runs separate `test`, `build`, and `deploy` jobs. Deployment runs only on a push to `main`. Configure repository Actions secrets `CLOUDFLARE_API_TOKEN` with permission to deploy Workers and `CLOUDFLARE_ACCOUNT_ID` for the Cloudflare account. CI never reads or prints OAuth credentials or tokens.
