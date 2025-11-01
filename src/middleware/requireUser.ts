import type { RequestHandler } from "express";
import { logger } from "../lib/logger";
import type { AppConfig } from "../config";
import { ProfileCache, sha256, type AuthProfile } from "../lib/profileCache";

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email?: string; plan?: string };
    }
  }
}

interface RequireUserOptions {
  config: AppConfig;
  cache: ProfileCache;
  fetchImpl?: typeof fetch;
}

const UNAUTHORIZED_RESPONSE = { error: "Unauthorized" } as const;
const AUTH_BACKEND_ERROR = { error: "auth backend unavailable" } as const;

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  const token = trimmed.slice("bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function toAuthProfile(data: unknown): AuthProfile | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "string" || !id) return null;
  const profile: AuthProfile = { id };
  if (typeof record.email === "string") {
    profile.email = record.email;
  }
  if (typeof record.plan === "string") {
    profile.plan = record.plan;
  }
  if (typeof record.created_at === "string") {
    profile.created_at = record.created_at;
  }
  return profile;
}

export function requireUser({ config, cache, fetchImpl }: RequireUserOptions): RequestHandler {
  const fetchFn = fetchImpl ?? fetch;

  return async (req, res, next) => {
    const header = req.get("authorization") ?? req.get("Authorization");
    const token = extractBearerToken(header);
    if (!token) {
      return res.status(401).json(UNAUTHORIZED_RESPONSE);
    }

    const tokenHash = sha256(token);
    const cached = cache.get(tokenHash);
    if (cached) {
      req.user = { id: cached.id, email: cached.email, plan: cached.plan };
      return next();
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.auth.timeoutMs);

    const requestId = req.get("x-request-id") ?? req.get("X-Request-Id") ?? undefined;

    let response: Response;
    try {
      response = await fetchFn(config.auth.profileUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } catch (error: any) {
      clearTimeout(timeout);
      const message = error?.name === "AbortError" ? "timeout" : error?.message;
      logger.error("auth.fetch_failed", { message, request_id: requestId });
      return res.status(503).json(AUTH_BACKEND_ERROR);
    }

    clearTimeout(timeout);

    if (response.status === 401 || response.status === 403) {
      logger.warn("auth.denied", { status: response.status, request_id: requestId });
      return res.status(401).json(UNAUTHORIZED_RESPONSE);
    }

    if (!response.ok) {
      logger.error("auth.unexpected_status", {
        status: response.status,
        request_id: requestId,
      });
      return res.status(503).json(AUTH_BACKEND_ERROR);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (error: any) {
      logger.error("auth.invalid_json", { message: error?.message, request_id: requestId });
      return res.status(503).json(AUTH_BACKEND_ERROR);
    }

    const profile = toAuthProfile(data);
    if (!profile) {
      logger.error("auth.invalid_profile", { request_id: requestId });
      return res.status(503).json(AUTH_BACKEND_ERROR);
    }

    cache.set(tokenHash, profile, config.auth.cacheTtlMs);
    req.user = { id: profile.id, email: profile.email, plan: profile.plan };
    return next();
  };
}
