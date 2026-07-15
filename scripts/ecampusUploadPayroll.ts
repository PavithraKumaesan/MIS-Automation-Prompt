/**
 * Test case 4 — Upload Payroll.
 *
 * Standalone login + Payroll upload workflow for
 * https://forms.ecampusbuddy.com/index.php/m-welcome.
 *
 * NOTE: the spec named the upload file "PAYROOL_1.csv", but upload_files/
 * only contains "PAYROOL_1.xlsx" (same spelling, different extension) — this
 * script uses the file that actually exists. Confirm that's the right one.
 *
 * NOTE: the spec's Created At alert says to write to "Report_tb.env" — that's
 * the Trial Balance script's report file. The upload-timing alert similarly
 * says "Report.payroll.env" (dot, not underscore). Standardized here on
 * Report_payroll.env for everything, since the rest of this same spec
 * explicitly names that file (underscore form) for the other alerts.
 *
 * This is NOT a Playwright test (no @playwright/test runner) — it's a plain
 * script run directly with tsx so it can pause on real terminal input while
 * you solve the captcha by hand in the visible browser window.
 *
 * Run with:
 *   npm run upload-payroll:ecampus
 * or:
 *   npx tsx scripts/ecampusUploadPayroll.ts
 *
 * Credentials come from ECAMPUS_USERNAME / ECAMPUS_PASSWORD in .env (loaded
 * via dotenv). Nothing is hardcoded here.
 *
 * Soft, non-fatal checks (log to Report_payroll.env, never throw or stop the
 * script):
 *  - Upload timing (click -> landing on batches page): alert if > 1 minute.
 *  - Created At date on the visible Transaction Batches data: alert if it
 *    doesn't match today's date.
 */

import { chromium, Page } from 'playwright';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { loginToEcampus, safeWaitForURL } from './ecampusSession';

dotenv.config();

const UPLOAD_FILE_PATH = path.resolve('upload_files', 'PAYROOL_1.xlsx');
const REPORT_ENV_PATH = path.resolve('Report_payroll.env');

const DEFAULT_TIMEOUT = 20000;

// ---------------------------------------------------------------------------
// Report helpers
// ---------------------------------------------------------------------------

