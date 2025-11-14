import request from "supertest";
import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { createTestApp, createTestConfig, createTestDatabase } from "./helpers";
import { createS3Client } from "../src/lib/s3";
import type { AppConfig } from "../src/config";
import type { Database } from "../src/db";

describe("POST /v1/usage/asr-tick", () => {
  let config: AppConfig;
  let dbCtx: { db: Database; destroy: () => Promise<void> };
  let fetchMock: ReturnType<typeof vi.fn>;
  let nextTokenResponse: Response;

  beforeEach(async () => {
    process.env.INTERNAL_API_SECRET = "integration-secret";
    config = createTestConfig();
    dbCtx = await createTestDatabase();

    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? new URL(input) : new URL(input.toString());
      if (url.pathname === "/oauth/profile") {
        return new Response(
          JSON.stringify({ id: "user_123", email: "user@example.com" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.pathname.startsWith("/internal/users/")) {
        return nextTokenResponse;
      }

      throw new Error(`Unexpected request to ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await dbCtx.destroy();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.INTERNAL_API_SECRET;
  });

  function createApp() {
    const s3Client = createS3Client(config.s3);
    return createTestApp(config, dbCtx.db, s3Client);
  }

  it("returns updated balance after successful debit", async () => {
    nextTokenResponse = new Response(JSON.stringify({ token_balance: 5 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const app = createApp();

    const response = await request(app)
      .post("/v1/usage/asr-tick")
      .set("Authorization", "Bearer user_123")
      .expect(200);

    expect(response.body).toEqual({ token_balance: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const tokenCall = fetchMock.mock.calls[1];
    const headers = tokenCall?.[1]?.headers;
    let secret: string | null = null;
    if (headers instanceof Headers) {
      secret = headers.get("X-Internal-Secret");
    } else if (headers && typeof headers === "object") {
      const record = headers as Record<string, string>;
      secret = record["X-Internal-Secret"] ?? record["x-internal-secret"] ?? null;
    }
    expect(secret).toBe("integration-secret");
  });

  it("returns 402 when tokens are insufficient", async () => {
    nextTokenResponse = new Response(
      JSON.stringify({ error: "insufficient_tokens", token_balance: 0 }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
    const app = createApp();

    const response = await request(app)
      .post("/v1/usage/asr-tick")
      .set("Authorization", "Bearer user_123")
      .expect(402);

    expect(response.body).toEqual({ error: "insufficient_tokens", token_balance: 0 });
  });
});
