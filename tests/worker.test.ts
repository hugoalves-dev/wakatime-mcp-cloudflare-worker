import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { MemoryCoordinatorNamespace } from "./helpers/coordinator.js";

const oauthAccessToken = "waka_tok_worker_access";
const oauthRefreshToken = "waka_tok_worker_refresh";
const oauthClientSecret = "worker-oauth-client-secret";
const tokenStore = new MemoryCoordinatorNamespace({
  WAKATIME_OAUTH_CLIENT_ID: "client-id", WAKATIME_OAUTH_CLIENT_SECRET: oauthClientSecret,
  WAKATIME_OAUTH_REDIRECT_URI: "https://worker.example.com/oauth/callback",
});
tokenStore.values.set("oauth:token", JSON.stringify({
  access_token: oauthAccessToken, refresh_token: oauthRefreshToken, expires_at: null,
}));
const env = {
  WAKATIME_OAUTH_CLIENT_ID: "client-id",
  WAKATIME_OAUTH_CLIENT_SECRET: oauthClientSecret,
  WAKATIME_OAUTH_REDIRECT_URI: "https://worker.example.com/oauth/callback",
  WAKATIME_OAUTH_COORDINATOR: tokenStore as unknown as DurableObjectNamespace,
  MCP_AUTH_TOKEN: "remote-mcp-token",
};

