import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { requireAuth } from "./auth.js";
import {
  createSession,
  getSessionPage,
  closeSession,
  listSessionIds,
  shutdownBrowser,
  SITE_URL,
} from "./browserSession.js";
import * as actions from "./resumeActions.js";

const server = new McpServer({
  name: "gutts-resume-builder",
  version: "1.0.0",
  description:
    `Drives the live GUTTS Resume Builder website (${SITE_URL}) through a real headless ` +
    `browser, so a resume can be built, edited, checked, and exported end-to-end without a ` +
    `human clicking through the UI. Every tool after start_resume needs the session_id it returns.`,
});

const sessionIdField = z
  .string()
  .describe('The session_id returned by start_resume. Reuse the SAME id for every call while building one resume.');

// ===== SESSION LIFECYCLE =====

server.registerTool(
  "start_resume",
  {
    title: "Start a new resume",
    description:
      "Opens a fresh session on the live GUTTS Resume Builder site and loads the HVAC or " +
      "Plumbing template — this sets the program-common content (Profile Summary, " +
      "Certifications, base Technical/Soft Skills, and the GUTTS pre-apprenticeship job " +
      "entry) exactly as the site's own template buttons do. Call this first; every other " +
      "tool needs the session_id it returns. Sessions auto-expire after 20 minutes idle.",
    inputSchema: {
      program: z
        .enum(["hvac", "plumbing"])
        .describe("Which GUTTS pre-apprenticeship program this student completed."),
    },
  },
  async ({ program }) => {
    const session = await createSession();
    await actions.loadTemplate(session.page, program);
    const summary = await actions.getResumeSummary(session.page);
    return {
      content: [
        {
          type: "text",
          text:
            `Started session ${session.id} with the ${program.toUpperCase()} template loaded.\n\n` +
            JSON.stringify(summary, null, 2),
        },
      ],
    };
  }
);

server.registerTool(
  "end_resume_session",
  {
    title: "End a resume session",
    description:
      "Closes a session's browser tab and frees its resources. Call this once you're done " +
      "with a resume (after exporting it) — sessions also auto-expire after 20 minutes idle, " +
      "but ending explicitly is more considerate of server resources.",
    inputSchema: { session_id: sessionIdField },
  },
  async ({ session_id }) => {
    const closed = await closeSession(session_id);
    return {
      content: [
        {
          type: "text",
          text: closed ? `Session ${session_id} closed.` : `Session ${session_id} was already gone.`,
        },
      ],
    };
  }
);

// ===== PER-STUDENT DYNAMIC CONTENT =====

server.registerTool(
  "set_personal_info",
  {
    title: "Set name, city/state, and graduation date",
    description:
      "Sets the student's name and (optionally) their city/state and graduation month/year. " +
      "Phone and email are intentionally NOT settable here — every GUTTS resume always shows " +
      "GUTTS' own contact info (844-464-8887 / operations@gutts.tech), never the student's " +
      "personal contact info, by design. Omit city/state to leave them at the Fairfax, VA default.",
    inputSchema: {
      session_id: sessionIdField,
      name: z.string().min(1).describe('Student\'s full name, e.g. "Marcus Johnson".'),
      city: z.string().optional().describe('Student\'s city, e.g. "Arlington". Defaults to Fairfax if omitted.'),
      state: z.string().length(2).optional().describe('Two-letter state code, e.g. "VA".'),
      graduation_date: z
        .string()
        .optional()
        .describe('Graduation month/year as shown on the resume, e.g. "AUG 2026". Also used as the GUTTS job entry\'s date.'),
    },
  },
  async ({ session_id, name, city, state, graduation_date }) => {
    const page = getSessionPage(session_id);
    await actions.setPersonalInfo(page, { name, city, state, graduationDate: graduation_date });
    return { content: [{ type: "text", text: `Updated personal info for session ${session_id}.` }] };
  }
);

