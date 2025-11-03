import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import {
  S3Client,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { createTestApp, createTestConfig, createTestDatabase } from "./helpers";
import type { AppConfig } from "../src/config";
import type { Database } from "../src/db";
import { createS3Client } from "../src/lib/s3";
import { findRecordingById } from "../src/modules/recordings/repository";

const s3Mock = mockClient(S3Client);

describe("recordings API", () => {
  let config: AppConfig;
  let dbCtx: { db: Database; destroy: () => Promise<void> };
  let app: ReturnType<typeof createTestApp>;
  let s3Client: S3Client;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    s3Mock.reset();
    config = createTestConfig();

    const profileResponse = (body: Record<string, unknown>, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    const extractToken = (headers: HeadersInit | undefined) => {
      if (!headers) return null;
      if (headers instanceof Headers) {
        const value = headers.get("authorization") ?? headers.get("Authorization");
        return value ? value.replace(/^Bearer\s+/i, "").trim() : null;
      }
      const record = headers as Record<string, string>;
      const value = record["Authorization"] ?? record["authorization"];
      return value ? value.replace(/^Bearer\s+/i, "").trim() : null;
    };

    fetchSpy = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => {
      const token = extractToken(options?.headers);
      switch (token) {
        case "user_123":
          return profileResponse({ id: "user_123", email: "user@example.com", plan: "pro" });
        case "someone_else":
          return profileResponse({ id: "someone_else" });
        case "tricky":
          return profileResponse({ id: "abc/../.." });
        default:
          return profileResponse({ error: "unauthorized" }, 401);
      }
    });

    vi.stubGlobal("fetch", fetchSpy);

    dbCtx = await createTestDatabase();
    s3Client = createS3Client(config.s3);
    app = createTestApp(config, dbCtx.db, s3Client);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await dbCtx.destroy();
  });

  async function initRecording(clientRequestId?: string, token = "user_123") {
    const payload: Record<string, unknown> = {
      started_at: "2025-10-31T10:00:00Z",
      ended_at: "2025-10-31T10:10:00Z",
      lang: "ru",
      codec: "aac",
      bitrate_kbps: 64,
      content_type: "audio/mp4",
    };
    if (clientRequestId) {
      payload.client_request_id = clientRequestId;
    }

    const response = await request(app)
      .post("/v1/recordings/init")
      .set("Authorization", `Bearer ${token}`)
      .send(payload)
      .expect(200);

    return response.body as {
      recording_id: string;
      upload: { url: string };
    };
  }

  it("returns same recording for repeated client_request_id", async () => {
    const first = await initRecording("dedupe-1");
    const second = await initRecording("dedupe-1");

    expect(second.recording_id).toBe(first.recording_id);
    expect(second.upload.url).toBeDefined();
  });

  it("completes upload flow", async () => {
    const headResponse = {
      ContentLength: 1024,
      ETag: '"etag-1"',
      $metadata: { requestId: "req-1" },
    };
    s3Mock.on(HeadObjectCommand).resolves(headResponse as any);

    const init = await initRecording();
    expect(init.upload.url).toMatch(/^https?:/);

    const complete = await request(app)
      .post("/v1/recordings/complete")
      .set("Authorization", "Bearer user_123")
      .send({ recording_id: init.recording_id, size_bytes: 1024 })
      .expect(200);

    expect(complete.body.status).toBe("uploaded");
    expect(complete.body.etag).toBe('"etag-1"');

    const list = await request(app)
      .get("/v1/recordings")
      .set("Authorization", "Bearer user_123")
      .expect(200);

    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].status).toBe("uploaded");
    expect(list.body.items[0].transcript_status).toBe("none");
    expect(list.body.items[0].transcript_summary).toBeNull();

    const details = await request(app)
      .get(`/v1/recordings/${init.recording_id}`)
      .set("Authorization", "Bearer user_123")
      .expect(200);

    expect(details.body.transcript_status).toBe("none");
    expect(details.body.transcript_summary).toBeNull();

    const transcript = await request(app)
      .get(`/v1/recordings/${init.recording_id}/transcript`)
      .set("Authorization", "Bearer user_123")
      .expect(200);

    expect(transcript.body).toEqual({ status: "none" });
  });

  it("sanitizes user id in s3 key", async () => {
    const init = await initRecording(undefined, "tricky");

    const record = await findRecordingById(dbCtx.db, init.recording_id, "abc/../..");
    const sanitized = "abc/../..".replace(/[^A-Za-z0-9._-]/g, "_");
    const escaped = sanitized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(record?.s3Key).toMatch(new RegExp(`^user_${escaped}/`));
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("is idempotent for complete", async () => {
    s3Mock.on(HeadObjectCommand).resolves({
      ContentLength: 2048,
      ETag: '"etag-2"',
      $metadata: { requestId: "req-2" },
    } as any);

    const { recording_id } = await initRecording();

    await request(app)
      .post("/v1/recordings/complete")
      .set("Authorization", "Bearer user_123")
      .send({ recording_id, size_bytes: 2048 })
      .expect(200);

    const second = await request(app)
      .post("/v1/recordings/complete")
      .set("Authorization", "Bearer user_123")
      .send({ recording_id })
      .expect(200);

    expect(second.body.status).toBe("uploaded");
    expect(second.body.size_bytes).toBe(2048);
  });

  it("rejects unsupported content type", async () => {
    await request(app)
      .post("/v1/recordings/init")
      .set("Authorization", "Bearer user_123")
      .send({ content_type: "audio/wav" })
      .expect(400);
  });

  it("fails complete if object missing", async () => {
    s3Mock.on(HeadObjectCommand).rejects(new Error("NotFound"));

    const { recording_id } = await initRecording();

    await request(app)
      .post("/v1/recordings/complete")
      .set("Authorization", "Bearer user_123")
      .send({ recording_id })
      .expect(424);
  });

  it("enforces size limit", async () => {
    config.recordings.maxBytes = 1000;
    s3Mock.on(HeadObjectCommand).resolves({
      ContentLength: 2000,
      ETag: '"etag-limit"',
      $metadata: { requestId: "req-limit" },
    } as any);

    const { recording_id } = await initRecording();

    const response = await request(app)
      .post("/v1/recordings/complete")
      .set("Authorization", "Bearer user_123")
      .send({ recording_id })
      .expect(413);

    expect(response.body.error).toBeDefined();

    const record = await findRecordingById(dbCtx.db, recording_id, "user_123");
    expect(record?.status).toBe("failed");
  });

  it("prevents access to another user's recording", async () => {
    s3Mock.on(HeadObjectCommand).resolves({
      ContentLength: 512,
      ETag: '"etag-owner"',
      $metadata: { requestId: "req-owner" },
    } as any);

    const { recording_id } = await initRecording();

    await request(app)
      .get(`/v1/recordings/${recording_id}`)
      .set("Authorization", "Bearer someone_else")
      .expect(404);
  });
});
