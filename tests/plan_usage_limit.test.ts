import type express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { createApp } from "../src/app";
import { createTestConfig, createTestDatabase } from "./helpers";

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("plan usage limits", () => {
  let app: express.Express;
  let destroyDb: () => Promise<void>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const { db, destroy } = await createTestDatabase();
    destroyDb = destroy;

    const config = createTestConfig();
    config.usageLimits = {
      windowMs: 60_000,
      defaultPlan: "free",
      plans: {
        free: { hint: 0, ask: 0 },
        pro: { hint: 200, ask: 200 },
        premium: { hint: 200, ask: 200 },
        admin: null,
      },
    };

    fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "user-1", plan: "free" }));
    vi.stubGlobal("fetch", fetchMock);

    const s3Client = { send: vi.fn() } as unknown as S3Client;
    app = createApp({ config, db, s3Client });
  });

  afterEach(async () => {
    await destroyDb();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it("rejects /hint when the plan allowance is exhausted", async () => {
    const response = await request(app)
      .post("/hint")
      .set("Authorization", "Bearer token")
      .send({ context: "hello" })
      .expect(429);

    expect(response.body).toMatchObject({
      error: "Usage limit exceeded",
      plan: "free",
      endpoint: "hint",
    });
    expect(response.headers["x-usage-plan"]).toBe("free");
    expect(response.headers["x-usage-limit"]).toBe("0");
    expect(response.headers["x-usage-remaining"]).toBe("0");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("allows admin users to bypass limits", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "admin-1", plan: "admin" }));

    const response = await request(app)
      .post("/hint")
      .set("Authorization", "Bearer admin-token")
      .send({ context: "hello" })
      .expect((res) => {
        if (res.status === 429) {
          throw new Error(`expected admin request to bypass plan limit, got status ${res.status}`);
        }
      });

    expect(response.headers["x-usage-limit"]).toBe("unlimited");
  });

  it("rejects /ask_without_query after the allowance is exhausted", async () => {
    const response = await request(app)
      .post("/ask_without_query")
      .set("Authorization", "Bearer token")
      .field("sessionId", "abc")
      .expect(429);

    expect(response.body).toMatchObject({ endpoint: "ask", plan: "free" });
  });
});
