/**
 * Test case 8 — Financial Year.
 *
 * Runs after Budget (test case 7, scripts/ecampusBudget.ts) on the same
 * logged-in page.
 *
 * Spec so far only covers navigation:
 *   1. Click "Financial Year" from the left sidebar navigation.
 *   2. Wait for the URL to become
 *      https://forms.ecampusbuddy.com/index.php/m-financial_year.
 *
 * No fallback alert was specified for this click, so — consistent with the
 * other primary nav-type clicks in this project ("Budget" itself, "Detailed
 * Listing" inside Budget) — it's treated as a real/structural failure that
 * throws, rather than a non-fatal tryStep().
 *
 * Run with:
 *   npm run financial-year:ecampus
 * or:
 *   npx tsx scripts/ecampusFinancialYear.ts
 */

import { chromium, Page } from 'playwright';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { loginToEcampus, safeWaitForURL } from './ecampusSession';

dotenv.config();

const REPORT_ENV_PATH = path.resolve('Report_FinancialYear.env');

/** Appends a timestamped alert line to Report_FinancialYear.env — never throws, so a logging failure can't itself break the run. */
function appendReportAlert(message: string) {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(REPORT_ENV_PATH, line);
  } catch (err) {
    console.error(`Failed to write alert to ${REPORT_ENV_PATH}: ${(err as Error).message}`);
  }
}

/**
 * Runs the Financial Year workflow on an already-logged-in page (i.e. after
 * loginToEcampus() has resolved, and typically after runBudget() in a
 * continuous session). Resets Report_FinancialYear.env itself, so this is
 * safe to call standalone or as a step in scripts/runAllEcampus.ts.
 */
export async function runFinancialYear(page: Page): Promise<void> {
  // Reset Report_FinancialYear.env at the start of every run, so it reflects
  // only this run's alerts instead of growing forever across repeated runs.
  fs.writeFileSync(REPORT_ENV_PATH, '');

  // Same "rail-link" / href-based selector already proven reliable for the
  // other left-nav links in this project — avoids matching by accessible
  // name/text, which has repeatedly turned out to be unreliable on this
  // app's left-nav (leading spaces/icons in the real text).
  const financialYearNavLink = page.locator('a.rail-link[href$="/m-financial_year"]').first();
  await financialYearNavLink.click();
  await safeWaitForURL(page, /\/m-financial_year$/, 'financial year page');

  console.log('\n✅ Financial Year workflow completed.');
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
    await runFinancialYear(page);
    await browser.close();
  } finally {
    if (browser.isConnected()) {
      await browser.close();
    }
  }
}

// Only auto-run when this file is executed directly — NOT when
// runFinancialYear is imported by scripts/runAllEcampus.ts, which would
// otherwise launch an extra, unwanted browser window per import.
if (require.main === module) {
  main().catch((err) => {
    console.error('Financial Year workflow failed:', err);
    process.exit(1);
  });
}
