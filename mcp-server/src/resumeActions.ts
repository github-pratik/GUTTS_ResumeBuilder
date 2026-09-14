import type { Page } from "playwright";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * This whole module drives the LIVE site (not a reimplementation of it) by calling straight
 * into the page's own already-correct global functions (loadTemplate, addJob, applyPreset,
 * runImportResume, etc.) via page.evaluate(). That keeps this server thin and means every
 * business rule — merge caps, GUTTS-owned contact defaults, common-vs-dynamic template
 * fields — stays defined in exactly one place: the site itself.
 */

export interface EducationEntry {
  degree?: string;
  school?: string;
  city?: string;
  year?: string;
}

export interface JobBulletsInput {
  title: string;
  company?: string;
  location?: string;
  date?: string;
  bullets?: string[];
}

/** Program must already be loaded (start_resume does this) before any of these run. */

export async function setPersonalInfo(
  page: Page,
  fields: { name?: string; city?: string; state?: string; graduationDate?: string }
) {
  await page.evaluate((f) => {
    const set = (id: string, val?: string) => {
      if (val === undefined) return;
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.value = val;
    };
    set("f-name", f.name);
    set("f-city", f.city);
    set("f-state", f.state);
    set("f-grad-date", f.graduationDate);
    // @ts-expect-error - render() is a global defined by the page's own script
    render();
  }, fields);
}

export async function setEducation(page: Page, entries: EducationEntry[]) {
  await page.evaluate((entries) => {
    // @ts-expect-error - state/renderEducation/render are page globals
    state.education = entries.map((e: EducationEntry, i: number) => ({
      id: Date.now() + i,
      degree: e.degree || "",
      school: e.school || "",
      city: e.city || "",
      year: e.year || "",
    }));
    // @ts-expect-error
    renderEducation();
    // @ts-expect-error
    render();
  }, entries);
}

export async function addJob(page: Page, job: JobBulletsInput) {
  await page.evaluate((job) => {
    // @ts-expect-error - page globals
    addJob();
    // @ts-expect-error
    const j = state.jobs[state.jobs.length - 1];
    // @ts-expect-error
    updateJob(j.id, "title", job.title || "");
    // @ts-expect-error
    updateJob(j.id, "company", job.company || "");
    // @ts-expect-error
    updateJob(j.id, "location", job.location || "");
    // @ts-expect-error
    updateJob(j.id, "date", job.date || "");
    const bullets: string[] = job.bullets && job.bullets.length ? job.bullets : [];
    bullets.forEach((b, i) => {
      // @ts-expect-error
      if (i > 0) addBullet(j.id);
      // @ts-expect-error
      updateBullet(j.id, i, b);
    });
  }, job);
}

export async function addSkills(page: Page, technical?: string[], soft?: string[]) {
  await page.evaluate(
    ({ technical, soft }) => {
      // @ts-expect-error - page globals (importMergeSkills already handles dedupe + MAX_SKILLS cap)
      if (technical?.length) state.techSkills = importMergeSkills(state.techSkills, technical);
      // @ts-expect-error
      if (soft?.length) state.softSkills = importMergeSkills(state.softSkills, soft);
      // @ts-expect-error
      renderTags("tech");
      // @ts-expect-error
      renderTags("soft");
      // @ts-expect-error
      render();
    },
    { technical, soft }
  );
}

export async function setRelevantInfo(page: Page, items: string[]) {
  await page.evaluate((items) => {
    // @ts-expect-error - page globals
    state.info = items.slice(0, 10);
    // @ts-expect-error
    renderTags("info");
    // @ts-expect-error
    render();
  }, items);
}

export async function loadTemplate(page: Page, program: "hvac" | "plumbing") {
  await page.evaluate((program) => {
    // @ts-expect-error - page global
    loadTemplate(program);
  }, program);
}

export async function setResumeFit(
  page: Page,
  preset: "compact" | "normal" | "roomy" | "spacious"
) {
  await page.evaluate((preset) => {
    // @ts-expect-error - page global
    applyPreset(preset);
  }, preset);
}

export async function setPageSize(page: Page, size: "letter" | "a4") {
  await page.evaluate((size) => {
    // @ts-expect-error - page global
    setPageSize(size, true);
  }, size);
}

/** Uses the site's own Import Resume feature (its heuristic parser), not a reimplementation. */
export async function importResumeText(page: Page, text: string, exactMode: boolean) {
  return page.evaluate(
    ({ text, exactMode }) => {
      const textarea = document.getElementById("import-text-input") as HTMLTextAreaElement;
      const checkbox = document.getElementById("import-exact-mode") as HTMLInputElement;
      textarea.value = text;
      checkbox.checked = exactMode;
      // @ts-expect-error - page global
      runImportResume();
      const resultsEl = document.getElementById("import-results");
      return resultsEl ? resultsEl.innerText.trim() : "";
    },
    { text, exactMode }
  );
}

export interface AtsCheckResult {
  scorePercent: number | null;
  matched: string[];
  missing: string[];
}

