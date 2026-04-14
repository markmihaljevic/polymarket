// Thin wrapper around an Upstash Redis store.
//
// We keep a single key — the latest snapshot JSON. If the Redis env vars
// aren't set (e.g., developing locally without provisioning a store), fall
// back to an in-process variable so `npm run dev` still works.
//
// This supports two env var conventions:
//   - KV_REST_API_URL / KV_REST_API_TOKEN         (Vercel KV / legacy)
//   - UPSTASH_REDIS_REST_URL / *_TOKEN            (Upstash Marketplace integration)

import { Redis } from "@upstash/redis";
import type { Snapshot } from "./types";

const SNAPSHOT_KEY = "polymarket:edge:snapshot:v1";

let inMemory: Snapshot | null = null;
let cachedClient: Redis | null = null;

function getClient(): Redis | null {
  if (cachedClient) return cachedClient;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  cachedClient = new Redis({ url, token });
  return cachedClient;
}

export async function writeSnapshot(snap: Snapshot): Promise<void> {
  const client = getClient();
  if (client) {
    await client.set(SNAPSHOT_KEY, snap);
    return;
  }
  inMemory = snap;
}

export async function readSnapshot(): Promise<Snapshot | null> {
  const client = getClient();
  if (client) {
    const snap = (await client.get<Snapshot>(SNAPSHOT_KEY)) ?? null;
    return snap;
  }
  return inMemory;
}
