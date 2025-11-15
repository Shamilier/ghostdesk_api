import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "../config";
import { logger } from "../lib/logger";

export class InsufficientTokensError extends Error {
  readonly tokenBalance: number;

  constructor(tokenBalance: number) {
    super("insufficient_tokens");
    this.name = "InsufficientTokensError";
    this.tokenBalance = tokenBalance;
  }
}

interface TokenWalletConfiguration {
  config: AppConfig;
  fetchImpl?: typeof fetch;
}

type ConfiguredState = {
  profileUrl: string;
  fetchImpl: typeof fetch;
};

let configuredState: ConfiguredState | null = null;

type AuthedRequest = Request & { user?: { id?: string } };

export function configureTokenWallet({ config, fetchImpl }: TokenWalletConfiguration) {
  configuredState = {
    profileUrl: config.auth.profileUrl,
    fetchImpl: fetchImpl ?? fetch,
  };
}

function ensureConfigured(): ConfiguredState {
  if (!configuredState) {
    throw new Error("token wallet service is not configured");
  }
  return configuredState;
}

function ensureSecret(): string {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    throw new Error("INTERNAL_API_SECRET is not configured");
  }
  return secret;
}

function parseTokenBalance(value: unknown): number | null {
  const balance = Number(value);
  if (!Number.isFinite(balance)) {
    return null;
  }
  return balance;
}

export async function debitTokensForUser(
  userId: string | number,
  amount: number
): Promise<{ token_balance: number }> {
  const { profileUrl, fetchImpl } = ensureConfigured();
  const secret = ensureSecret();

  const baseUrl = new URL(profileUrl);
  const requestUrl = new URL(
    `/internal/users/${encodeURIComponent(String(userId))}/tokens/debit`,
    baseUrl
  );

  let response: Response;
  try {
    response = await fetchImpl(requestUrl.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Internal-Secret": secret,
      },
      body: JSON.stringify({ amount }),
    });
  } catch (error: any) {
    logger.error("token_wallet.request_failed", {
      message: error?.message ?? String(error),
      user_id: String(userId),
      url: requestUrl.toString(),
    });
    throw new Error("Failed to debit tokens");
  }

  let payload: any = null;
  try {
    payload = await response.json();
  } catch (error: any) {
    logger.error("token_wallet.invalid_json", {
      status: response.status,
      message: error?.message ?? String(error),
      user_id: String(userId),
    });
    throw new Error("Failed to debit tokens");
  }

  if (response.ok) {
    const balance = parseTokenBalance(payload?.token_balance);
    if (balance === null) {
      logger.error("token_wallet.missing_balance", {
        status: response.status,
        user_id: String(userId),
      });
      throw new Error("Invalid portal response");
    }
    return { token_balance: balance };
  }

  // 🔴 токены закончились — не важно, 402/403/409, смотрим на error
  if (payload?.error === "insufficient_tokens") {
    const balance = parseTokenBalance(payload?.token_balance);
    if (balance === null) {
      logger.error("token_wallet.invalid_insufficient_payload", {
        status: response.status,
        user_id: String(userId),
      });
      throw new Error("Failed to debit tokens");
    }
    throw new InsufficientTokensError(balance);
  }

  if (response.status >= 500) {
    logger.error("token_wallet.server_error", {
      status: response.status,
      user_id: String(userId),
    });
    throw new Error("Portal service unavailable");
  }

  logger.error("token_wallet.unexpected_status", {
    status: response.status,
    user_id: String(userId),
    error: payload?.error ?? null,
  });
  throw new Error("Failed to debit tokens");
}

export function requireTokens(cost: number) {
  return async function requireTokensMiddleware(
    req: AuthedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: "unauthorized" });
      }

      const { token_balance } = await debitTokensForUser(userId, cost);
      (res.locals as any).token_balance = token_balance;

      return next();
    } catch (err) {
      if (err instanceof InsufficientTokensError) {
        return res.status(402).json({
          error: "insufficient_tokens",
          message: "У вас недостаточно токенов. Пополните баланс на сайте ghostai.ru.",
          token_balance: err.tokenBalance,
        });
      }
      return next(err);
    }
  };
}