server.registerTool(
  "set_education",
  {
    title: "Set education entries",
    description:
      "Replaces the resume's entire Education list with the given entries (up to 4). Each " +
      "entry prints as: Degree / School[, City] / Year. Pass every entry the student should " +
      "have — this REPLACES the list, it doesn't append to it.",
    inputSchema: {
      session_id: sessionIdField,
      entries: z
        .array(
          z.object({
            degree: z.string().optional().describe('e.g. "High School Diploma".'),
            school: z.string().optional().describe('e.g. "Woodbridge High School".'),
            city: z.string().optional().describe('e.g. "Woodbridge, VA".'),
            year: z.string().optional().describe('e.g. "2022".'),
          })
        )
        .max(4)
        .describe("Up to 4 education entries, most relevant first."),
    },
  },
  async ({ session_id, entries }) => {
    const page = getSessionPage(session_id);
    await actions.setEducation(page, entries);
    return { content: [{ type: "text", text: `Set ${entries.length} education entr${entries.length === 1 ? "y" : "ies"}.` }] };
  }
);

server.registerTool(
  "add_work_experience",
  {
    title: "Add a work experience entry",
    description:
      "Adds ONE additional job to the resume, after the standard GUTTS pre-apprenticeship " +
      "entry (which is always present from the template and should NOT be added again here). " +
      "Use this for a student's real outside work history — e.g. from an old resume you're " +
      "converting. Call once per job; up to 6 additional jobs fit (7 total including the " +
      "GUTTS entry).",
    inputSchema: {
      session_id: sessionIdField,
      title: z.string().min(1).describe('Job title, e.g. "Lyft Driver".'),
      company: z.string().optional().describe('Employer name, e.g. "Hilton Hotel".'),
      location: z.string().optional().describe('e.g. "Arlington, VA". Omit to hide the location entirely (no placeholder text).'),
      date: z.string().optional().describe('Date range as shown on the resume, e.g. "Apr 2025 – Present".'),
      bullets: z.array(z.string()).max(7).optional().describe("Up to 7 bullet points describing the role."),
    },
  },
  async ({ session_id, title, company, location, date, bullets }) => {
    const page = getSessionPage(session_id);
    await actions.addJob(page, { title, company, location, date, bullets });
    const summary = await actions.getResumeSummary(page);
    return {
      content: [
        { type: "text", text: `Added "${title}". Resume now has ${summary.jobCount} job(s): ${summary.jobTitles.join(", ")}.` },
      ],
    };
  }
);

server.registerTool(
  "add_skills",
  {
    title: "Add extra technical/soft skills",
    description:
      "Adds skills ON TOP of the program's base skill list (never replaces it) — deduped " +
      "case-insensitively and capped at 30 per list, same as the site's own merge logic. Use " +
      "this for skills specific to one student beyond the standard HVAC/Plumbing set.",
    inputSchema: {
      session_id: sessionIdField,
      technical: z.array(z.string()).optional().describe("Extra Technical Skills to add."),
      soft: z.array(z.string()).optional().describe("Extra Soft Skills to add."),
    },
  },
  async ({ session_id, technical, soft }) => {
    const page = getSessionPage(session_id);
    await actions.addSkills(page, technical, soft);
    const summary = await actions.getResumeSummary(page);
    return {
      content: [
        {
          type: "text",
          text: `Now ${summary.technicalSkillsCount} technical skill(s), ${summary.softSkillsCount} soft skill(s).`,
        },
      ],
    };
  }
);

server.registerTool(
  "set_relevant_info",
  {
    title: "Set the Relevant Information list",
    description:
      'Replaces the "Relevant Information" sidebar list — things like Driver\'s License, ' +
      "US Citizen status, languages, work authorization. Defaults to \"Driver's License: Yes\" " +
      "and \"US Citizen: Yes\" from the template if never called. Pass every item the student " +
      "should have; this REPLACES the list.",
    inputSchema: {
      session_id: sessionIdField,
      items: z
        .array(z.string())
        .max(10)
        .describe('e.g. ["Driver\'s License: Yes", "Languages: English, Spanish"].'),
    },
  },
  async ({ session_id, items }) => {
    const page = getSessionPage(session_id);
    await actions.setRelevantInfo(page, items);
    return { content: [{ type: "text", text: `Set ${items.length} relevant info item(s).` }] };
  }
);

