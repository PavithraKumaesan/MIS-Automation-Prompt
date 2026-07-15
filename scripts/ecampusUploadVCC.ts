/**
 * Test case 2 — Upload VCC.
 *
 * Standalone login + upload/batch/transaction reconciliation workflow for
 * https://forms.ecampusbuddy.com/index.php/m-welcome, but for the VCC upload
 * path instead of the PO upload path (see scripts/ecampusUploadPO.ts
 * for the PO variant).
 *
 * This is NOT a Playwright test (no @playwright/test runner) — it's a plain
 * script run directly with tsx so it can pause on real terminal input while
 * you solve the captcha by hand in the visible browser window.
 *
 * Run with:
 *   npm run upload-vcc:ecampus
 * or:
 *   npx tsx scripts/ecampusUploadVCC.ts
 *
 * Credentials come from ECAMPUS_USERNAME / ECAMPUS_PASSWORD in .env (loaded
 * via dotenv). Nothing is hardcoded here.
 *
 * Runtime results (Total/Processed/Pending counts, the 8150... account
 * number) are written to .env.po as plain text — NOT loaded via dotenv,
 * since these are outputs of this run, not secrets. .env.po is shared with
 * scripts/ecampusUploadPO.ts, so this script's writes are additive.
 *
 * Differences from the PO reconciliation script (per this test case's spec):
 *  - An extra "Upload VCC" toggle must be clicked on the Upload page before
 *    the VCC file input/Cash Account Code fields become relevant.
 *  - There is no PO-Transaction/Select-Subs/Save-Changes/"Posted" step here —
 *    after the first Batches pass, it's just "click Processed" twice (once
 *    per transactions page) with no Pending branch. Per the spec, "click
 *    Processed" is the only action described (no "else" case is given), so
 *    this script clicks Processed unconditionally rather than inventing a
 *    Pending branch — flagged inline below in case that assumption is wrong.
 *  - The 8150... account number is written as ACCOUNT_NUMBER_8150= within the
 *    "After Uploading VCC" section, same key=value convention as the PO script.
 *  - On the all-transactions page, a "VCC Transactions" toggle (next to
 *    "Purchase Orders") must be clicked before searching, mirroring the
 *    "Upload VCC" toggle used earlier on the Upload page.
 *
 * Reliability/logging features ported from scripts/ecampusUploadPO.ts (kept
 * in sync so both scripts behave consistently):
 *  - Report_VCC.env is reset at the start of every run.
 *  - Soft, non-fatal timing checks (post-signin load, upload time, batches
 *    page load, all-transactions page load) that log to Report_VCC.env and never
 *    throw or stop the script.
 *  - The search -> verify Created At -> Clear cycle is shared via
 *    performSearchCycle(), same as the PO script.
 *  - "Export CSV" (near "Reversal") is clicked once both Processed-click
 *    branches converge on the .../1 transactions URL; the download is saved
 *    to reports/downloaded_vcc.csv and its header line is compared against
 *    sample_excel/sample_vcc.csv via compareHeaderAgainstSample(), mirroring
 *    the PO script's equivalent check against sample_excel/sample_po.csv.
 */

import { chromium, Page, Locator } from 'playwright';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { parse as parseCsv } from 'csv-parse/sync';
import { loginToEcampus, safeWaitForURL } from './ecampusSession';

dotenv.config();

const UPLOAD_FILE_PATH = path.resolve('upload_files', 'vcc_sample.csv');
const CASH_ACCOUNT_CODE = '0001-0001-0011-1000-000';
const ENV_PO_PATH = path.resolve('.env.po');
const VCC_SECTION = 'After Uploading VCC';
const REPORT_ENV_PATH = path.resolve('Report_VCC.env');
const SAMPLE_VCC_CSV_PATH = path.resolve('sample_excel', 'sample_vcc.csv');
const DOWNLOADED_VCC_CSV_PATH = path.resolve('reports', 'downloaded_vcc.csv');