export async function checkAtsMatch(page: Page, jobDescription: string): Promise<AtsCheckResult> {
  return page.evaluate((jobDescription) => {
    const input = document.getElementById("ats-jd-input") as HTMLTextAreaElement;
    input.value = jobDescription;
    // @ts-expect-error - page global
    runATSCheck();
    // @ts-expect-error
    const keywords: string[] = atsLastKeywords || [];
    const resultsEl = document.getElementById("ats-results");
    const text = resultsEl?.innerText || "";
    const scoreMatch = text.match(/(\d+)%/);
    const matched = Array.from(
      resultsEl?.querySelectorAll(".ats-chip-match") || []
    ).map((el) => (el as HTMLElement).innerText.replace(/^✓\s*/, ""));
    const missing = Array.from(
      resultsEl?.querySelectorAll(".ats-chip-missing") || []
    ).map((el) => (el as HTMLElement).innerText.replace(/\+$/, "").trim());
    return {
      scorePercent: scoreMatch ? parseInt(scoreMatch[1], 10) : null,
      matched,
      missing,
    };
  }, jobDescription);
}

export interface ResumeSummary {
  name: string;
  program: string;
  city: string;
  state: string;
  phone: string;
  email: string;
  graduationDate: string;
  educationCount: number;
  technicalSkillsCount: number;
  softSkillsCount: number;
  certificationsCount: number;
  relevantInfoCount: number;
  jobCount: number;
  jobTitles: string[];
  overflowsOnePage: boolean;
  resumeFit: string;
  pageSize: string;
}

export async function getResumeSummary(page: Page): Promise<ResumeSummary> {
  return page.evaluate(() => {
    const g = (id: string) => (document.getElementById(id) as HTMLInputElement)?.value || "";
    return {
      name: g("f-name"),
      // @ts-expect-error - page globals
      program: state.program,
      city: g("f-city"),
      state: g("f-state"),
      phone: g("f-phone"),
      email: g("f-email"),
      graduationDate: g("f-grad-date"),
      // @ts-expect-error
      educationCount: state.education.length,
      // @ts-expect-error
      technicalSkillsCount: state.techSkills.length,
      // @ts-expect-error
      softSkillsCount: state.softSkills.length,
      // @ts-expect-error
      certificationsCount: state.certs.length,
      // @ts-expect-error
      relevantInfoCount: state.info.length,
      // @ts-expect-error
      jobCount: state.jobs.length,
      // @ts-expect-error
      jobTitles: state.jobs.map((j: any) => j.title || "(untitled)"),
      // @ts-expect-error
      overflowsOnePage: isResumeOverflowing(),
      // @ts-expect-error
      resumeFit: currentPreset,
      // @ts-expect-error
      pageSize: state.pageSize,
    };
  });
}

/** Full plain-text rendering of the resume, exactly as it will print. */
export async function getResumeText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.getElementById("resume-output");
    return el ? (el as HTMLElement).innerText : "";
  });
}

/** A PNG screenshot of just the resume paper (not the whole editor UI), base64-encoded. */
export async function getResumeScreenshot(page: Page): Promise<string> {
  const locator = page.locator("#resume-output");
  const buffer = await locator.screenshot({ type: "png" });
  return buffer.toString("base64");
}

/**
 * Renders the resume to PDF via Chromium's real print engine (same one behind the site's
 * own "Print"/"Export PDF" buttons) — NOT by clicking those buttons, since that opens a
 * native OS dialog Playwright can't drive. preferCSSPageSize lets the page's own
 * `@page { size: ...; margin: 0 }` (set dynamically by the site's Letter/A4 toggle) win.
 */
export async function exportPdf(page: Page): Promise<string> {
  const buffer = await page.pdf({ printBackground: true, preferCSSPageSize: true });
  return buffer.toString("base64");
}

/** Triggers the site's own exportWord() and captures the resulting .doc download. */
export async function exportWord(page: Page): Promise<{ filename: string; base64: string }> {
  const name = await page.evaluate(
    () => (document.getElementById("f-name") as HTMLInputElement)?.value || ""
  );
  if (!name.trim()) {
    throw new Error(
      "Cannot export — the resume has no name set yet. Call set_personal_info with a name first."
    );
  }

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 15000 }),
    page.evaluate(() => {
      // @ts-expect-error - page global
      exportWord();
    }),
  ]);

  const tmpPath = path.join(os.tmpdir(), `gutts-resume-${Date.now()}.doc`);
  await download.saveAs(tmpPath);
  const buffer = await fs.readFile(tmpPath);
  await fs.unlink(tmpPath).catch(() => {});
  return { filename: download.suggestedFilename(), base64: buffer.toString("base64") };
}

/** Wipes the current draft and starts fresh — mirrors the site's own "New Resume" button,
 *  but skips its confirm() dialog since there's no human here to click it. */
export async function startNewResume(page: Page, program: "hvac" | "plumbing") {
  await page.evaluate((program) => {
    // @ts-expect-error - page globals: replicate startNewResume() minus the confirm() dialog
    clearDraft();
    ["f-name", "f-phone", "f-email", "f-city", "f-state", "f-grad-date"].forEach((id) => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.value = "";
    });
    // @ts-expect-error
    state.education = [];
    // @ts-expect-error
    state.jobs = [];
    // @ts-expect-error
    state.customSections = [];
    // @ts-expect-error
    loadTemplate(program);
    // @ts-expect-error
    applyPreset("normal");
    // @ts-expect-error
    setPageSize("letter", true);
  }, program);
}