// ===== BULK IMPORT (reuses the site's own parser) =====

server.registerTool(
  "import_resume_text",
  {
    title: "Import an old resume's pasted text",
    description:
      "Runs the site's own Import Resume feature: heuristically parses pasted resume text " +
      "and fills the form. Two modes: (1) default — pulls only per-student dynamic fields " +
      "(name, education, relevant info, extra skills merged on top of the base list, and " +
      "real additional work history) while leaving Profile Summary/Certifications/base " +
      "Skills/the GUTTS job entry untouched; auto-detects and switches HVAC vs Plumbing " +
      "template from the text. (2) exact_mode — for RE-IMPORTING a resume this tool itself " +
      "already generated (e.g. to fix a mistake): restores EVERY field exactly as printed, " +
      "overwriting Summary/Certs/Skills/all jobs too. Returns the site's own filled/missing " +
      "report so you can see what needs manual review.",
    inputSchema: {
      session_id: sessionIdField,
      text: z.string().min(1).describe("The old resume's full text, e.g. copy-pasted from a Word doc or PDF."),
      exact_mode: z
        .boolean()
        .default(false)
        .describe("True only when re-importing a resume this same tool previously generated."),
    },
  },
  async ({ session_id, text, exact_mode }) => {
    const page = getSessionPage(session_id);
    const report = await actions.importResumeText(page, text, exact_mode);
    const summary = await actions.getResumeSummary(page);
    return {
      content: [
        { type: "text", text: `${report}\n\n---\nCurrent state:\n${JSON.stringify(summary, null, 2)}` },
      ],
    };
  }
);

// ===== LAYOUT =====

server.registerTool(
  "set_resume_fit",
  {
    title: "Set the Resume Fit density preset",
    description:
      "Switches font size/spacing density. Use tighter presets when a resume runs long. " +
      "Check get_resume_preview's overflows_one_page field after adding content — if true, " +
      "try 'compact' before adding more content or trimming.",
    inputSchema: {
      session_id: sessionIdField,
      preset: z.enum(["compact", "normal", "roomy", "spacious"]),
    },
  },
  async ({ session_id, preset }) => {
    const page = getSessionPage(session_id);
    await actions.setResumeFit(page, preset);
    const summary = await actions.getResumeSummary(page);
    return {
      content: [
        {
          type: "text",
          text: `Resume Fit set to ${preset}. Overflows one page: ${summary.overflowsOnePage}.`,
        },
      ],
    };
  }
);

server.registerTool(
  "set_page_size",
  {
    title: "Set paper size",
    description: "Switches the export/print paper size between US Letter and A4.",
    inputSchema: { session_id: sessionIdField, size: z.enum(["letter", "a4"]) },
  },
  async ({ session_id, size }) => {
    const page = getSessionPage(session_id);
    await actions.setPageSize(page, size);
    return { content: [{ type: "text", text: `Paper size set to ${size}.` }] };
  }
);

// ===== READ-ONLY CHECKS =====

