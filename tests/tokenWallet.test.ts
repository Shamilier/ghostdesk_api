import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestConfig } from "./helpers";
import { configureTokenWallet, debitTokensForUser } from "../src/services/tokenWallet";

const jsonResponse = (body: Record<string, unknown>, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });

describe("tokenWallet", () => {
  const config = createTestConfig();
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.INTERNAL_API_SECRET;
    process.env.INTERNAL_API_SECRET = "test-secret";
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.INTERNAL_API_SECRET;
    } else {
      process.env.INTERNAL_API_SECRET = originalSecret;
    }
  });

  it("returns new balance when debit succeeds", async () => {
    const fetchMock = async () => jsonResponse({ token_balance: 41 });
    configureTokenWallet({ config, fetchImpl: fetchMock });

    const result = await debitTokensForUser("user-1", 1);

    expect(result).toEqual({ token_balance: 41 });
  });

  it("throws InsufficientTokensError when balance too low", async () => {
    const fetchMock = async () =>
      jsonResponse({ error: "insufficient_tokens", token_balance: 0 }, { status: 403 });
    configureTokenWallet({ config, fetchImpl: fetchMock });

    await expect(debitTokensForUser("user-1", 1)).rejects.toMatchObject({
      name: "InsufficientTokensError",
      tokenBalance: 0,
    });
  });

  it("throws generic error on server failure", async () => {
    const fetchMock = async () => jsonResponse({ error: "server" }, { status: 500 });
    configureTokenWallet({ config, fetchImpl: fetchMock });

    await expect(debitTokensForUser("user-1", 1)).rejects.toThrowError(
      "Portal service unavailable"
    );
  });
});
