import type { Request, Response, NextFunction } from "express";

/**
 * Simple shared-secret auth so this isn't an open remote endpoint anyone on the internet
 * can drive (each session spins up a real headless Chromium tab, which costs real memory).
 * Set MCP_AUTH_TOKEN in the hosting environment; clients send it as a Bearer token.
 * If MCP_AUTH_TOKEN is unset, auth is skipped (useful for local dev only — the deploy
 * config always sets it).
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected) return next(); // local dev fallback

  const header = req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (token !== expected) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: missing or invalid Bearer token." },
      id: null,
    });
    return;
  }
  next();
}
