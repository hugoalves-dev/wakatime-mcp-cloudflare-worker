// ABOUTME: Cloudflare Worker entrypoint for the authenticated WakaTime MCP server.
// ABOUTME: The MCP handler and server are request-scoped to avoid durable sessions.
import { createMcpHandler } from "agents/mcp/server";
import { isAuthorized } from "./auth.js";
import { completeAuthorization, createAuthorizationUrl } from "./oauth.js";
import { createServer } from "./server.js";
import type { Env } from "./wakatime.js";
export { OAuthCoordinator } from "./oauth-coordinator.js";

const unauthorized = () =>
  Response.json(
    { error: "Unauthorized" },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );

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
    if (path !== "/mcp") return notFound();
    if (!(await isAuthorized(request, env.MCP_AUTH_TOKEN))) return unauthorized();

    const handler = createMcpHandler(() => createServer(env), { route: "/mcp" });
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
