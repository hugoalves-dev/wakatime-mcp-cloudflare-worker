import { OAuthCoordinator } from "../../src/oauth-coordinator.js";

export class MemoryDurableStorage {
  values = new Map<string, unknown>();
  private chain: Promise<void> = Promise.resolve();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  async transaction<T>(fn: (storage: this) => Promise<T>): Promise<T> {
    const before = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((resolve) => { release = resolve; });
    await before;
    try { return await fn(this); } finally { release(); }
  }
}

export class MemoryCoordinatorNamespace {
  storage = new MemoryDurableStorage();
  get values() {
    const storage = this.storage;
    const keyFor = (key: string) => key === "oauth:token" ? "token" : key.replace(/^oauth:state:/, "state:");
    return {
      get(key: string) { const k = keyFor(key); const v = storage.values.get(k); return k === "token" && v !== undefined ? JSON.stringify(v) : v === undefined ? undefined : "1"; },
      set(key: string, value: string) { const k = keyFor(key); storage.values.set(k, k === "token" ? JSON.parse(value) : Date.now() + 600_000); },
      has(key: string) { return storage.values.has(keyFor(key)); },
      delete(key: string) { return storage.values.delete(keyFor(key)); },
      get size() { return storage.values.size; },
    };
  }
  private object: OAuthCoordinator;
  constructor(env: Record<string, unknown>) {
    this.object = new OAuthCoordinator({ storage: this.storage } as unknown as DurableObjectState, env as never);
  }
  idFromName(_name: string): DurableObjectId { return "test" as unknown as DurableObjectId; }
  get(_id: DurableObjectId): DurableObjectStub {
    return { fetch: (input: RequestInfo | URL, init?: RequestInit) => this.object.fetch(new Request(input, init)) } as unknown as DurableObjectStub;
  }
}

export function setToken(ns: MemoryCoordinatorNamespace, record: unknown) { ns.storage.values.set("token", record); }
export function setState(ns: MemoryCoordinatorNamespace, state: string) { ns.storage.values.set(`state:${state}`, Date.now() + 600_000); }
