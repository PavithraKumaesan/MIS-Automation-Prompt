/**
 * Test case 6 — Trial Balance revisit.
 *
 * Runs after Internal Accounts (test case 5, scripts/ecampusInternalAccounts.ts)
 * on the same logged-in page. Originally described in the same spec as
 * Internal Accounts, but split out into its own test case per later
 * instruction: Internal Accounts is test case 5, this is test case 6, run in
 * that order.
 *
 * Navigates back to Trial Balance and checks, in order: the Actions column's
 * Download icon, the Delete icon, the All Ledger Records section, and
 * (after scrolling back up) the "Upload New Data" button. Every check here
 * is an independent, non-fatal validation — on failure it logs the exact
 * alert message from the spec to Report_TB_Revisit.env (kept separate from
 * Report_TB.env, which belongs to test case 3's initial Trial Balance
 * upload, so the two don't overwrite each other) and continues.
 *
 * NOTE: this page's Actions column (Download/Delete icons) and the "Upload
 * New Data" button have no existing precedent anywhere else in this
 * project — every selector below is a best-effort starting-point guess.
 *
 * Run with:
 *   npm run tb-revisit:ecampus
 * or:
 *   npx tsx scripts/ecampusTrialBalanceRevisit.ts
 */

import { chromium, Page } from 'playwright';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { loginToEcampus, safeWaitForURL } from './ecampusSession';

dotenv.config();

const REPORT_ENV_PATH = path.resolve('Report_TB_Revisit.env');
const DEFAULT_TIMEOUT = 20000;

/** Appends a timestamped alert line to Report_TB_Revisit.env — never throws, so a logging failure can't itself break the run. */
function appendReportAlert(message: string) {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(REPORT_ENV_PATH, line);
  } catch (err) {
    console.error(`Failed to write alert to ${REPORT_ENV_PATH}: ${(err as Error).message}`);
  }
}

/**
 * Runs `action`; on any failure, logs `failureAlert` (console + Report_TB_Revisit.env)
 * and swallows the error, so the caller always continues to the next step.
 */
async function tryStep(action: () => Promise<void>, failureAlert: string): Promise<void> {
  try {
    await action();
  } catch (err) {
    console.warn(`⚠️ ${failureAlert} (${(err as Error).message})`);
    appendReportAlert(failureAlert);
  }
}

/**
 * Runs the Trial Balance revisit workflow on an already-logged-in page (i.e.
 * after loginToEcampus() has resolved, and typically after
 * runInternalAccounts() in a continuous session). Resets Report_TB_Revisit.env
 * itself, so this is safe to call standalone or as a step in
 * scripts/runAllEcampus.ts.
 */
export async function runTrialBalanceRevisit(page: Page): Promise<void> {
  // Reset Report_TB_Revisit.env at the start of every run, so it reflects
  // only this run's alerts instead of growing forever across repeated runs.
  fs.writeFileSync(REPORT_ENV_PATH, '');

  // Same "rail-link" / href-based selector already proven reliable for the
  // "Upload" nav link in the other scripts, applied here to "Trial Balance"
  // — avoids matching by accessible name/text entirely, which failed here
  // with exact: true (likely a leading space or icon in the real link's
  // text, the same root cause behind the earlier "Upload" selector bug).
  // No fallback alert was specified for this click, so it's treated as a
  // real/structural failure (throws), consistent with primary nav elsewhere.
  const trialBalanceNavLink = page.locator('a.rail-link[href$="/m-trial_balance"]').first();
  await trialBalanceNavLink.click();
  await safeWaitForURL(page, /\/m-trial_balance/, 'trial balance page');

  // Wait for the Actions column header to actually be visible before
  // interacting with its icons — the table may still be loading right after
  // navigation, which could otherwise cause the Download/Delete lookups
  // below to race ahead of the real content. Case-insensitive match: the
  // page likely renders this as all-caps via CSS text-transform, which
  // doesn't change the actual DOM text content, so an exact "ACTIONS" match
  // failed.
  await page.getByText(/actions/i).first().waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });

  // Confirmed real markup: <a href=".../trial_balance/download/9"
  // class="btn btn-sm" title="Download"><i class="bi bi-download"></i></a>
  // — matched directly on the href's distinctive path, which is far less
  // likely to collide with anything else on the page than a generic
  // class/title guess.
  await tryStep(async () => {
    const downloadIcon = page.locator('a[href*="/trial_balance/download/"]').first();
    const [download] = await Promise.all([page.waitForEvent('download'), downloadIcon.click()]);
    const ext = path.extname(download.suggestedFilename()) || '.csv';
    await download.saveAs(path.resolve('reports', `downloaded_tb_actions${ext}`));
  }, 'Download icon is not working.');

  // Confirmed real markup: <button class="btn btn-sm text-neg" title="Delete"
  // onclick="deleteTrialBalance('9', 'FY-2025')"><i class="bi bi-trash"></i></button>
  // — matched directly on the onclick handler's function name.
  //
  // Clicking it opens a custom in-page confirmation modal (NOT a native
  // browser confirm() dialog — confirmed via screenshot), warning that this
  // deletes ALL trial balance records for the given fiscal year and cannot
  // be undone. Per explicit confirmation, this automation clicks "Confirm"
  // and proceeds with the deletion every run.
  await tryStep(async () => {
    const deleteIcon = page.locator('button[onclick*="deleteTrialBalance"]').first();
    await deleteIcon.click();

    const confirmButton = page.getByRole('button', { name: 'Confirm', exact: true });
    await confirmButton.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
    await confirmButton.click();

    // NOTE: no specific "deleted successfully" signal was given — assumes a
    // confirmation toast may appear; adjust once the real UX is known.
    await page.getByText(/deleted/i).first().waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
  }, 'Delete icon is not working.');

  await tryStep(async () => {
    const allLedgerRecordsSection = page.getByText('All Ledger Records', { exact: false }).first();
    await allLedgerRecordsSection.scrollIntoViewIfNeeded();
    await allLedgerRecordsSection.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
  }, 'All Ledger Records section is not visible.');

  // Scroll back up (the All Ledger Records check above may have scrolled
  // down) before clicking Upload New Data, which sits higher on the page.
  await tryStep(async () => {
    await page.evaluate(() => window.scrollTo(0, 0));

    const uploadNewDataButton = page.locator('a.btn-primary[href*="tab=tb"]').first();
    await uploadNewDataButton.click();
    // Confirmed expected URL (differs from the m-trial_balance page we were
    // already on): the button navigates to the upload page with a "tb" tab.
    await safeWaitForURL(page, /\/m-upload\?tab=tb/, 'upload new data page');
  }, 'Upload New Data button is not working.');

  console.log('\n✅ Trial Balance revisit workflow completed.');
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
    await runTrialBalanceRevisit(page);
    await browser.close();
  } finally {
    if (browser.isConnected()) {
      await browser.close();
    }
  }
}

// Only auto-run when this file is executed directly — NOT when
// runTrialBalanceRevisit is imported by scripts/runAllEcampus.ts, which
// would otherwise launch an extra, unwanted browser window per import.
if (require.main === module) {
  main().catch((err) => {
    console.error('Trial Balance revisit workflow failed:', err);
    process.exit(1);
  });
}
