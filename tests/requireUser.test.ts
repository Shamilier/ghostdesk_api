import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProfileCache } from "../src/lib/profileCache";
import { requireUser } from "../src/middleware/requireUser";
import type { AppConfig } from "../src/config";
import { createTestConfig } from "./helpers";

function makeResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createApp(fetchMock: ReturnType<typeof vi.fn>, config: AppConfig) {
  const cache = new ProfileCache();
  const auth = requireUser({ config, cache, fetchImpl: fetchMock as any });
  const app = express();
  app.get("/protected", auth, (req, res) => {
    res.json({ id: req.user?.id, email: req.user?.email, plan: req.user?.plan });
  });
  return app;
}

describe("requireUser middleware", () => {
  let config: AppConfig;

  beforeEach(() => {
    config = createTestConfig();
  });

  it("attaches profile on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ id: "u1", email: "a@b" }));
    const app = createApp(fetchMock, config);

    const response = await request(app)
      .get("/protected")
      .set("Authorization", "Bearer token123")
      .expect(200);

    expect(response.body).toEqual({ id: "u1", email: "a@b", plan: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns 401 when auth backend denies access", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ error: "no" }, 401));
    const app = createApp(fetchMock, config);

    await request(app)
      .get("/protected")
      .set("Authorization", "Bearer denied")
      .expect(401);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns 503 when auth backend fails", async () => {
    const err = new Error("Timeout");
    err.name = "AbortError";
    const fetchMock = vi.fn().mockRejectedValue(err);
    const app = createApp(fetchMock, config);

    await request(app)
      .get("/protected")
      .set("Authorization", "Bearer timeout")
      .expect(503);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns 503 when auth backend responds with 5xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ error: "boom" }, 502));
    const app = createApp(fetchMock, config);

    await request(app)
      .get("/protected")
      .set("Authorization", "Bearer server")
      .expect(503);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses cache for repeated token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ id: "cached" }));
    const app = createApp(fetchMock, config);

    await request(app)
      .get("/protected")
      .set("Authorization", "Bearer repeat")
      .expect(200);

    await request(app)
      .get("/protected")
      .set("Authorization", "Bearer repeat")
      .expect(200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores X-User-Id header and always queries profile", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ id: "profile" }));
    const app = createApp(fetchMock, config);

    const response = await request(app)
      .get("/protected")
      .set("Authorization", "Bearer legit")
      .set("X-User-Id", "spoofed")
      .expect(200);

    expect(response.body.id).toBe("profile");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
