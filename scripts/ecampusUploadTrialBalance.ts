/**
 * Test case 3 — Upload Trial Balance.
 *
 * Standalone login + Trial Balance upload workflow for
 * https://forms.ecampusbuddy.com/index.php/m-welcome. Much shorter than the
 * PO/VCC scripts (scripts/ecampusUploadPO.ts, scripts/ecampusUploadVCC.ts) —
 * per this test case's spec there's no batch/pending reconciliation loop and
 * no .env.po read/write at all, just: log in, upload the file, wait for a
 * success message, click the "Trial Balance" nav link, and land on
 * m-trial_balance.
 *
 * This is NOT a Playwright test (no @playwright/test runner) — it's a plain
 * script run directly with tsx so it can pause on real terminal input while
 * you solve the captcha by hand in the visible browser window.
 *
 * Run with:
 *   npm run upload-tb:ecampus
 * or:
 *   npx tsx scripts/ecampusUploadTrialBalance.ts
 *
 * Credentials come from ECAMPUS_USERNAME / ECAMPUS_PASSWORD in .env (loaded
 * via dotenv). Nothing is hardcoded here.
 *
 * Soft, non-fatal timing/verification checks (log to Report_TB.env, never
 * throw or stop the script):
 *  - Dashboard -> Upload page load: alert if > 2 seconds.
 *  - File upload (click -> success message, polled continuously from the
 *    moment of the click rather than after a fixed wait): alert if > 3
 *    minutes.
 *  - Last Updated At date on the data visible after landing on
 *    m-trial_balance: alert if it doesn't match today's date.
 */

import { chromium, Page } from 'playwright';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { loginToEcampus, safeWaitForURL } from './ecampusSession';

dotenv.config();

const UPLOAD_FILE_PATH = path.resolve('upload_files', 'tb_fy_9.csv');
// The spec named this report file two different ways ("Report.tb.env" and
// "Report_tb.env") — standardized here on Report_TB.env, matching the
// Report_PO.env / Report_VCC.env convention used by the other scripts.
const REPORT_ENV_PATH = path.resolve('Report_TB.env');

const DEFAULT_TIMEOUT = 20000;
// Trial Balance processing has been observed to take about 4 minutes.
// SUCCESS_MESSAGE_TIMEOUT polls continuously from the moment of the Upload
// click (rather than blind-waiting first) so a short-lived success toast
// can't be missed — 5 minutes covers the observed processing time plus
// margin. NOTE: bump further if real uploads take longer still.
const SUCCESS_MESSAGE_TIMEOUT = 5 * 60 * 1000;
const UPLOAD_PAGE_LOAD_THRESHOLD = 2000;
const FILE_UPLOAD_THRESHOLD = 3 * 60 * 1000;

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

/** Appends a timestamped alert line to Report_TB.env — never throws, so a logging failure can't itself break the run. */
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
 * Runs the Trial Balance upload workflow on an already-logged-in page (i.e.
 * after loginToEcampus() has resolved). Resets Report_TB.env itself, so
 * this is safe to call standalone or as one step in a continuous
 * multi-workflow session (see scripts/runAllEcampus.ts) — in the latter
 * case, `page` may currently be on any prior workflow's end page rather
 * than the dashboard; the "Upload" nav link below is expected to be present
 * in the persistent left-side navigation regardless.
 */
