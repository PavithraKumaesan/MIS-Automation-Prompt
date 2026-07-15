/**
 * Test case 10 — Audit Logs.
 *
 * Runs after Reports (test case 9, scripts/ecampusReports.ts) on the same
 * logged-in page, per spec: "Do not end the automation... Continue with the
 * Audit Logs module."
 *
 * Per the spec's closing "Important" section — "Do not stop or fail the
 * automation if any validation fails... Continue executing the remaining
 * test cases using the same browser session" — EVERY step here is
 * non-fatal (wrapped in tryStep()), including the initial "Audit Logs" nav
 * click, matching the same convention already used in
 * scripts/ecampusReports.ts for the same reason.
 *
 * NOTE: this page (Search Activity section — Table field, Search icon,
 * Export CSV, results columns) has no existing precedent anywhere else in
 * this project — every selector below is a best-effort starting-point
 * guess based on the text given in the spec. Expect to need live-DOM-driven
 * fixes, same as every other module in this project.
 *
 * Run with:
 *   npm run audit-logs:ecampus
 * or:
 *   npx tsx scripts/ecampusAuditLogs.ts
 */

import { chromium, Page } from 'playwright';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { loginToEcampus, safeWaitForURL } from './ecampusSession';

dotenv.config();

const REPORT_ENV_PATH = path.resolve('Report_AuditLogs.env');
const DEFAULT_TIMEOUT = 20000;
const TABLE_SEARCH_VALUE = '17569';

/** Appends a timestamped alert line to Report_AuditLogs.env — never throws, so a logging failure can't itself break the run. */
function appendReportAlert(message: string) {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(REPORT_ENV_PATH, line);
  } catch (err) {
    console.error(`Failed to write alert to ${REPORT_ENV_PATH}: ${(err as Error).message}`);
  }
}

/**
 * Runs `action`; on any failure, logs `failureAlert` (console + Report_AuditLogs.env)
 * and swallows the error, so the caller always continues to the next step —
 * per this module's "never stop on a validation failure" instruction.
 */
