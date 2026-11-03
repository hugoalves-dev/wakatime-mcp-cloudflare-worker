import { describe, expect, it } from "vitest";
import worker from "../src/index.js";

const env = {
  MCP_AUTH_TOKEN: "previous-static-token",
  WAKATIME_OAUTH_CLIENT_ID: "client-id",
  WAKATIME_OAUTH_CLIENT_SECRET: "client-secret",
  WAKATIME_OAUTH_REDIRECT_URI: "https://worker.example.com/oauth/callback",
};

describe("OAuth-only Worker routing", () => {
  it("does not accept the old static MCP bearer token, even when it matches", async () => {
    const response = await worker.fetch(new Request("https://worker.example.com/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer previous-static-token", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }), env as never, {} as ExecutionContext);
    expect(response.status).toBe(401);
  });

  it("does not expose the legacy OAuth setup route", async () => {
    const response = await worker.fetch(new Request("https://worker.example.com/oauth/start", {
      headers: { Authorization: "Bearer previous-static-token" },
    }), env as never, {} as ExecutionContext);
    expect(response.status).toBe(404);
  });

  it("rejects routes outside OAuth and MCP", async () => {
    const response = await worker.fetch(new Request("https://worker.example.com/not-found"), env as never, {} as ExecutionContext);
    expect(response.status).toBe(404);
  });
});
