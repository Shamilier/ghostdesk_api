import type { Request, RequestHandler } from "express";

function extractUserId(req: Request): string | null {
  const explicitUserId = req.get("x-user-id") ?? req.get("X-User-Id");
  if (explicitUserId) {
    const trimmed = explicitUserId.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  const authorization = req.get("authorization") ?? req.get("Authorization");
  if (!authorization) {
    return null;
  }

  const parts = authorization.trim().split(/\s+/);
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
    return parts[1];
  }

  return null;
}

export const requireUser: RequestHandler = (req, res, next) => {
  const userId = extractUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  req.user = { id: userId };
  return next();
};
