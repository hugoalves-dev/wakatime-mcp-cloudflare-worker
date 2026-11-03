// ABOUTME: Cloudflare Worker serving WakaTime account OAuth and MCP client OAuth 2.1.
// ABOUTME: Legacy MCP_AUTH_TOKEN clients remain supported alongside OAuth clients.
import { isAuthorized } from "./auth.js";
import { completeAuthorization, createAuthorizationUrl } from "./oauth.js";
import type { Env } from "./wakatime.js";
export { OAuthCoordinator } from "./oauth-coordinator.js";

const unauthorized = () => Response.json({ error: "Unauthorized" }, {
  status: 401, headers: { "WWW-Authenticate": "Bearer" },
});
const notFound = () => new Response("Not found", { status: 404 });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/oauth/start") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
      if (!(await isAuthorized(request, env.MCP_AUTH_TOKEN))) return unauthorized();
      try {
        return Response.json({ authorization_url: await createAuthorizationUrl(env) }, {
          headers: { "Cache-Control": "no-store" },
        });
      } catch {
        return Response.json({ error: "OAuth setup is unavailable." }, { status: 500 });
      }
    }
    if (path === "/oauth/callback") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
      return completeAuthorization(request, env);
    }

    // MCP access requires an OAuth 2.1 grant; static bearer bypass is disabled.
    if (path === "/mcp" && !env.OAUTH_KV) return unauthorized();
    // OAuth discovery, registration, authorization, token exchange and resource authentication.
    if (path === "/mcp" || path === "/authorize" || path.startsWith("/.well-known/") ||
        path.startsWith("/oauth/")) {
      const { createOAuthProvider } = await import("./mcp-oauth.js");
      return createOAuthProvider().fetch(request, env, ctx);
    }
    return notFound();
  },
} satisfies ExportedHandler<Env>;
