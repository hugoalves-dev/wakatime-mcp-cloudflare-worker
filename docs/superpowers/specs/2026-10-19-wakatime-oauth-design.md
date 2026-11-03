# WakaTime OAuth Migration Design

## Goal

Replace WakaTime API key authentication for summary reads with a single-user OAuth 2.0 authorization-code flow, keeping the existing MCP bearer authentication independent and unchanged.

## Context and constraints

The Worker currently serves `wakatime_summaries` and `wakatime_today` from `/mcp` and authenticates outbound WakaTime requests with `WAKATIME_API_KEY` using HTTP Basic. `MCP_AUTH_TOKEN` protects inbound MCP requests. WakaTime documents OAuth access tokens for API reads, the `read_summaries` scope, authorization at `https://wakatime.com/oauth/authorize`, token exchange and refresh at `https://wakatime.com/oauth/token`, and bearer authorization for API requests.

This is a single-user deployment. It must not add multi-user account management, a database, or a second authentication system for MCP clients. OAuth client credentials remain Cloudflare secrets. Rotating OAuth tokens must be persisted securely with serialized refresh rotation so normal refreshes do not require manual reauthorization. Client secrets and OAuth access/refresh tokens must not appear in URLs, logs, client-facing errors, or MCP results. The authorization code and one-use state necessarily travel through standard OAuth authorization and callback URLs; consume each code once and never log, re-emit, or include either value in errors or responses.

## Design

### OAuth setup endpoints

Add a protected `GET /oauth/start` endpoint. It requires the existing `Authorization: Bearer <MCP_AUTH_TOKEN>` and creates a cryptographically random, short-lived, one-use `state` value stored in a named Cloudflare Durable Object. It returns the WakaTime authorization URL in a JSON response with `response_type=code`, the configured callback URI, `scope=read_summaries`, and that state value. The authorization URL contains only normal OAuth authorization parameters; no client secret, access token, refresh token, or MCP token is included.

Add a `GET /oauth/callback` endpoint at the configured redirect URI. It serializes callback handling, validates and atomically consumes the one-use state before exchanging the supplied authorization code server-to-server with WakaTime. The token exchange uses the configured client ID, client secret, and exactly the redirect URI used at authorization. On success, store the access token, refresh token, and expiry metadata in strongly consistent Durable Object storage, then return a generic success page without token values. On errors, return a generic failure response and do not echo query parameters, codes, credentials, or upstream response bodies.

State records expire after a short bounded interval and are deleted when consumed. The callback rejects absent, expired, or previously consumed state. It must not log query strings or provider payloads.

### Token storage and refresh

Use a single named Durable Object for OAuth state and the single account's current token record. Store only the data needed to make authenticated reads and refresh tokens. Keep `WAKATIME_OAUTH_CLIENT_SECRET` as a Cloudflare secret; configure the client ID and callback URI as non-secret Worker variables. The named Durable Object is the strongly consistent source of truth for rotated tokens and serializes refresh operations.

Before each WakaTime API read, load the token record. If the access token is expired or near expiry, refresh it before making the API request. If WakaTime returns 401, perform at most one refresh and retry the read once. Do not retry 403 responses. A successful refresh must persist the entire new token response, including a rotated refresh token, before use. A missing token record, invalid refresh response, or failed refresh returns a controlled sanitized request error that directs the operator to reauthorize, without including secret values.

The existing summaries path, query encoding, response validation, rate-limit handling, and MCP result shape remain intact. Outbound WakaTime API calls use `Authorization: Bearer <access_token>` and do not use `WAKATIME_API_KEY`.

### Routing and authentication

Keep `/mcp` protected by `MCP_AUTH_TOKEN` as it is today. `/oauth/start` uses the same bearer check. `/oauth/callback` is not protected by MCP bearer auth because WakaTime must be able to redirect a browser to it; the one-time state is its request authenticator. Other paths continue to return 404. Existing MCP tools and their inputs remain unchanged.

### Configuration and operations

Remove `WAKATIME_API_KEY` from local and Cloudflare setup instructions. Document the OAuth app registration, callback URI, required scope, `WAKATIME_OAUTH_CLIENT_ID`, `WAKATIME_OAUTH_CLIENT_SECRET`, `WAKATIME_OAUTH_REDIRECT_URI`, Durable Object binding, and `MCP_AUTH_TOKEN`. Document binding the Durable Object to the Worker, deploying, calling `/oauth/start` with the MCP bearer token, completing the WakaTime consent screen, and verifying the generic callback success. Explain the one-time reauthorization action needed after revoked or unrecoverable credentials.

The OAuth client ID and redirect URI are configuration values; the client secret and MCP token are Cloudflare secrets. OAuth access and refresh tokens are stored only in Durable Object storage. No credential is committed to the repository or supplied to an MCP client.

## Error handling and credential safety

All token exchange and refresh requests use HTTPS and JSON responses, with bounded response handling. Never include raw provider payloads or exception text in logs or responses. Cloudflare invocation logs include request URLs, so disable invocation logs to keep the callback authorization code and state out of logs. Sanitize API errors using the current diagnostic policy, extending it to cover OAuth client credentials and access/refresh tokens. Keep authorization codes and state out of diagnostics. The callback response reveals only success or failure and contains no token or provider details.

## Testing and acceptance

Add focused tests for:

- Authorization-code start URL parameters, MCP authentication, state creation, and callback state rejection/consumption.
- Successful code exchange and storage without returning credentials.
- Summary reads using `Authorization: Bearer` and preserved query/response behavior.
- Missing credentials and refresh before expiry, including persistence of rotated refresh tokens.
- Exactly one refresh-and-retry after a WakaTime 401, and no refresh retry for 403.
- Sanitized errors for failed token exchange/refresh and API 401/403, with credentials absent from results.
- `/mcp` authentication remaining unchanged and OAuth routes not appearing as MCP tools.

Acceptance requires both MCP tools to continue returning summaries through OAuth, no API-key authentication remaining on WakaTime reads, automatic refresh with durable credential rotation, unchanged MCP bearer protection, updated setup documentation, and successful test/build checks.

## References

- WakaTime authentication documentation: https://wakatime.com/developers#authentication
- WakaTime OAuth app registration: https://wakatime.com/apps
- GitHub issue #3: https://github.com/vitorhugo-dotnet/wakatime-mcp-cloudflare-worker/issues/3
