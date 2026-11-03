// ABOUTME: Strongly consistent, single-instance coordination for OAuth state and token rotation.
// ABOUTME: A single named Durable Object serializes callbacks and refreshes across Worker instances.
import type { Env } from "./wakatime.js";

interface TokenRecord { access_token: string; refresh_token: string; expires_at: number | null }

export class OAuthCoordinator {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/start") {
        const { state } = await request.json() as { state: string };
        await this.state.storage.put(`state:${state}`, Date.now() + 600_000);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/callback") return await this.exclusive(async () => this.callback(request));
      if (url.pathname === "/token") return await this.exclusive(async () => {
        const record = await this.readRecord();
        if (record.expires_at !== null && record.expires_at <= Date.now() + 60_000) return Response.json({ token: await this.refresh(record) });
        return Response.json({ token: record.access_token });
      });
      if (url.pathname === "/refresh") return await this.exclusive(async () => {
        const { rejected } = await request.json() as { rejected?: string };
        const record = await this.readRecord();
        if (rejected && record.access_token !== rejected) return Response.json({ token: record.access_token });
        return Response.json({ token: await this.refresh(record) });
      });
      if (url.pathname === "/secrets") return await this.exclusive(async () => {
        const record = await this.readRecord();
        return Response.json({ access: record.access_token, refresh: record.refresh_token });
      });
      return new Response("Not found", { status: 404 });
    } catch {
      return Response.json({ error: "OAuth operation failed." }, { status: 500 });
    }
  }

  private async callback(request: Request): Promise<Response> {
    const { code, state } = await request.json() as { code: string; state: string };
    const key = `state:${state}`;
    const valid = await this.state.storage.transaction(async (txn) => {
      const expires = await txn.get<number>(key);
      if (expires === undefined || expires < Date.now()) return false;
      await txn.delete(key);
      return true;
    });
    if (!valid) return Response.json({ ok: false }, { status: 400 });
    const record = await this.exchange({ grant_type: "authorization_code", code });
    await this.state.storage.put("token", record);
    return Response.json({ ok: true });
  }

  private async readRecord(): Promise<TokenRecord> {
    const record = await this.state.storage.get<TokenRecord>("token");
    if (!record?.access_token || !record.refresh_token) throw new Error("not authorized");
    return record;
  }

  private async refresh(current: TokenRecord): Promise<string> {
    const record = await this.exchange({ grant_type: "refresh_token", refresh_token: current.refresh_token }, current.refresh_token);
    await this.state.storage.put("token", record);
    return record.access_token;
  }

  private async exchange(data: Record<string, string>, previousRefreshToken?: string): Promise<TokenRecord> {
    const { WAKATIME_OAUTH_CLIENT_ID: client_id, WAKATIME_OAUTH_CLIENT_SECRET: client_secret, WAKATIME_OAUTH_REDIRECT_URI: redirect_uri } = this.env;
    if (!client_id || !client_secret || !redirect_uri) throw new Error("not configured");
    const response = await fetch("https://wakatime.com/oauth/token", {
      method: "POST", redirect: "manual", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id, client_secret, redirect_uri, ...data }),
    });
    if (!response.ok) throw new Error("token exchange failed");
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > 16 * 1024) throw new Error("oversized token response");
    const body = JSON.parse(text) as Record<string, unknown>;
    const access = body.access_token;
    const refresh = body.refresh_token ?? previousRefreshToken;
    if (typeof access !== "string" || !access || typeof refresh !== "string" || !refresh) throw new Error("invalid tokens");
    let expires_at: number | null = null;
    if (body.expires_in !== undefined) {
      const seconds = body.expires_in;
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) throw new Error("invalid expiry");
      expires_at = Date.now() + seconds * 1000;
      if (!Number.isFinite(expires_at) || expires_at <= Date.now() || expires_at > 8.64e15) throw new Error("invalid expiry");
    }
    return { access_token: access, refresh_token: refresh, expires_at };
  }
}