export async function runUploadTrialBalance(page: Page): Promise<void> {
  // Reset Report_TB.env at the start of every run, so it reflects only this
  // run's alerts instead of growing forever across repeated runs.
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
    // btn-primary", href ".../m-upload?tab=tb", seen on this same Trial
    // Balance page) also has "Upload" in its name/text, causing ambiguous
    // matches otherwise.
    const uploadLink = page.locator('a.rail-link[href$="/m-upload"]').first();
    const uploadPageLoadStart = Date.now();
    await uploadLink.click();
    await safeWaitForURL(page, /\/m-upload/, 'upload page');

    // Soft, non-fatal timing check: log an alert if navigating to the
    // upload page took more than 2 seconds. Never marks the automation as
    // failed or stops execution.
    const uploadPageLoadMs = Date.now() - uploadPageLoadStart;
    if (uploadPageLoadMs > UPLOAD_PAGE_LOAD_THRESHOLD) {
      const alertMessage = 'loading Trial Balance time is taking more than 2seconds.';
      console.warn(`⚠️ ${alertMessage} (${uploadPageLoadMs}ms)`);
      appendReportAlert(alertMessage);
    }

    // Switch to the Trial Balance upload section (sits next to "Upload
    // VCC"), mirroring the "Upload VCC" toggle used in scripts/ecampusUploadVCC.ts.
    // NOTE: starting-point selector — inspect the real page and adjust if
    // this isn't a plain text link/tab.
    const uploadTrialBalanceToggle = page.getByText('Upload Trial Balance', { exact: true });
    await uploadTrialBalanceToggle.click();

    // Playwright's setInputFiles() sets the file directly on the <input
    // type="file">, so there's no need to click a "Choose File" button first
    // (that button just opens the native OS file dialog, which Playwright
    // bypasses). NOTE: this id is an unverified guess following the existing
    // po_file_input / vcc_file_input naming convention in
    // pages/mis_loginpage.ts — inspect the real page and adjust if it
    // differs, and if there are multiple file inputs in the DOM at once,
    // prefer a specific id over a generic input[type="file"] to avoid
    // grabbing the wrong one.
    const tbFileInput = page.locator('#tb_file_input');
    await tbFileInput.waitFor({ state: 'attached', timeout: DEFAULT_TIMEOUT });
    await tbFileInput.setInputFiles(UPLOAD_FILE_PATH);

    const uploadSubmitButton = page.getByRole('button', { name: 'Upload' });
    const fileUploadStart = Date.now();
    await uploadSubmitButton.click();

    // Poll for the success message starting immediately after the click,
    // rather than blind-waiting UPLOAD_PROCESSING_WAIT first and only then
    // checking — a fixed wait-then-check risks missing the message entirely
    // if it's a toast that auto-dismisses after a few seconds and
    // processing finishes faster than the fixed wait. SUCCESS_MESSAGE_TIMEOUT
    // is generous (5 minutes) to cover the full observed ~4-minute
    // processing time either way. NOTE: starting-point selector for the
    // success message — inspect the real page (it may be a toast, an alert
    // banner, or inline text) and adjust the pattern/locator if needed.
    try {
      await page.getByText(/success/i).first().waitFor({ state: 'visible', timeout: SUCCESS_MESSAGE_TIMEOUT });
    } catch (err) {
      throw new Error(`Timed out waiting for a success message after uploading Trial Balance: ${(err as Error).message}`);
    }

    // Record the total upload duration — from the start of the upload
    // process (the Upload click) until the upload is completed (the
    // success message appearing) — and always store it in Report_TB.env,
    // regardless of how long it took.
    const fileUploadDurationMs = Date.now() - fileUploadStart;
    appendReportAlert(`Trial Balance upload duration: ${fileUploadDurationMs}ms`);

    // The success message appearing doesn't guarantee the page is fully
    // settled — the following safeWaitForURL(/m-upload/) is likely a no-op
    // (this upload happens via AJAX without leaving m-upload at all), so
    // without a short settle delay here the "Trial Balance" nav click below
    // could fire before whatever the success banner represents has actually
    // finished. NOTE: a fixed delay is a blunt instrument — if this page
    // exposes a more specific "done" signal (e.g. a spinner disappearing),
    // prefer waiting on that instead once you've seen the live DOM.
    await page.waitForTimeout(2000);

    // Soft, non-fatal timing check: additionally alert if the upload
    // exceeded 3 minutes.
    if (fileUploadDurationMs > FILE_UPLOAD_THRESHOLD) {
      const alertMessage = 'Uploading Trial Balance time is taking more than 3 minutes.';
      console.warn(`⚠️ ${alertMessage} (${fileUploadDurationMs}ms)`);
      appendReportAlert(alertMessage);
    }

    await safeWaitForURL(page, /\/m-upload/, 'upload page (after Trial Balance processing)');

    // This is the "Trial Balance" module link in the left-side navigation
    // (same kind of element as the "Upload" nav link above), not the
    // "Upload Trial Balance" toggle on the upload page — so a link-role
    // match alone is sufficient here, no getByText() fallback needed.
    // NOTE: adjust this selector to match the real left-nav markup.
    const trialBalanceNavLink = page.getByRole('link', { name: 'Trial Balance' });
    await trialBalanceNavLink.click();
    await safeWaitForURL(page, /\/m-trial_balance/, 'trial balance page');

    // Verify the Last Updated At date matches today's date — non-fatal on
    // mismatch or on failing to read it at all. NOTE: starting-point
    // selector — inspect the real page for the actual "Last Updated At"
    // field/column and adjust; the date-format candidates below are guesses
    // and may need to match whatever format the page actually renders.
    try {
      const lastUpdatedAtLocator = page.locator('td, span, div').filter({ hasText: /last updated/i }).first();
      const lastUpdatedAtText = (await lastUpdatedAtLocator.innerText()).trim();
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
      const lastUpdatedAtLower = lastUpdatedAtText.toLowerCase();
      const matchesToday = todayCandidates.some((candidate) => lastUpdatedAtLower.includes(candidate.toLowerCase()));
      if (!matchesToday) {
        const alertMessage = "Last Updated At date does not match today's date.";
        console.warn(`⚠️ ${alertMessage} (found: "${lastUpdatedAtText}")`);
        appendReportAlert(alertMessage);
      }
    } catch (err) {
      console.warn(`Could not verify Last Updated At date: ${(err as Error).message}`);
    }
  }

  console.log('\n✅ Upload Trial Balance workflow completed successfully.');
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
    await runUploadTrialBalance(page);
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
// scripts/ecampusUploadTrialBalance.ts` or `npm run upload-tb:ecampus`) —
// NOT when runUploadTrialBalance is imported by scripts/runAllEcampus.ts,
// which would otherwise launch an extra, unwanted browser window per import.
if (require.main === module) {
  main().catch((err) => {
    console.error('Upload Trial Balance workflow failed:', err);
    process.exit(1);
  });
}
