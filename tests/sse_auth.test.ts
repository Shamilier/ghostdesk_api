import type express from "express";
import request from "supertest";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { createApp } from "../src/app";
import { createTestConfig, createTestDatabase } from "./helpers";

describe("streaming endpoints auth", () => {
  let app: express.Express;
  let destroyDb: () => Promise<void>;

  beforeEach(async () => {
    const { db, destroy } = await createTestDatabase();
    destroyDb = destroy;

    const config = createTestConfig();
    const s3Client = { send: vi.fn() } as unknown as S3Client;

    app = createApp({ config, db, s3Client });
  });

  afterEach(async () => {
    await destroyDb();
    vi.resetAllMocks();
  });

  it("rejects /hint requests without bearer token", async () => {
    await request(app)
      .post("/hint")
      .send({ context: "hello" })
      .expect(401);
  });

  it("rejects /ask requests without bearer token", async () => {
    await request(app)
      .post("/ask")
      .expect(401);
  });

  it("rejects /ask_without_query requests without bearer token", async () => {
    await request(app)
      .post("/ask_without_query")
      .expect(401);
  });
});