server.registerTool(
  "check_ats_match",
  {
    title: "Check ATS keyword match against a job posting",
    description:
      "Runs the site's own client-side ATS keyword matcher: extracts likely keywords from a " +
      "pasted job description and reports which ones already appear on the resume. This is a " +
      "keyword match, not a judgment of quality or fit.",
    inputSchema: {
      session_id: sessionIdField,
      job_description: z.string().min(1).describe("The full text of the job posting to check against."),
    },
  },
  async ({ session_id, job_description }) => {
    const page = getSessionPage(session_id);
    const result = await actions.checkAtsMatch(page, job_description);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "get_resume_preview",
  {
    title: "Get the current resume's content and a screenshot",
    description:
      "Returns a structured summary (name, counts, whether it overflows one page, etc.), the " +
      "full resume as plain text, and — optionally — a PNG screenshot of just the resume " +
      "(not the editor UI). Use this to verify progress before exporting.",
    inputSchema: {
      session_id: sessionIdField,
      include_screenshot: z.boolean().default(false).describe("Set true to also get a base64 PNG screenshot."),
    },
  },
  async ({ session_id, include_screenshot }) => {
    const page = getSessionPage(session_id);
    const [summary, text] = await Promise.all([actions.getResumeSummary(page), actions.getResumeText(page)]);
    const content: any[] = [
      { type: "text", text: `${JSON.stringify(summary, null, 2)}\n\n--- Resume text ---\n${text}` },
    ];
    if (include_screenshot) {
      const base64 = await actions.getResumeScreenshot(page);
      content.push({ type: "image", data: base64, mimeType: "image/png" });
    }
    return { content };
  }
);

// ===== EXPORT =====

server.registerTool(
  "export_resume_pdf",
  {
    title: "Export the resume as a PDF",
    description:
      "Renders the resume through Chromium's real print engine (the same one behind the " +
      "site's own Print/Export PDF buttons) and returns it as a PDF file. Warns in the " +
      "response text if the resume currently overflows one page, but exports anyway.",
    inputSchema: { session_id: sessionIdField },
  },
  async ({ session_id }) => {
    const page = getSessionPage(session_id);
    const [summary, base64] = await Promise.all([actions.getResumeSummary(page), actions.exportPdf(page)]);
    const filename = `${(summary.name || "resume").trim().replace(/\s+/g, "_")}_Resume.pdf`;
    const warning = summary.overflowsOnePage
      ? "⚠ This resume is longer than one page and may print across 2 pages.\n\n"
      : "";
    return {
      content: [
        { type: "text", text: `${warning}Exported ${filename}.` },
        { type: "resource", resource: { uri: filename, mimeType: "application/pdf", blob: base64 } },
      ],
    };
  }
);

server.registerTool(
  "export_resume_word",
  {
    title: "Export the resume as a Word document",
    description:
      "Triggers the site's own Word export and returns the resulting .doc file. Requires a " +
      "name to already be set (call set_personal_info first).",
    inputSchema: { session_id: sessionIdField },
  },
  async ({ session_id }) => {
    const page = getSessionPage(session_id);
    const { filename, base64 } = await actions.exportWord(page);
    return {
      content: [
        { type: "text", text: `Exported ${filename}.` },
        {
          type: "resource",
          resource: { uri: filename, mimeType: "application/msword", blob: base64 },
        },
      ],
    };
  }
);

server.registerTool(
  "start_new_resume",
  {
    title: "Reset the session to a fresh resume",
    description:
      "Wipes everything in the current session (name, contact info, education, all jobs) and " +
      "reloads a fresh template — for building a second student's resume in the same session " +
      "without starting a whole new browser session. Equivalent to the site's 'New Resume' " +
      "button (skips its confirmation prompt, since there's no human to click it here).",
    inputSchema: { session_id: sessionIdField, program: z.enum(["hvac", "plumbing"]) },
  },
  async ({ session_id, program }) => {
    const page = getSessionPage(session_id);
    await actions.startNewResume(page, program);
    return { content: [{ type: "text", text: `Session ${session_id} reset with a fresh ${program.toUpperCase()} template.` }] };
  }
);

// ===== HTTP WIRING =====

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", site: SITE_URL, activeSessions: listSessionIds().length });
});

// Stateless Streamable HTTP: a fresh transport per request. This server's own "sessions"
// (browser tabs, tracked by session_id) are an application-level concept threaded through
// tool arguments — they're independent of the MCP transport's own request/response cycle.
app.post("/mcp", requireAuth, async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

const PORT = parseInt(process.env.PORT || "3000", 10);
const httpServer = app.listen(PORT, () => {
  console.log(`GUTTS Resume Builder MCP server listening on :${PORT}, driving ${SITE_URL}`);
});

async function shutdown() {
  console.log("Shutting down...");
  httpServer.close();
  await shutdownBrowser();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