function jsonRpcRequest(body: Record<string, unknown>, token?: string) {
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Host: "localhost",
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function readJsonRpc(response: Response): Promise<unknown> {
  const body = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = body.split("\n").find((line) => line.startsWith("data: "));
    if (!data) throw new Error(`No JSON-RPC data in event stream: ${body}`);
    return JSON.parse(data.slice("data: ".length));
  }
  return body ? JSON.parse(body) : undefined;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Cloudflare Worker MCP endpoint", () => {
  it("rejects missing and invalid credentials without exposing either secret", async () => {
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    };

    for (const token of [undefined, "wrong-token"]) {
      const response = await worker.fetch(jsonRpcRequest(initialize, token), env, {} as ExecutionContext);
      const text = await response.text();
      expect(response.status).toBe(401);
      expect(text).not.toContain(env.MCP_AUTH_TOKEN);
      expect(text).not.toContain(env.WAKATIME_OAUTH_CLIENT_SECRET);
      expect([...response.headers.values()].join(" ")).not.toContain(env.MCP_AUTH_TOKEN);
      expect([...response.headers.values()].join(" ")).not.toContain(env.WAKATIME_OAUTH_CLIENT_SECRET);
    }
  });

  it("rejects tool calls before they can make a WakaTime request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await worker.fetch(
      jsonRpcRequest(
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "wakatime_today", arguments: {} } },
      ),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires authentication for MCP GET and DELETE requests too", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await worker.fetch(
        new Request("http://localhost/mcp", { method }),
        env,
        {} as ExecutionContext,
      );
      expect(response.status).toBe(401);
    }
  });

  it("serves initialize and tool discovery with a valid token", async () => {
    const initialize = await worker.fetch(
      jsonRpcRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" },
          },
        },
        env.MCP_AUTH_TOKEN,
      ),
      env,
      {} as ExecutionContext,
    );
    expect(initialize.status).toBe(200);
    expect(await readJsonRpc(initialize)).toMatchObject({ result: { serverInfo: { name: "wakatime-mcp" } } });

    const listing = await worker.fetch(
      jsonRpcRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, env.MCP_AUTH_TOKEN),
      env,
      {} as ExecutionContext,
    );
    expect(listing.status).toBe(200);
    const result = await readJsonRpc(listing) as { result: { tools: Array<{ name: string }> } };
    expect(result.result.tools.map((tool) => tool.name).sort()).toEqual([
      "wakatime_summaries",
      "wakatime_today",
    ]);
  });

  it("runs both WakaTime tools through the authenticated Worker binding", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T02:00:00.000Z"));
    const requestedUrls: URL[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requestedUrls.push(url);
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${oauthAccessToken}`);
      return new Response('{"data":[{"grand_total":"1 hr"}]}', { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await worker.fetch(
      jsonRpcRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" },
          },
        },
        env.MCP_AUTH_TOKEN,
      ),
      env,
      {} as ExecutionContext,
    );

    const summaries = await worker.fetch(
      jsonRpcRequest(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "wakatime_summaries",
            arguments: { start: "2025-01-01", end: "2025-01-02", timezone: "Asia/Tokyo" },
          },
        },
        env.MCP_AUTH_TOKEN,
      ),
      env,
      {} as ExecutionContext,
    );
    const today = await worker.fetch(
      jsonRpcRequest(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "wakatime_today", arguments: { timezone: "America/Los_Angeles" } },
        },
        env.MCP_AUTH_TOKEN,
      ),
      env,
      {} as ExecutionContext,
    );

    expect(summaries.status).toBe(200);
    expect(await readJsonRpc(summaries)).toMatchObject({
      result: { content: [{ text: '{"data":[{"grand_total":"1 hr"}]}' }] },
    });
    expect(today.status).toBe(200);
    expect(await readJsonRpc(today)).toMatchObject({
      result: { content: [{ text: '{"data":[{"grand_total":"1 hr"}]}' }] },
    });
    expect(requestedUrls.map((url) => url.searchParams.get("start"))).toEqual([
      "2025-01-01",
      "2024-12-31",
    ]);
    expect(requestedUrls.map((url) => url.searchParams.get("end"))).toEqual([
      "2025-01-02",
      "2024-12-31",
    ]);
    expect(requestedUrls.map((url) => url.searchParams.get("timezone"))).toEqual([
      "Asia/Tokyo", "America/Los_Angeles",
    ]);
    expect(requestedUrls.every((url) => !url.searchParams.has("tz"))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([400, 403, 429, 500])("returns HTTP %i upstream failures as sanitized MCP tool errors", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: `Upstream rejected ${env.WAKATIME_OAUTH_CLIENT_SECRET} ${oauthAccessToken} ${oauthRefreshToken} ${env.MCP_AUTH_TOKEN}`,
    }, { status })));
    for (const name of ["wakatime_summaries", "wakatime_today"]) {
      const response = await worker.fetch(jsonRpcRequest({
        jsonrpc: "2.0", id: 20, method: "tools/call",
        params: { name, arguments: name === "wakatime_summaries" ? { start: "2025-01-01", end: "2025-01-02" } : {} },
      }, env.MCP_AUTH_TOKEN), env, {} as ExecutionContext);
      expect(response.status).toBe(200);
      const result = await readJsonRpc(response);
      expect(result).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining(`WakaTime API request failed: ${status}`) }] } });
      expect(result).not.toHaveProperty("error");
      expect(JSON.stringify(result)).not.toContain(env.WAKATIME_OAUTH_CLIENT_SECRET);
      expect(JSON.stringify(result)).not.toContain(oauthAccessToken);
      expect(JSON.stringify(result)).not.toContain(oauthRefreshToken);
      expect(JSON.stringify(result)).not.toContain(env.MCP_AUTH_TOKEN);
    }
  });

  it("returns a useful tool error when the OAuth token binding is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await worker.fetch(jsonRpcRequest({
      jsonrpc: "2.0", id: 21, method: "tools/call",
      params: { name: "wakatime_today", arguments: {} },
    }, env.MCP_AUTH_TOKEN), { MCP_AUTH_TOKEN: env.MCP_AUTH_TOKEN }, {} as ExecutionContext);
    expect(response.status).toBe(200);
    const result = await readJsonRpc(response);
    expect(result).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("OAuth credentials are unavailable") }] } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 404 outside the MCP endpoint", async () => {
    const response = await worker.fetch(
      new Request("http://localhost/other"),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(404);
  });

  it("returns an authorization URL from the MCP-protected OAuth start route", async () => {
    const response = await worker.fetch(new Request("https://worker.example.com/oauth/start", {
      headers: { Authorization: `Bearer ${env.MCP_AUTH_TOKEN}` },
    }), env, {} as ExecutionContext);
    const result = await response.json() as { authorization_url: string };
    const authorizationUrl = new URL(result.authorization_url);
    expect(response.status).toBe(200);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe("https://wakatime.com/oauth/authorize");
    expect(authorizationUrl.searchParams.get("scope")).toBe("read_summaries");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(env.WAKATIME_OAUTH_REDIRECT_URI);
    const state = authorizationUrl.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(tokenStore.values.get(`oauth:state:${state}`)).toBe("1");
    expect(result.authorization_url).not.toContain(oauthClientSecret);
  });

  it("rejects an unauthenticated OAuth start request", async () => {
    const before = tokenStore.values.size;
    const response = await worker.fetch(new Request("https://worker.example.com/oauth/start"), env, {} as ExecutionContext);
    expect(response.status).toBe(401);
    expect(tokenStore.values.size).toBe(before);
  });

  it("rejects an invalid OAuth callback state without contacting WakaTime", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await worker.fetch(new Request(
      "https://worker.example.com/oauth/callback?code=private-code&state=invalid-state",
    ), env, {} as ExecutionContext);
    const text = await response.text();
    expect(response.status).toBe(400);
    expect(text).not.toMatch(/private-code|invalid-state|waka_tok_|worker-oauth-client-secret/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a valid OAuth callback without MCP auth and stores tokens without exposing them", async () => {
    const state = "worker-valid-oauth-state";
    tokenStore.values.set(`oauth:state:${state}`, "1");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      access_token: "waka_tok_callback_access",
      refresh_token: "waka_tok_callback_refresh",
      expires_in: 3600,
    })));
    const response = await worker.fetch(new Request(
      `https://worker.example.com/oauth/callback?code=private-code&state=${state}`,
    ), env, {} as ExecutionContext);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toMatch(/private-code|waka_tok_callback|worker-oauth-client-secret/);
    expect(tokenStore.values.has(`oauth:state:${state}`)).toBe(false);
    expect(JSON.parse(tokenStore.values.get("oauth:token")!)).toMatchObject({
      access_token: "waka_tok_callback_access", refresh_token: "waka_tok_callback_refresh",
    });
  });

  it("fails closed when the authentication binding is not configured", async () => {
    const response = await worker.fetch(
      jsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, env.MCP_AUTH_TOKEN),
      {},
      {} as ExecutionContext,
    );
    expect(response.status).toBe(401);
  });
});