const DEFAULT_TIMEOUT = 20000;

// Expected Payroll_Acct_code format: XXXX-XXXX-XXXX-XXXX-XXX — first three
// 4-character segments must be exactly digits, the 4th (4 chars) and 5th
// (3 chars) segments may be letters/numbers/a mix, no segment may be blank,
// and no spaces are allowed anywhere (e.g. "8150-6231-9111-EXRR-R09").
// Mirrors the same validation in scripts/ecampusUploadPO.ts.
const PAYROLL_ACCT_CODE_PATTERN = /^\d{4}-\d{4}-\d{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{3}$/;
const PAYROLL_ACCT_CODE_HEADER = 'Payroll_Acct_code';

// ---------------------------------------------------------------------------
// .env.po helpers (plain fs read/write — intentionally NOT dotenv, since this
// file records this run's results rather than secrets to load at startup).
//
// .env.po is shared with scripts/ecampusUploadPO.ts, and both scripts
// use overlapping key names (e.g. BATCH2_TOTAL). To avoid one script's
// values clobbering the other's, values are scoped under a section header
// line ("After Uploading PO" / "After Uploading VCC") — a key is only
// matched within the body of lines between its own section header and the
// next blank line (or EOF).
// ---------------------------------------------------------------------------

function findSectionBody(lines: string[], section: string): { start: number; end: number } | null {
  const start = lines.indexOf(section);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && lines[end].trim() !== '') {
    end++;
  }
  return { start, end };
}

function writeSectionKeyValue(section: string, key: string, value: string) {
  const content = fs.existsSync(ENV_PO_PATH) ? fs.readFileSync(ENV_PO_PATH, 'utf-8') : '';
  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  const body = findSectionBody(lines, section);
  const line = `${key}=${value}`;

  if (!body) {
    const trimmed = content.replace(/\s+$/, '');
    const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : '';
    fs.writeFileSync(ENV_PO_PATH, `${prefix}${section}\n${line}\n`);
    return;
  }

  const keyPattern = new RegExp(`^${key}\\s*=`);
  const existingIdx = lines.slice(body.start + 1, body.end).findIndex((l) => keyPattern.test(l));
  if (existingIdx !== -1) {
    lines[body.start + 1 + existingIdx] = line;
  } else {
    lines.splice(body.end, 0, line);
  }
  fs.writeFileSync(ENV_PO_PATH, lines.join('\n'));
}

function readSectionKeyValue(section: string, key: string): string {
  if (!fs.existsSync(ENV_PO_PATH)) {
    throw new Error(`${ENV_PO_PATH} does not exist — nothing has been written yet.`);
  }
  const lines = fs.readFileSync(ENV_PO_PATH, 'utf-8').split(/\r?\n/);
  const body = findSectionBody(lines, section);
  if (!body) {
    throw new Error(`Section "${section}" not found in ${ENV_PO_PATH}`);
  }
  const keyPattern = new RegExp(`^${key}\\s*=\\s*(.*)$`);
  for (let i = body.start + 1; i < body.end; i++) {
    const match = lines[i].match(keyPattern);
    if (match) return match[1].trim();
  }
  throw new Error(`Key "${key}" not found in section "${section}" of ${ENV_PO_PATH}`);
}