/** Appends a timestamped alert line to Report_payroll.env — never throws, so a logging failure can't itself break the run. */
function appendReportAlert(message: string) {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(REPORT_ENV_PATH, line);
  } catch (err) {
    console.error(`Failed to write alert to ${REPORT_ENV_PATH}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Main workflow
// ---------------------------------------------------------------------------

/**
 * Runs the Payroll upload workflow on an already-logged-in page (i.e. after
 * loginToEcampus() has resolved). Resets Report_payroll.env itself, so this
 * is safe to call standalone or as one step in a continuous multi-workflow
 * session (see scripts/runAllEcampus.ts) — in the latter case, `page` may
 * currently be on any prior workflow's end page rather than the dashboard;
 * the "Upload" nav link below is expected to be present in the persistent
 * left-side navigation regardless.
 */
export async function runUploadPayroll(page: Page): Promise<void> {
  // Reset Report_payroll.env at the start of every run, so it reflects only
  // this run's alerts instead of growing forever across repeated runs.
  fs.writeFileSync(REPORT_ENV_PATH, '');

  if (!fs.existsSync(UPLOAD_FILE_PATH)) {
    throw new Error(`Upload file not found at ${UPLOAD_FILE_PATH}`);
  }

  {
    // -------------------------------------------------------------------
    // Dashboard -> Upload
    // -------------------------------------------------------------------
    // Scoped to the left-nav's actual markup (class "rail-link", href ending
    // exactly in "/m-upload") rather than matching by accessible name/text —
    // a page-specific "Upload New Data" button (class "btn btn-sm
    // btn-primary", href ".../m-upload?tab=tb", seen on the Trial Balance
    // page) also has "Upload" in its name/text, which is exactly what broke
    // this step when Payroll's turn started right after Trial Balance in a
    // continuous session.
    const uploadLink = page.locator('a.rail-link[href$="/m-upload"]').first();
    await uploadLink.click();
    await safeWaitForURL(page, /\/m-upload/, 'upload page');

    // Switch to the Payroll upload section (sits next to "Upload Trial
    // Balance"), mirroring the toggle pattern used in
    // scripts/ecampusUploadVCC.ts / scripts/ecampusUploadTrialBalance.ts.
    // NOTE: starting-point selector — inspect the real page and adjust if
    // this isn't a plain text link/tab.
    const uploadPayrollToggle = page.getByText('Upload Payroll', { exact: true });
    await uploadPayrollToggle.click();

    // Playwright's setInputFiles() sets the file directly on the <input
    // type="file">, so there's no need to click a "Choose File" button first
    // (that button just opens the native OS file dialog, which Playwright
    // bypasses). NOTE: this id is an unverified guess following the existing
    // po_file_input / vcc_file_input naming convention in
    // pages/mis_loginpage.ts — inspect the real page and adjust if it
    // differs, and if there are multiple file inputs in the DOM at once,
    // prefer a specific id over a generic input[type="file"] to avoid
    // grabbing the wrong one.
    const payrollFileInput = page.locator('#payroll_file_input');
    await payrollFileInput.waitFor({ state: 'attached', timeout: DEFAULT_TIMEOUT });
    await payrollFileInput.setInputFiles(UPLOAD_FILE_PATH);

    const uploadSubmitButton = page.getByRole('button', { name: 'Upload' });
    const fileUploadStart = Date.now();
    await uploadSubmitButton.click();

    // -------------------------------------------------------------------
    // Batches
    // -------------------------------------------------------------------
    // No separate "Batches" nav click here — the upload itself navigates
    // straight to m-batches, same as the PO/VCC scripts.
    await safeWaitForURL(page, /\/m-batches/, 'batches page');

    // Record the total upload duration — from the Upload click until landing
    // on the batches page — and always store it in Report_payroll.env,
    // regardless of how long it took.
    const fileUploadDurationMs = Date.now() - fileUploadStart;
    appendReportAlert(`Payroll upload duration: ${fileUploadDurationMs}ms`);

    // Soft, non-fatal timing check: additionally alert if the upload took
    // more than 1 minute. Never marks the automation as failed or stops
    // execution.
    if (fileUploadDurationMs > 60000) {
      const alertMessage = 'Uploading payroll time is taking more than 1 minutes.';
      console.warn(`⚠️ ${alertMessage} (${fileUploadDurationMs}ms)`);
      appendReportAlert(alertMessage);
    }

    // Switch to the Payroll side of this page (sits near "VCC"), mirroring
    // the "VCC Transactions" toggle pattern used in scripts/ecampusUploadVCC.ts.
    // NOTE: starting-point selector — inspect the real page and adjust if
    // this isn't a plain text link/tab.
    const payrollBatchesToggle = page.getByText('Payroll', { exact: true });
    await payrollBatchesToggle.click();

    // Verify the Created At date matches today's date — non-fatal on
    // mismatch or on failing to read it at all. NOTE: starting-point
    // selector — inspect the real page for the actual "Created At"
    // field/column within the visible Transaction Batches data, and adjust;
    // the date-format candidates below are guesses and may need to match
    // whatever format the page actually renders.
    try {
      const createdAtLocator = page.locator('td, span, div').filter({ hasText: /created/i }).first();
      const createdAtText = (await createdAtLocator.innerText()).trim();
      const today = new Date();
      const day = today.getDate();
      const year = today.getFullYear();
      const monthLong = today.toLocaleString('en-US', { month: 'long' }); // "July"
      const monthShort = today.toLocaleString('en-US', { month: 'short' }); // "Jul"
      const todayCandidates = [
        today.toLocaleDateString('en-US'), // 7/14/2026
        today.toLocaleDateString('en-GB'), // 14/07/2026
        today.toISOString().slice(0, 10), // 2026-07-14
        `${day} ${monthLong}`, // 14 July
        `${day} ${monthShort}`, // 14 Jul
        `${monthLong} ${day}`, // July 14
        `${monthShort} ${day}`, // Jul 14
        `${day} ${monthLong} ${year}`, // 14 July 2026
        `${day} ${monthShort} ${year}`, // 14 Jul 2026
        `${monthLong} ${day}, ${year}`, // July 14, 2026
        `${monthShort} ${day}, ${year}`, // Jul 14, 2026
      ];
      const createdAtLower = createdAtText.toLowerCase();
      const matchesToday = todayCandidates.some((candidate) => createdAtLower.includes(candidate.toLowerCase()));
      if (!matchesToday) {
        const alertMessage = "Created At date does not match today's date.";
        console.warn(`⚠️ ${alertMessage} (found: "${createdAtText}")`);
        appendReportAlert(alertMessage);
      }
    } catch (err) {
      console.warn(`Could not verify Created At date: ${(err as Error).message}`);
    }
  }

  console.log('\n✅ Upload Payroll workflow completed successfully.');
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
    await runUploadPayroll(page);
    await browser.close();
  } finally {
    // Guarantees the browser closes even if something above throws (a
    // selector isn't found, a waitForURL times out, etc.) — without this, a
    // failed run leaves an orphaned browser window open every time.
    if (browser.isConnected()) {
      await browser.close();
    }
  }
}

// Only auto-run when this file is executed directly (e.g. `tsx
// scripts/ecampusUploadPayroll.ts` or `npm run upload-payroll:ecampus`) —
// NOT when runUploadPayroll is imported by scripts/runAllEcampus.ts, which
// would otherwise launch an extra, unwanted browser window per import.
if (require.main === module) {
  main().catch((err) => {
    console.error('Upload Payroll workflow failed:', err);
    process.exit(1);
  });
}
