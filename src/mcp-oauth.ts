// OAuth 2.1 for MCP clients, separate from the WakaTime account OAuth flow.
import { AuthorizationError, CimdFetchError, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { isAuthorized } from "./auth.js";
import { createServer } from "./server.js";
import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "./wakatime.js";

const ORIGIN = "https://wakatime-mcp.hugoalves-java.workers.dev";
const SCOPES = ["mcp:read", "offline_access"];

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => "&#" + char.charCodeAt(0) + ";");
}

function html(body: string, status = 200, headers?: Headers): Response {
  const h = new Headers(headers);
  h.set("Content-Type", "text/html; charset=utf-8");
  h.set("Cache-Control", "no-store");
  h.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  return new Response(body, { status, headers: h });
}

async function authorization(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth) return new Response("OAuth is not configured", { status: 503 });
  try {
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      const clientName = escapeHtml(details.clientName);
      const destination = escapeHtml(details.redirectHost);
      const scopes = details.scope.map((scope) =>
        '<label><input type="checkbox" name="scope" value="' + escapeHtml(scope) + '" checked> ' + escapeHtml(scope) + "</label>"
      ).join("<br>");
      const clientIdentity = details.clientDomain
        ? "Verified client domain: <strong>" + escapeHtml(details.clientDomain) + "</strong>."
        : "This client name is not verified.";
      const localWarning = details.redirectIsLoopback
        ? "<p><strong>Warning:</strong> this redirect points to a local application.</p>" : "";
      const page = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Authorize WakaTime MCP</title>' +
        '<style>body{font:16px system-ui,sans-serif;max-width:540px;margin:4rem auto;padding:0 1rem;line-height:1.5}input[type=password]{width:100%;box-sizing:border-box;padding:.7rem;margin:.5rem 0}button{padding:.7rem 1.2rem;margin:.7rem .6rem 0 0}small{color:#555}</style></head>' +
        '<body><h1>Authorize ' + clientName + '?</h1><p>This client requests access to your WakaTime coding summaries.</p><p>' + clientIdentity + '</p>' +
        '<p>Tokens will be delivered to <strong>' + destination + '</strong>.</p>' + localWarning +
        '<form method="post" action="/authorize"><input type="hidden" name="handle" value="' + escapeHtml(consent.handle) + '">' +
        '<p>Scopes:<br>' + scopes + '</p><label for="password">Owner access token (MCP_AUTH_TOKEN)</label>' +
        '<input id="password" name="password" type="password" required autocomplete="off">' +
        '<p><small>This password is used only to approve access. Do not enter your WakaTime OAuth client secret.</small></p>' +
        '<button name="decision" value="approve">Allow access</button><button name="decision" value="deny" formnovalidate>Cancel</button></form></body></html>';
      return html(page, 200, consent.headers);
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const password = String(form.get("password") ?? "");
    // Never log the password or include it in redirect URLs.
    const passwordRequest = new Request(request.url, { headers: { Authorization: "Bearer " + password } });
    if (!(await isAuthorized(passwordRequest, env.MCP_AUTH_TOKEN))) {
      return html('<!doctype html><meta charset="utf-8"><h1>Access denied</h1><p>Invalid owner token. Restart authorization from your MCP client.</p>', 403);
    }
    const approved = await oauth.approveConsent(request, handle, { scope: form.getAll("scope").map(String) });
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: "wakatime-mcp-owner",
      metadata: {},
      scope: approved.request.scope,
      props: { userId: "wakatime-mcp-owner" },
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      return html('<!doctype html><meta charset="utf-8"><h1>Authorization failed</h1><p>Please restart the connection from your MCP client.</p>', 400);
    }
    return html('<!doctype html><meta charset="utf-8"><h1>Authorization unavailable</h1>', 500);
  }
}

export function createOAuthProvider(): OAuthProvider<Env> {
  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: {
      fetch(request: Request, env: Env, ctx: ExecutionContext) {
        const auth = (ctx as ExecutionContext & { auth?: { scope: string[] } }).auth;
        if (!auth?.scope.includes("mcp:read")) return new Response("Insufficient scope", { status: 403 });
        const handler = createMcpHandler(() => createServer(env), { route: "/mcp" });
        return handler(request, env, ctx);
      },
    },
    defaultHandler: {
      fetch(request: Request, env: Env) {
        if (new URL(request.url).pathname === "/authorize") return authorization(request, env);
        return new Response("Not found", { status: 404 });
      },
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: SCOPES,
    resourceMetadata: {
      resource: ORIGIN + "/mcp",
      authorization_servers: [ORIGIN],
      resource_name: "WakaTime MCP",
      bearer_methods_supported: ["header"],
    },
    requiredScopes: ["mcp:read"],
    clientIdMetadataDocumentEnabled: true,
  });
}