/** Appends a timestamped alert line to Report_VCC.env — never throws, so a logging failure can't itself break the run. */
function appendReportAlert(message: string) {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(REPORT_ENV_PATH, line);
  } catch (err) {
    console.error(`Failed to write alert to ${REPORT_ENV_PATH}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

/** Extracts the first integer found in a string of page text (e.g. "8 total" -> 8). */
function parseCount(text: string, description: string): number {
  const match = text.match(/\d+/);
  if (!match) {
    throw new Error(`Could not parse a number out of "${text}" while reading ${description}`);
  }
  return parseInt(match[0], 10);
}

/**
 * Times a navigation/load step; always records the measured duration to
 * Report_VCC.env, and additionally logs an alert if it exceeds thresholdMs. This
 * is purely a logging concern — it never throws, so a slow-but-successful
 * load doesn't stop the run. The caller is still responsible for its own
 * real error handling (e.g. safeWaitForURL) for genuine failures.
 */
async function timeStep(label: string, thresholdMs: number, alertMessage: string, action: () => Promise<void>) {
  const start = Date.now();
  await action();
  const durationMs = Date.now() - start;
  appendReportAlert(`${label} load time: ${durationMs}ms`);
  if (durationMs > thresholdMs) {
    console.warn(`⚠️ ${alertMessage} (${durationMs}ms)`);
    appendReportAlert(alertMessage);
  }
}

/**
 * Runs one search -> verify Created At -> Clear cycle in the Transaction
 * lookup section. Every timing/verification check here is non-fatal (logs to
 * Report_VCC.env and continues) — only a total failure to find the search
 * result at all still throws (there'd be nothing to verify/clear
 * otherwise). Optional beforeSearch runs first — used here to re-click the
 * "VCC Transactions" toggle before the second search, since Clear resets it.
 */
async function performSearchCycle(
  page: Page,
  searchBox: Locator,
  searchButton: Locator,
  clearButton: Locator,
  searchValue: string,
  passLabel: string,
  beforeSearch?: () => Promise<void>
) {
  if (beforeSearch) {
    await beforeSearch();
  }

  await searchBox.fill(searchValue);

  const searchStart = Date.now();
  await searchButton.click();

  // NOTE: this is a broad, best-effort match — it just waits for the
  // searched value to render anywhere visible on the page (e.g. inside a
  // results table row), since the real "PO Transaction" section/row markup
  // hasn't been inspected yet. Once you've seen the live results DOM,
  // tighten this to a specific row/table locator for reliability.
  const searchResult = page.getByText(searchValue, { exact: false }).first();
  try {
    await searchResult.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
  } catch (err) {
    throw new Error(`Timed out waiting for a PO Transaction result matching "${searchValue}" (${passLabel}): ${(err as Error).message}`);
  }
  const searchDurationMs = Date.now() - searchStart;
  if (searchDurationMs > 3000) {
    const alertMessage = 'Search AC-Number is taking more than 3 seconds.';
    console.warn(`⚠️ ${alertMessage} (${searchDurationMs}ms, ${passLabel})`);
    appendReportAlert(alertMessage);
  }

  // Verify the Created At date matches today's date — non-fatal on mismatch
  // or on failing to read it at all. NOTE: starting-point selector — inspect
  // the real page for the actual "Created At" field/column and adjust; the
  // date-format candidates below are guesses and may need to match whatever
  // format the page actually renders.
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
      console.warn(`⚠️ ${alertMessage} (found: "${createdAtText}", ${passLabel})`);
      appendReportAlert(alertMessage);
    }
  } catch (err) {
    console.warn(`Could not verify Created At date (${passLabel}): ${(err as Error).message}`);
  }

  const clearStart = Date.now();
  await clearButton.click();
  const clearDurationMs = Date.now() - clearStart;
  if (clearDurationMs > 3000) {
    const alertMessage = 'Clear action is taking more than 3 seconds.';
    console.warn(`⚠️ ${alertMessage} (${clearDurationMs}ms, ${passLabel})`);
    appendReportAlert(alertMessage);
  }
}

/**
 * Compares only the header line (row 0 — all column names) of
 * sample_excel/sample_vcc.csv against the downloaded VCC CSV. Never throws —
 * a missing sample file, a parse failure, or a genuine mismatch are all just
 * logged (console + Report_VCC.env) so the rest of the automation continues
 * regardless. Always writes a result line to Report_VCC.env (match or
 * mismatch), so a successful comparison is still visible instead of being
 * silent. Mirrors compareHeaderAgainstSample() in scripts/ecampusUploadPO.ts.
 */
function compareHeaderAgainstSample() {
  try {
    if (!fs.existsSync(SAMPLE_VCC_CSV_PATH)) {
      const message = `Sample file not found at ${SAMPLE_VCC_CSV_PATH} — skipping CSV header comparison.`;
      console.warn(message);
      appendReportAlert(message);
      return;
    }
    const sampleRows: string[][] = parseCsv(fs.readFileSync(SAMPLE_VCC_CSV_PATH, 'utf-8'), {
      relax_column_count: true,
      skip_empty_lines: true,
    });
    const downloadedRows: string[][] = parseCsv(fs.readFileSync(DOWNLOADED_VCC_CSV_PATH, 'utf-8'), {
      relax_column_count: true,
      skip_empty_lines: true,
    });

    const sampleHeader = sampleRows[0] ?? [];
    const downloadedHeader = downloadedRows[0] ?? [];

    const headersMatch =
      sampleHeader.length === downloadedHeader.length &&
      sampleHeader.every((value, i) => value === downloadedHeader[i]);

    if (headersMatch) {
      const message = `Header Comparison Result: MATCH (${downloadedHeader.length} columns compared against ${SAMPLE_VCC_CSV_PATH}).`;
      console.log(`✅ ${message}`);
      appendReportAlert(message);
    } else {
      const alertMessage = 'Downloaded CSV column header does not match the sample file.';
      const message = `Header Comparison Result: NOT MATCH — ${alertMessage} (sample: "${sampleHeader.join(',')}", downloaded: "${downloadedHeader.join(',')}")`;
      console.warn(`⚠️ ${message}`);
      appendReportAlert(message);
    }
  } catch (err) {
    const message = `Could not compare downloaded CSV header against sample file: ${(err as Error).message}`;
    console.warn(message);
    appendReportAlert(message);
  }
}

/**
 * Validates every value in the downloaded VCC CSV's Payroll_Acct_code
 * column (column H) against the expected XXXX-XXXX-XXXX-XXXX-XXX format.
 * Never throws — a missing column, a parse failure, or a genuine format
 * mismatch are all just logged (console + Report_VCC.env) so the rest of
 * the automation continues regardless. Logs the exact spec alert ONCE if
 * any row fails (not once per row) — individual bad rows are still printed
 * to the console for diagnosis. Always writes a result line either way
 * (pass or fail), so a successful validation is still visible in the
 * report. Mirrors validatePayrollAcctCodeColumn() in
 * scripts/ecampusUploadPO.ts.
 */
function validatePayrollAcctCodeColumn() {
  try {
    const downloadedRows: string[][] = parseCsv(fs.readFileSync(DOWNLOADED_VCC_CSV_PATH, 'utf-8'), {
      relax_column_count: true,
      skip_empty_lines: true,
    });
    const header = downloadedRows[0] ?? [];
    const columnIndex = header.findIndex((value) => value.trim().toLowerCase() === PAYROLL_ACCT_CODE_HEADER.toLowerCase());

    if (columnIndex === -1) {
      const message = `Could not find a "${PAYROLL_ACCT_CODE_HEADER}" column in the downloaded CSV — skipping account code format validation.`;
      console.warn(message);
      appendReportAlert(message);
      return;
    }

    const dataRowCount = downloadedRows.length - 1;
    let anyInvalid = false;
    for (let rowIndex = 1; rowIndex < downloadedRows.length; rowIndex++) {
      const value = (downloadedRows[rowIndex][columnIndex] ?? '').trim();
      if (!PAYROLL_ACCT_CODE_PATTERN.test(value)) {
        anyInvalid = true;
        console.warn(`⚠️ Account code number is not in the proper format. (row ${rowIndex + 1}: "${value}")`);
      }
    }

    if (anyInvalid) {
      appendReportAlert('Account code number is not in the proper format.');
    } else {
      const message = `Payroll_Acct_code validation passed: all ${dataRowCount} account code(s) match the expected XXXX-XXXX-XXXX-XXXX-XXX format.`;
      console.log(`✅ ${message}`);
      appendReportAlert(message);
    }
  } catch (err) {
    const message = `Could not validate the ${PAYROLL_ACCT_CODE_HEADER} column: ${(err as Error).message}`;
    console.warn(message);
    appendReportAlert(message);
  }
}

// ---------------------------------------------------------------------------
// Main workflow
// ---------------------------------------------------------------------------

/**
 * Runs the VCC upload/batch/transaction workflow on an already-logged-in
 * page (i.e. after loginToEcampus() has resolved). Resets Report_VCC.env
 * itself, so this is safe to call standalone or as one step in a
 * continuous multi-workflow session (see scripts/runAllEcampus.ts) — in the
 * latter case, `page` may currently be on any prior workflow's end page
 * rather than the dashboard; the "Upload" nav link below is expected to be
 * present in the persistent left-side navigation regardless.
 */
export async function runUploadVCC(page: Page): Promise<void> {
  // Reset Report_VCC.env at the start of every run, so it reflects only this
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
    // btn-primary", href ".../m-upload?tab=tb", seen on the Trial Balance
    // page) also has "Upload" in its name/text, causing ambiguous matches
    // otherwise in a continuous session where a prior workflow left the
    // page in that state.
    const uploadLink = page.locator('a.rail-link[href$="/m-upload"]').first();
    await uploadLink.click();
    await safeWaitForURL(page, /\/m-upload/, 'upload page');

    // Toggle to the VCC upload section (sits next to "Upload PO" on this
    // page, per the spec). Matches the existing, already-working `uploadvcc`
    // locator convention in pages/mis_loginpage.ts.
    const uploadVccToggle = page.getByText('Upload VCC', { exact: true });
    await uploadVccToggle.click();

    // Playwright's setInputFiles() sets the file directly on the <input
    // type="file">, so there's no need to click a "Choose File" button first
    // (that button just opens the native OS file dialog, which Playwright
    // bypasses). Uses the VCC-specific input id from the existing
    // pages/mis_loginpage.ts (vcc_fileinput) rather than a generic
    // input[type="file"] fallback, since the Upload page likely still has
    // the PO file input in the DOM too and a generic selector could grab the
    // wrong one. NOTE: adjust if the real id differs.
    const vccFileInput = page.locator('#vcc_file_input');
    await vccFileInput.waitFor({ state: 'attached', timeout: DEFAULT_TIMEOUT });
    await vccFileInput.setInputFiles(UPLOAD_FILE_PATH);

    // Same Cash Account Code field as the PO flow — pages/mis_loginpage.ts's
    // VCC_Accountnum() reuses the identical `fillacnum` locator, so this
    // field is shared between PO and VCC uploads. Its accessible name is the
    // masked placeholder text shown in the box, not a "Cash Account Code"
    // label. NOTE: if the placeholder text differs on the live page, inspect
    // it and update this string.
    const cashAccountField = page.getByRole('textbox', { name: '-1010-9111-EXRR-R09' }).first();
    await cashAccountField.click();
    await cashAccountField.fill(CASH_ACCOUNT_CODE);

    const uploadSubmitButton = page.getByRole('button', { name: 'Upload' });
    const uploadStartTime = Date.now();
    await uploadSubmitButton.click();

    // -------------------------------------------------------------------
    // Batches — first pass
    // -------------------------------------------------------------------
    await safeWaitForURL(page, /\/m-batches/, 'batches page');

    // Soft, non-fatal timing check: log an alert if the upload (click ->
    // landing on the batches page) took more than 3 seconds. This never
    // marks the automation as failed or stops execution — it's purely a
    // logging concern, and the remaining steps continue regardless. (Unlike
    // ecampusUploadPO.ts, there's no separate "Batch loading time" 6s check
    // here — VCC only visits the batches page once, so that would just be
    // re-measuring this same transition against a second threshold.)
    const uploadDurationMs = Date.now() - uploadStartTime;
    if (uploadDurationMs > 3000) {
      const alertMessage = 'Uploading time is taking more than 3 seconds.';
      console.warn(`⚠️ ${alertMessage} (${uploadDurationMs}ms)`);
      appendReportAlert(alertMessage);
    }

    // NOTE: these locators are starting points — inspect the real batches
    // table/summary markup and adjust as needed.
    const totalLocator = page.locator('td').filter({ hasText: /total/i }).first();
    const processedLinkLocator = page.getByRole('link', { name: /processed/i }).first();
    const pendingLinkLocator = page.locator('a.text-neg, a', { hasText: /pending/i }).first();

    let totalText: string;
    let processedText: string;
    let pendingText: string;
    try {
      totalText = await totalLocator.innerText();
      processedText = await processedLinkLocator.innerText();
      pendingText = await pendingLinkLocator.innerText();
    } catch (err) {
      throw new Error(`Failed reading Total/Processed/Pending on the Batches page: ${(err as Error).message}`);
    }

    const total1 = parseCount(totalText, 'Total');
    const processed1 = parseCount(processedText, 'Processed');
    const pending1 = parseCount(pendingText, 'Pending');

    // Per the requested .env.po layout, this section's keys are named
    // BATCH2_* (not BATCH1_*) even though this script only reads the
    // Batches page once — presumably to distinguish it as the second
    // upload/batch check in the overall PO-then-VCC session. Say so if
    // BATCH1_* was actually intended here instead.
    writeSectionKeyValue(VCC_SECTION, 'BATCH2_TOTAL', String(total1));
    writeSectionKeyValue(VCC_SECTION, 'BATCH2_PROCESSED', String(processed1));
    writeSectionKeyValue(VCC_SECTION, 'BATCH2_PENDING', String(pending1));

    if (pending1 > 0) {
      console.log(`Pending is ${pending1} (> 0) — clicking Processed.`);
    } else {
      console.log('Pending is 0 — clicking Processed anyway, since no alternate action is specified for this flow.');
    }
    // NOTE: unlike ecampusUploadPO.ts (the PO flow), this spec only
    // describes clicking "Processed" — no Pending branch is given for this
    // VCC flow, so Processed is clicked unconditionally. If VCC batches
    // should behave like PO batches (Pending link when Pending > 0), say so
    // and this can be changed to match.
    await processedLinkLocator.click();

    // The trailing /0 vs /1 segment in this URL is NOT a simple "first
    // click / second click" counter — it reflects actual batch state.
    // Observed live: when Pending was 0, clicking Processed once landed
    // directly on .../<id>/1, skipping /0 entirely. So wait for whichever
    // suffix comes back, and only click Processed a second time if we
    // landed on /0 (meaning one more click is still needed to reach /1).
    // NOTE: the batch id itself ("221", "233", ...) is run-specific and
    // matched generically here.
    await safeWaitForURL(page, /\/m-transactions\/\d+\/(0|1)/, 'transactions page (after first Processed click)');

    const passMatch = page.url().match(/\/m-transactions\/\d+\/(\d+)/);
    const passSuffix = passMatch ? passMatch[1] : null;

    if (passSuffix === '0') {
      console.log('Landed on pass suffix "0" — clicking Processed again to reach "1".');
      // Click Processed again on this transactions page — no PO-Transaction/
      // Select-Subs/Save-Changes/"Posted" step in this flow. Reuses the same
      // generic "processed" link pattern; Locators re-query live, so this is
      // valid even though we're now on a different page than the Batches
      // page. NOTE: verify this matches the correct element on the live DOM.
      await processedLinkLocator.click();
      await safeWaitForURL(page, /\/m-transactions\/\d+\/1/, 'transactions page (final, e.g. m-transactions/221/1)');
    } else {
      console.log(`Landed directly on pass suffix "${passSuffix}" — skipping the second Processed click.`);
    }

    // Both branches above are guaranteed to have reached .../1 by this point.
    // NOTE: starting-point selector — inspect the real page for the actual
    // "Export CSV" button/link (sits near "Reversal") and adjust if needed.
    const exportCsvButton = page.getByText('Export CSV', { exact: true });
    const [download] = await Promise.all([page.waitForEvent('download'), exportCsvButton.click()]);
    await download.saveAs(DOWNLOADED_VCC_CSV_PATH);

    // Compares only the header line (column names) of sample_excel/sample_vcc.csv
    // against the downloaded file — non-fatal on any mismatch or failure, per spec.
    compareHeaderAgainstSample();

    // Validates every Payroll_Acct_code (column H) value in the same
    // downloaded CSV against the expected XXXX-XXXX-XXXX-XXXX-XXX format —
    // non-fatal on any mismatch or failure, per spec.
    validatePayrollAcctCodeColumn();

    // -------------------------------------------------------------------
    // Transaction lookup
    // -------------------------------------------------------------------
    // NOTE: adjust this selector — starting point assumes an "Account ·
    // Description" cell/field containing a value beginning with "8150-".
    const accountDescriptionLocator = page.locator('td:has-text("8150-")').first();
    let accountText: string;
    try {
      accountText = await accountDescriptionLocator.innerText();
    } catch (err) {
      throw new Error(`Failed reading the 8150... account number: ${(err as Error).message}`);
    }
    const accountMatch = accountText.match(/8150[-\w]*/);
    if (!accountMatch) {
      throw new Error(`Could not find an "8150..." account number in "${accountText}"`);
    }
    const accountNumber = accountMatch[0];

    writeSectionKeyValue(VCC_SECTION, 'ACCOUNT_NUMBER_8150', accountNumber);

    const transactionsNavLink = page.getByRole('link', { name: /transactions/i }).first();
    await timeStep(
      'All-transactions page',
      6000,
      'Transaction loading time is taking more than 6 seconds.',
      async () => {
        await transactionsNavLink.click();
        await safeWaitForURL(page, /\/m-all-transactions/, 'all-transactions page');
      }
    );

    // Switch to the VCC side of this page (sits next to "Purchase Orders",
    // mirroring the "Upload VCC" toggle used earlier on the Upload page).
    // NOTE: starting-point selector — inspect the real page and adjust if
    // this isn't a plain text link/tab.
    const vccTransactionsToggle = page.getByText('VCC Transactions', { exact: true });
    await vccTransactionsToggle.click();

    const searchBox = page.locator('input[name="search"]');
    const searchButton = page.getByRole('button', { name: 'Search Records' });
    const clearButton = page.getByRole('link', { name: 'Clear' });

    // First search: the 8150... account number, re-read from .env.po (per
    // the requirement that this is a separate read step, not a reuse of the
    // in-memory variable). Each cycle: search -> verify result appears
    // (soft 3s alert) -> verify Created At date (soft alert on mismatch) ->
    // Clear (soft 3s alert).
    const searchValue1 = readSectionKeyValue(VCC_SECTION, 'ACCOUNT_NUMBER_8150');
    await performSearchCycle(page, searchBox, searchButton, clearButton, searchValue1, 'first search (8150 number)');

    // Second search: the fixed Cash Account Code used during upload.
    // Clicking Clear appears to reset back to a state where the VCC
    // Transactions toggle needs re-selecting, so re-click it (via
    // beforeSearch) before this search.
    await performSearchCycle(
      page,
      searchBox,
      searchButton,
      clearButton,
      CASH_ACCOUNT_CODE,
      'second search (Cash Account Code)',
      async () => {
        await vccTransactionsToggle.click();
      }
    );
  }

  console.log('\n✅ Upload VCC workflow completed successfully. Results written to .env.po');
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
    await runUploadVCC(page);
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
// scripts/ecampusUploadVCC.ts` or `npm run upload-vcc:ecampus`) — NOT when
// runUploadVCC is imported by scripts/runAllEcampus.ts, which would
// otherwise launch an extra, unwanted browser window per import.
if (require.main === module) {
  main().catch((err) => {
    console.error('Upload VCC workflow failed:', err);
    process.exit(1);
  });
}
