import { randomUUID } from "node:crypto";

/**
 * Short-lived server-side store for exported files.
 *
 * Embedding a large base64 blob directly in an MCP tool result's "resource" content block
 * turned out to be unreliable over the deployed transport - large payloads arrived at the
 * client with the blob field silently missing (confirmed the server's own raw output was
 * correct via direct curl testing). Serving the file from a real HTTP endpoint and returning
 * a resource_link instead sidesteps that entirely, and is the more standard MCP pattern for
 * anything non-trivially sized.
 */

interface StoredDownload {
  filename: string;
  mimeType: string;
  buffer: Buffer;
  expiresAt: number;
}

const DOWNLOAD_TTL_MS = 15 * 60 * 1000; // 15 minutes - plenty to let a client fetch it promptly
const downloads = new Map<string, StoredDownload>();

export function storeDownload(filename: string, mimeType: string, buffer: Buffer): string {
  sweepExpired();
  const id = randomUUID();
  downloads.set(id, { filename, mimeType, buffer, expiresAt: Date.now() + DOWNLOAD_TTL_MS });
  return id;
}

export function getDownload(id: string): StoredDownload | undefined {
  const entry = downloads.get(id);
  if (!entry || entry.expiresAt < Date.now()) return undefined;
  return entry;
}

function sweepExpired() {
  const now = Date.now();
  for (const [id, entry] of downloads) {
    if (entry.expiresAt < now) downloads.delete(id);
  }
}
