import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { randomUUID } from "node:crypto";

/** The live site this server drives. Override via env var if the deployment URL ever changes. */
export const SITE_URL = process.env.RESUME_BUILDER_URL || "https://gutts-resumebuilder.onrender.com";

/** A session's browser page sits idle at most this long before the sweep reclaims it. */
const SESSION_IDLE_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface Session {
  id: string;
  context: BrowserContext;
  page: Page;
  createdAt: number;
  lastUsedAt: number;
}

/** Thrown when a tool references a session_id that doesn't exist (or expired) —
 *  the message is written to be directly actionable for the calling LLM. */
export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(
      `No active resume session with id "${sessionId}". Sessions expire after ${SESSION_IDLE_TIMEOUT_MS / 60000} ` +
      `minutes of inactivity, or the server may have restarted. Call start_resume again to begin a new session, ` +
      `then use the new session_id it returns for every following call.`
    );
    this.name = "SessionNotFoundError";
  }
}

let browserPromise: Promise<Browser> | null = null;
const sessions = new Map<string, Session>();

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        headless: true,
        args: ["--disable-dev-shm-usage"], // avoids /dev/shm exhaustion in small containers
      })
      .catch((err) => {
        // Don't cache a failed launch forever - let the next call try again
        // (e.g. a transient resource issue, or browsers not yet installed).
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

/** Create a new isolated browser session (its own cookies/localStorage) and load the site. */
export async function createSession(): Promise<Session> {
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(SITE_URL, { waitUntil: "networkidle" });

  // The site loads its fonts (DM Sans/DM Mono/Playfair Display) from Google Fonts with
  // display=swap - the browser paints a fallback font first, then swaps once the real one
  // loads. A human always has the real fonts in well before they interact with anything, but
  // a fresh automated session could call a tool within milliseconds of this goto() resolving.
  // Without waiting here, every downstream visual read in this session - PDF export,
  // screenshots, even the JS-based one-page overflow check - could be measuring against the
  // fallback font's different character widths instead of the real ones. Wait once, up front,
  // so everything for the rest of this session's life sees what a human would see.
  await page.evaluate(() => document.fonts.ready);

  const id = randomUUID();
  const now = Date.now();
  const session: Session = { id, context, page, createdAt: now, lastUsedAt: now };
  sessions.set(id, session);
  return session;
}

/** Look up a session's page by id, refreshing its idle timer. Throws SessionNotFoundError if missing. */
export function getSessionPage(sessionId: string): Page {
  const session = sessions.get(sessionId);
  if (!session) throw new SessionNotFoundError(sessionId);
  session.lastUsedAt = Date.now();
  return session.page;
}

/** Explicitly end a session and free its browser resources. Safe to call on an already-gone id. */
export async function closeSession(sessionId: string): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) return false;
  sessions.delete(sessionId);
  await session.context.close().catch(() => {});
  return true;
}

export function listSessionIds(): string[] {
  return [...sessions.keys()];
}

/** Periodic sweep — closes sessions nobody has touched in a while so the server doesn't
 *  slowly accumulate idle headless-Chromium tabs (each one holds real memory). */
function startIdleSweep() {
  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastUsedAt > SESSION_IDLE_TIMEOUT_MS) {
        sessions.delete(id);
        session.context.close().catch(() => {});
      }
    }
  }, SWEEP_INTERVAL_MS).unref();
}
startIdleSweep();

/** Graceful shutdown hook — close every open context and the shared browser. */
export async function shutdownBrowser(): Promise<void> {
  for (const session of sessions.values()) {
    await session.context.close().catch(() => {});
  }
  sessions.clear();
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close().catch(() => {});
    browserPromise = null;
  }
}
