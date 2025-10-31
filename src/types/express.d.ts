import type { Request } from "express";

declare global {
  namespace Express {
    interface User {
      id: string;
      organizationId?: string | null;
      token?: string | null;
    }

    interface Request {
      user?: User;
    }
  }
}

export type AuthenticatedRequest = Request & { user: Express.User };
