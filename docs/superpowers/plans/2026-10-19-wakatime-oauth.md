# WakaTime OAuth Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace WakaTime API-key reads with single-user OAuth while preserving MCP bearer authentication and automatically refreshing stored credentials.

**Architecture:** Add an OAuth module for state, token exchange, and Cloudflare KV persistence. Route the MCP-authorized start endpoint and state-validated callback through the Worker; make WakaTime reads obtain and refresh bearer tokens through the OAuth module. Update Wrangler and README for the new Cloudflare setup.

**Tech Stack:** TypeScript, Cloudflare Workers, Workers KV, Vitest, Wrangler.

**Spec:** `docs/superpowers/specs/2026-10-19-wakatime-oauth-design.md`

## Global Constraints

- This is a single-user deployment; do not add multi-user account management, a database, or a second authentication system for MCP clients.
- `/mcp` and `/oauth/start` require the existing `MCP_AUTH_TOKEN`; `/oauth/callback` validates one-use state.
- Request only `read_summaries`; do not include client secrets or OAuth access/refresh tokens in URLs, logs, client-facing errors, or MCP results.
- Keep client secrets in Cloudflare secrets and rotated OAuth tokens in the dedicated KV namespace.
- Preserve the existing summaries query parameters, response envelope, and MCP tool inputs.

## Review Focus

- Malformed or incomplete OAuth provider token responses must fail closed and never persist partial credentials; test in Task 1.
- Missing, expired, and replayed OAuth state must reject callbacks before token exchange; test in Task 1.
- Missing, malformed, or expired stored token records must produce controlled errors or refresh before an API read; test in Task 1 and Task 2.
- A 401 permits one refresh and one retry; 403 must not refresh; test in Task 2.
- Provider error bodies, state, authorization codes, client secrets, and access/refresh tokens must not escape responses; test in Tasks 1–3.

---

### Task 1: OAuth state, code exchange, and KV token storage

**Files:**
- Create: `src/oauth.ts`
- Modify: `src/wakatime.ts` (`Env` bindings)
- Create: `tests/oauth.test.ts`

**Interfaces:**
- Produces `Env` with `WAKATIME_OAUTH_CLIENT_ID?: string`, `WAKATIME_OAUTH_CLIENT_SECRET?: string`, `WAKATIME_OAUTH_REDIRECT_URI?: string`, and `WAKATIME_OAUTH_STORE?: KVNamespace`.
- Produces `createAuthorizationUrl(env: Env): Promise<string>`, `completeAuthorization(request: Request, env: Env): Promise<Response>`, `getAccessToken(env: Env): Promise<string>`, and `refreshAccessToken(env: Env, rejectedToken?: string): Promise<string>`.
- KV keys are private implementation details using fixed token key `oauth:token` and random state keys under `oauth:state:`; callback consumes the state record before exchange.
- Token records store `access_token`, `refresh_token`, and `expires_at` as a JSON object; an omitted `expires_in` maps to no expiry time.

- [ ] **Step 1: Write failing tests** for authorization URL scope and redirect, state persistence/expiry, callback rejection for absent/expired/replayed state, successful code exchange and KV storage, malformed token JSON or missing access/refresh token, and no credentials in callback response.
- [ ] **Step 2: Run `npm test -- tests/oauth.test.ts`** and confirm each new behavior fails because OAuth helpers are not implemented.
- [ ] **Step 3: Implement the four exported helpers in `src/oauth.ts`.** Use Web Crypto for random state; use WakaTime's HTTPS authorize/token endpoints and JSON POST bodies; set bounded KV state expiry; validate token response fields before writing; return generic callback responses.
- [ ] **Step 4: Re-run `npm test -- tests/oauth.test.ts`** and confirm all OAuth storage and callback tests pass.
- [ ] **Step 5: Commit** as `feat: add WakaTime OAuth token storage`.

### Task 2: Bearer API reads and token refresh

**Files:**
- Modify: `src/wakatime.ts`
- Modify: `src/oauth.ts` only if needed to support token refresh
- Modify: `tests/wakatime.test.ts`
- Modify: `tests/wakatime-errors.test.ts`

**Interfaces:**
- Consumes `getAccessToken(env)` and `refreshAccessToken(env, rejectedToken?)` from Task 1.
- `wakatimeGet(env: Env, path: string, qs: Record<string, string | undefined>): Promise<string>` remains the summaries API entrypoint.

