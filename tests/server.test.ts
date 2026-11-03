import { createMcpHandler } from "agents/mcp/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import { MemoryCoordinatorNamespace, setToken } from "./helpers/coordinator.js";

const oauthAccessToken = "waka_tok_server_access";
function createRpcHandler() {
  const base = { WAKATIME_OAUTH_CLIENT_ID: "client-id", WAKATIME_OAUTH_CLIENT_SECRET: "client-secret", WAKATIME_OAUTH_REDIRECT_URI: "https://worker.example.com/oauth/callback" };
  const store = new MemoryCoordinatorNamespace(base);
  setToken(store, { access_token: oauthAccessToken, refresh_token: "waka_tok_server_refresh", expires_at: null });
  return createMcpHandler(() => createServer({
    ...base,
    WAKATIME_OAUTH_COORDINATOR: store as unknown as DurableObjectNamespace,
  }), {
    route: "/mcp",
    allowedHostnames: ["example.com"],
    allowedOriginHostnames: [],
    corsOptions: false,
  });
}

async function rpc(
  handler: ReturnType<typeof createRpcHandler>,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await handler.fetch(
    new Request("https://example.com/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Host: "example.com",
      },
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${text}`);
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    if (!data) throw new Error(`MCP event stream had no data: ${text}`);
    return JSON.parse(data.slice("data: ".length));
  }
  return text ? JSON.parse(text) : undefined;
}

async function initialize(handler: ReturnType<typeof createRpcHandler>) {
  return rpc(handler, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("WakaTime MCP server", () => {
  it("registers the summaries tools and account OAuth connection", async () => {
    const handler = createRpcHandler();
    await initialize(handler);
    const result = await rpc(handler, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    }) as { result: { tools: Array<{ name: string }> } };

    expect(result.result.tools.map((tool) => tool.name).sort()).toEqual([
      "wakatime_connect",
      "wakatime_summaries",
      "wakatime_today",
    ]);
  });

  it("calls summaries with the existing parameters and OAuth bearer token", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/v1/users/current/summaries");
      expect(url.searchParams.get("start")).toBe("2025-01-01");
      expect(url.searchParams.get("end")).toBe("2025-01-02");
      expect(url.searchParams.get("project")).toBe("demo");
      expect(url.searchParams.get("timezone")).toBe("Asia/Tokyo");
      expect(url.searchParams.has("tz")).toBe(false);
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${oauthAccessToken}`);
      return new Response('{"data":[]}', { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const handler = createRpcHandler();
    await initialize(handler);
    const result = await rpc(handler, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "wakatime_summaries",
        arguments: { start: "2025-01-01", end: "2025-01-02", project: "demo", timezone: "Asia/Tokyo" },
      },
    });

    expect(result).toMatchObject({ result: { content: [{ type: "text", text: '{"data":[]}' }] } });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses one date in the requested timezone for today's summary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T02:00:00.000Z"));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("start")).toBe("2024-12-31");
      expect(url.searchParams.get("end")).toBe("2024-12-31");
      expect(url.searchParams.get("timezone")).toBe("America/Los_Angeles");
      expect(url.searchParams.has("tz")).toBe(false);
      return new Response('{"data":[]}', { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const handler = createRpcHandler();
    await initialize(handler);
    const result = await rpc(handler, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "wakatime_today", arguments: { timezone: "America/Los_Angeles" } },
    });
    expect(result).toMatchObject({ result: { content: [{ text: '{"data":[]}' }] } });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns protocol errors for invalid input without exposing the OAuth token", async () => {
    const handler = createRpcHandler();
    await initialize(handler);
    const result = await rpc(handler, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "wakatime_summaries", arguments: { start: "", end: "2025-01-02" } },
    });
    expect(result).toMatchObject({ result: { isError: true } });
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });

  it("uses Asia/Tokyo by default for today's date and upstream timezone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T23:30:00Z"));
    const urls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      urls.push(new URL(String(input)));
      return new Response('{"data":[]}');
    }));
    const result = await rpc(createRpcHandler(), {
      jsonrpc: "2.0", id: 10, method: "tools/call",
      params: { name: "wakatime_today", arguments: { project: "sample project" } },
    });
    expect(result).toMatchObject({ result: { content: [{ text: '{"data":[]}' }] } });
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({
      start: "2025-01-02", end: "2025-01-02", project: "sample project", timezone: "Asia/Tokyo",
    });
  });

  it("omits optional timezone and project for summaries", async () => {
    const urls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      urls.push(new URL(String(input)));
      return new Response('{"data":[]}');
    }));
    const result = await rpc(createRpcHandler(), {
      jsonrpc: "2.0", id: 11, method: "tools/call",
      params: { name: "wakatime_summaries", arguments: { start: "2024-02-29", end: "2024-02-29" } },
    });
    expect(result).toMatchObject({ result: { content: [{ text: '{"data":[]}' }] } });
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({ start: "2024-02-29", end: "2024-02-29" });
  });

  it.each([
    { start: "2025-02-29", end: "2025-03-01" },
    { start: "2025-13-01", end: "2025-03-01" },
    { start: "01/02/2025", end: "2025-03-01" },
    { start: "2025-03-02", end: "2025-03-01" },
    { start: "2025-01-01", end: "2025-01-02", timezone: "Not/A_Timezone" },
    { start: "2025-01-01", end: "2025-01-02", timezone: "" },
    { start: "2025-01-01", end: "2025-01-02", timezone: "+03:00" },
  ])("rejects invalid summaries arguments before fetch: %j", async (arguments_) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await rpc(createRpcHandler(), {
      jsonrpc: "2.0", id: 12, method: "tools/call",
      params: { name: "wakatime_summaries", arguments: arguments_ },
    });
    expect(result).toMatchObject({ result: { isError: true } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["wakatime_summaries", "wakatime_today"])("returns upstream diagnostics as an MCP tool error for %s", async (name) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: `Invalid access token ${oauthAccessToken}` }, {
      status: 403, statusText: "Forbidden",
    })));
    const result = await rpc(createRpcHandler(), {
      jsonrpc: "2.0", id: 13, method: "tools/call",
      params: { name, arguments: name === "wakatime_summaries" ? { start: "2025-01-01", end: "2025-01-02" } : {} },
    });
    expect(result).toMatchObject({ result: { isError: true, content: [{ type: "text", text: expect.stringContaining("403 Forbidden: Invalid access token [REDACTED]") }] } });
    expect(result).not.toHaveProperty("error");
    expect(JSON.stringify(result)).not.toContain(oauthAccessToken);
  });

  it("rejects unexpected arguments instead of silently stripping them", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const handler = createRpcHandler();
    await initialize(handler);
    const result = await rpc(handler, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "wakatime_summaries",
        arguments: { start: "2025-01-01", end: "2025-01-02", unexpected: "value" },
      },
    });
    expect(result).toMatchObject({ result: { isError: true } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid timezone before making a WakaTime request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const handler = createRpcHandler();
    await initialize(handler);
    const result = await rpc(handler, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "wakatime_today", arguments: { timezone: "Not/A_Timezone" } },
    });
    expect(result).toMatchObject({ result: { isError: true } });
    expect(JSON.stringify(result)).not.toContain("secret-key");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