async function tryStep(action: () => Promise<void>, failureAlert: string): Promise<void> {
  try {
    await action();
  } catch (err) {
    console.warn(`⚠️ ${failureAlert} (${(err as Error).message})`);
    appendReportAlert(failureAlert);
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches any element whose text CONTAINS `text` (case-insensitive, not
 * anchored) — deliberately not exact/anchored, since anchored exact-text
 * matches have repeatedly broken elsewhere in this project when the real
 * element also contains an icon or extra whitespace alongside the label.
 */
function clickableText(page: Page, text: string) {
  return page.getByText(new RegExp(escapeRegExp(text), 'i')).first();
}

/** Matches an input by name/id/placeholder substring hints — same convention proven reliable in scripts/ecampusInternalAccounts.ts. */
function fieldByAttributeHints(page: Page, hints: string[]) {
  const selectorParts = hints.flatMap((hint) => [
    `input[name*="${hint}" i]`,
    `input[id*="${hint}" i]`,
    `input[placeholder*="${hint}" i]`,
  ]);
  return page.locator(selectorParts.join(', ')).first();
}

/**
 * Locates the Search icon/button near the Table field in the Search
 * Activity section. NOTE: best-effort guess (Bootstrap icon class naming
 * convention already confirmed elsewhere in this project, e.g. bi-download/
 * bi-trash/bi-arrow-right) — adjust once the real markup is inspected.
 */
function searchIconButton(page: Page) {
  return page
    .locator('button:has(i[class*="search"]), a:has(i[class*="search"])')
    .first();
}

/**
 * Verifies every text in `expectedTexts` is visible somewhere on the page;
 * throws (for tryStep to catch) if any are missing. Case-insensitive —
 * column labels are quite likely rendered all-caps via CSS text-transform,
 * the same issue already hit and fixed for the "ACTIONS" column header in
 * scripts/ecampusTrialBalanceRevisit.ts and the Budget Allocation Records
 * columns in scripts/ecampusBudget.ts.
 */
async function verifyAllVisible(page: Page, expectedTexts: string[]): Promise<void> {
  const missing: string[] = [];
  for (const text of expectedTexts) {
    const isVisible = await page.getByText(new RegExp(escapeRegExp(text), 'i')).first().isVisible().catch(() => false);
    if (!isVisible) missing.push(text);
  }
  if (missing.length > 0) {
    throw new Error(`Missing: ${missing.join(', ')}`);
  }
}

/**
 * Runs the Audit Logs workflow on an already-logged-in page (i.e. after
 * loginToEcampus() has resolved, and typically after runReports() in a
 * continuous session). Resets Report_AuditLogs.env itself, so this is safe
 * to call standalone or as a step in scripts/runAllEcampus.ts.
 */
export async function runAuditLogs(page: Page): Promise<void> {
  // Reset Report_AuditLogs.env at the start of every run, so it reflects
  // only this run's alerts instead of growing forever across repeated runs.
  fs.writeFileSync(REPORT_ENV_PATH, '');

  // Same "rail-link" / href-based selector already proven reliable for the
  // other left-nav links in this project.
  const auditLogsNavLink = page.locator('a.rail-link[href$="/m-audit-logs"]').first();

  await tryStep(async () => {
    await auditLogsNavLink.click();
    await safeWaitForURL(page, /\/m-audit-logs$/, 'audit logs page', DEFAULT_TIMEOUT);
  }, 'Audit Logs URL is not loaded.');

  // -------------------------------------------------------------------
  // Search Activity — Table field + Search icon
  // -------------------------------------------------------------------
  await tryStep(async () => {
    const tableField = fieldByAttributeHints(page, ['table']);
    await tableField.click();
    await tableField.fill(TABLE_SEARCH_VALUE);
  }, 'Could not enter the Table search value in the Search Activity section.');

  await tryStep(
    () => searchIconButton(page).click(),
    'Could not click the Search icon in the Search Activity section.'
  );

  // -------------------------------------------------------------------
  // Export CSV
  // -------------------------------------------------------------------
  await tryStep(async () => {
    const exportButton = clickableText(page, 'Export CSV');
    const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
    const ext = path.extname(download.suggestedFilename()) || '.csv';
    const downloadPath = path.resolve('reports', `downloaded_audit_logs${ext}`);
    await download.saveAs(downloadPath);
  }, 'Audit Logs CSV file is not downloading.');

  // -------------------------------------------------------------------
  // Verify search results columns
  // -------------------------------------------------------------------
  await tryStep(
    () =>
      verifyAllVisible(page, [
        'TIMESTAMP',
        'USER',
        'ACTION',
        'MODULE / TABLE',
        'RECORD ID',
        'IP ADDRESS',
        'ACTIONS',
      ]),
    'Search filter is not working. No data is displayed under TIMESTAMP, USER, ACTION, MODULE / TABLE, RECORD ID, IP ADDRESS, and ACTIONS.'
  );

  console.log('\n✅ Audit Logs workflow completed.');
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

async function main() {
  // headless: false so the captcha is visible and solvable by hand.
  // slowMo delays each Playwright action so the run is easy to follow visually.
  const browser = await chromium.launch({ headless: false, slowMo: 1000 });

  try {
    const page = await browser.newPage();
    await loginToEcampus(page, appendReportAlert);
    await runAuditLogs(page);
    await browser.close();
  } finally {
    if (browser.isConnected()) {
      await browser.close();
    }
  }
}

// Only auto-run when this file is executed directly — NOT when runAuditLogs
// is imported by scripts/runAllEcampus.ts, which would otherwise launch an
// extra, unwanted browser window per import.
if (require.main === module) {
  main().catch((err) => {
    console.error('Audit Logs workflow failed:', err);
    process.exit(1);
  });
}