- [ ] **Step 1: Write failing tests** for bearer authorization, query and success-envelope preservation, no configured token, preemptive refresh for a near-expiry token, persistence/use of rotated refresh tokens, one refresh and retry for 401, no refresh on 403, and redaction of every configured OAuth credential.
- [ ] **Step 2: Run `npm test -- tests/wakatime.test.ts tests/wakatime-errors.test.ts`** and confirm failures are due to API-key behavior and missing refresh behavior.
- [ ] **Step 3: Update `wakatimeGet`** to acquire an OAuth token, use `Authorization: Bearer`, refresh near-expiry tokens, and perform at most one refresh/retry after 401. Keep 403, rate-limit, response validation, query construction, and controlled diagnostics.
- [ ] **Step 4: Re-run the two focused test files** and confirm the WakaTime client uses bearer auth and handles refresh/error cases as specified.
- [ ] **Step 5: Commit** as `feat: use OAuth bearer tokens for WakaTime reads`.

### Task 3: Worker OAuth routes and regression coverage

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/worker.test.ts`
- Modify: `tests/server.test.ts`

**Interfaces:**
- Consumes `createAuthorizationUrl`, `completeAuthorization`, and `Env` from Tasks 1–2.
- Adds only `/oauth/start` and `/oauth/callback`; the MCP tool list and input schemas remain unchanged.

- [ ] **Step 1: Write failing route tests** for authenticated `/oauth/start`, unauthorized `/oauth/start`, successful and invalid-state `/oauth/callback`, 404 for other paths, unchanged `/mcp` authorization, and the two existing tools continuing to work with OAuth bearer auth.
- [ ] **Step 2: Run `npm test -- tests/worker.test.ts tests/server.test.ts`** and confirm the new route and bearer expectations fail before routing changes.
- [ ] **Step 3: Route `/oauth/start` and `/oauth/callback`** before the existing `/mcp` handling; reuse `isAuthorized` for the start route and keep the callback state-validated by `completeAuthorization`.
- [ ] **Step 4: Re-run both focused test files** and confirm route behavior, MCP protection, and tool outputs pass.
- [ ] **Step 5: Commit** as `feat: expose protected WakaTime OAuth setup routes`.

### Task 4: Cloudflare setup and migration documentation

**Files:**
- Modify: `wrangler.jsonc`
- Modify: `README.md`
- Modify: tests as required for the final configuration contract

**Interfaces:**
- Binds the dedicated `WAKATIME_OAUTH_STORE` KV namespace in Wrangler.
- Documents non-secret variables `WAKATIME_OAUTH_CLIENT_ID` and `WAKATIME_OAUTH_REDIRECT_URI`, secrets `WAKATIME_OAUTH_CLIENT_SECRET` and `MCP_AUTH_TOKEN`, and removal of `WAKATIME_API_KEY`.

- [ ] **Step 1: Add a configuration/documentation assertion** that README and Wrangler use the OAuth variable names and no longer instruct operators to set `WAKATIME_API_KEY`.
- [ ] **Step 2: Run the focused documentation/configuration check** and confirm it fails before those instructions are updated.
- [ ] **Step 3: Add the KV binding and rewrite setup instructions** to cover OAuth app registration, exact callback URL and scope, secret/configuration setup, namespace creation/binding, deployment, and calling `/oauth/start` with the MCP bearer token.
- [ ] **Step 4: Run `npm test` and `npm run build`**; confirm all tests pass and the TypeScript/Wrangler dry-run build succeeds.
- [ ] **Step 5: Commit** as `docs: document WakaTime OAuth deployment setup`.

## Self-review

- **Coverage:** OAuth authorization, state validation, code exchange, token storage/rotation, bearer API reads, 401/403 behavior, MCP auth continuity, credential redaction, Cloudflare configuration, migration docs, tests, and build are assigned to Tasks 1–4.
- **Step clarity:** Each task follows test, expected failure, implementation, green verification, and commit. Test names/assertions are enumerated by behavior rather than left as generic edge-case instructions.
- **Interface consistency:** `Env`, OAuth helper names, token key, token record fields, and `wakatimeGet` signature are consistent across tasks.
- **Review focus:** The five failure classes at the top are assigned to the tests in their owning tasks.
- **Scope:** The plan stays within the approved single-user Worker design and the existing TypeScript/Vitest/Wrangler stack.
