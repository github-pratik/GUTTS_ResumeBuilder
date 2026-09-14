# GUTTS Resume Builder MCP Server

A remote MCP (Model Context Protocol) server that lets Claude drive the live [GUTTS Resume
Builder](https://gutts-resumebuilder.onrender.com) website like a real user — filling in a
student's info, adding jobs, importing an old resume, checking ATS keyword match, and
exporting a finished PDF or Word doc — all through the site's own already-correct logic (it
controls a real headless browser pointed at the live site, it doesn't reimplement anything).

## How it works

- Each Claude conversation calls `start_resume`, which opens an isolated headless-browser tab
  on the live site and returns a `session_id`.
- Every other tool takes that `session_id` and acts on that same tab — filling fields, reading
  state back, or exporting a file — by calling the page's own JS functions, exactly like a
  human clicking around would.
- Sessions auto-expire after 20 minutes of inactivity to free server resources; call
  `end_resume_session` when done to close one immediately.

## Local development

```bash
npm install
npx playwright install chromium   # first time only - downloads the browser binary
npm run build
npm start
```

The server listens on `PORT` (default `3000`) and exposes:
- `POST /mcp` — the MCP endpoint (Streamable HTTP transport)
- `GET /health` — plain JSON health check

Without `MCP_AUTH_TOKEN` set, `/mcp` is open (fine for local dev only — never deploy it that
way).

## Deploying to Render

This is a **Docker-based Render Web Service** (not a static site) because it needs to run a
real headless Chromium process — Playwright's official Docker image bundles Chromium plus
all its OS-level dependencies.

1. Push this repo (the `mcp-server/` folder) to GitHub if it isn't already.
2. In the Render dashboard: **New > Web Service**, connect this repo, set the **Root
   Directory** to `mcp-server`, and Render should auto-detect `Dockerfile` (or apply
   `render.yaml` as a Blueprint if you use the "New > Blueprint" flow instead).
3. Set the environment variable **`MCP_AUTH_TOKEN`** to a long random secret, e.g. generate
   one locally with:
   ```bash
   openssl rand -hex 32
   ```
   Keep this value private — anyone with it can spin up sessions (real Chromium processes)
   on your server.
4. Leave `RESUME_BUILDER_URL` at its default (already points at the live site) unless the
   deployment URL ever changes.
5. Pick at least the **Starter** plan — headless Chromium needs real memory, and each
   concurrent resume session holds its own browser tab. If several people will use this at
   once, size up.
6. Deploy. Once live, your MCP endpoint is `https://<your-service>.onrender.com/mcp`.

## Connecting it to Claude

Add it as a remote MCP connector, pointing at `https://<your-service>.onrender.com/mcp` with
an `Authorization: Bearer <your MCP_AUTH_TOKEN>` header. Exactly where this is configured
depends on which Claude surface you're using (claude.ai custom connectors, Claude Code's MCP
config, etc.) — the pieces you need either way are just that URL and that header.

## Tools

| Tool | Purpose |
|---|---|
| `start_resume` | Opens a session, loads the HVAC or Plumbing template. Call first. |
| `end_resume_session` | Closes a session early. |
| `set_personal_info` | Name, city/state, graduation date. |
| `set_education` | Replaces the education list. |
| `add_work_experience` | Adds one job (in addition to the template's GUTTS entry). |
| `add_skills` | Adds extra technical/soft skills on top of the template's base set. |
| `set_relevant_info` | Replaces the Relevant Information sidebar list. |
| `import_resume_text` | Runs the site's own resume-text parser (fuzzy or exact-reopen mode). |
| `set_resume_fit` | Compact/Normal/Roomy/Spacious density preset. |
| `set_page_size` | Letter or A4. |
| `check_ats_match` | Runs the site's ATS keyword matcher against a job description. |
| `get_resume_preview` | Structured summary + full text + optional screenshot. |
| `export_resume_pdf` | Real print-engine PDF export. |
| `export_resume_word` | Triggers the site's Word export and returns the file. |
| `start_new_resume` | Resets the session to build a second resume without reconnecting. |

## Notes

- This server never touches a database — all state lives inside the live site's own page
  (same as a human using it), scoped to one browser tab per session.
- Phone/email are intentionally not settable — every GUTTS resume shows GUTTS' own contact
  info by design, matching the site's own behavior.
