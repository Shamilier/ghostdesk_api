import { createHash } from "node:crypto";

export interface AuthProfile {
  id: string;
  email?: string;
  plan?: string;
  created_at?: string;
}

interface CacheEntry {
  profile: AuthProfile;
  expiresAt: number;
}

export class ProfileCache {
  private readonly store = new Map<string, CacheEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
  }

  get(tokenHash: string): AuthProfile | null {
    const entry = this.store.get(tokenHash);
    if (!entry) {
      return null;
    }

    if (Date.now() >= entry.expiresAt) {
      this.store.delete(tokenHash);
      return null;
    }

    this.store.delete(tokenHash);
    this.store.set(tokenHash, entry);

    return entry.profile;
  }

  set(tokenHash: string, profile: AuthProfile, ttlMs: number): void {
    const expiresAt = Date.now() + Math.max(ttlMs, 0);
    if (this.store.has(tokenHash)) {
      this.store.delete(tokenHash);
    }
    this.store.set(tokenHash, { profile, expiresAt });

    if (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value as string | undefined;
      if (oldest) {
        this.store.delete(oldest);
      }
    }
  }
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
