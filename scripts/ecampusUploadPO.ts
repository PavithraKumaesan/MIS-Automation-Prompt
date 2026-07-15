/**
 * Standalone login + upload/batch/transaction reconciliation workflow for
 * https://forms.ecampusbuddy.com/index.php/m-welcome
 *
 * This is NOT a Playwright test (no @playwright/test runner) — it's a plain
 * script run directly with tsx so it can pause on real terminal input while
 * you solve the captcha by hand in the visible browser window.
 *
 * Run with:
 *   npm run reconcile:ecampus
 * or:
 *   npx tsx scripts/ecampusUploadPO.ts
 *
 * Credentials come from ECAMPUS_USERNAME / ECAMPUS_PASSWORD in .env (loaded
 * via dotenv). Nothing is hardcoded here.
 *
 * Runtime results (Total/Processed/Pending counts, the 8150... account
 * number) are written to .env.po as plain key=value text — NOT loaded via
 * dotenv, since these are outputs of this run, not secrets.
 *
 * Confirmed business logic (per user, 2026-07-13):
 *  - On the Batches page: if Pending > 0, click "Pending" (to drill into the
 *    unprocessed items); otherwise click "Processed". This matches the
 *    existing checkPendingAndClickIfNeeded() in pages/mis_loginpage.ts and is
 *    the OPPOSITE of a naive reading of "if Pending > 0, click Processed."
 *  - The "Select Subs" dropdown option is picked dynamically (always the
 *    first result) rather than hardcoding a fixed code like "0120", since the
 *    correct sub can vary per row/transaction.
 */

import { chromium, Page, Locator } from 'playwright';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { parse as parseCsv } from 'csv-parse/sync';
import { loginToEcampus, safeWaitForURL } from './ecampusSession';

dotenv.config();

const UPLOAD_FILE_PATH = path.resolve('upload_files', 'po_sample.csv');
const CASH_ACCOUNT_CODE = '1101-0001-0011-1000-000';
const ENV_PO_PATH = path.resolve('.env.po');
const PO_SECTION = 'After Uploading PO';
const REPORT_ENV_PATH = path.resolve('Report_PO.env');
const SAMPLE_PO_CSV_PATH = path.resolve('sample_excel', 'sample_po.csv');
const DOWNLOADED_PO_CSV_PATH = path.resolve('reports', 'downloaded_po.csv');

const DEFAULT_TIMEOUT = 20000;

// Expected Payroll_Acct_code format: XXXX-XXXX-XXXX-XXXX-XXX — first three
// 4-character segments must be exactly digits, the 4th (4 chars) and 5th
// (3 chars) segments may be letters/numbers/a mix, no segment may be blank,
// and no spaces are allowed anywhere (e.g. "8150-6231-9111-EXRR-R09").
const PAYROLL_ACCT_CODE_PATTERN = /^\d{4}-\d{4}-\d{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{3}$/;
const PAYROLL_ACCT_CODE_HEADER = 'Payroll_Acct_code';

// ---------------------------------------------------------------------------
// .env.po helpers (plain fs read/write — intentionally NOT dotenv, since this
// file records this run's results rather than secrets to load at startup).
//
// .env.po is shared with scripts/ecampusUploadVCC.ts, and both scripts use
// overlapping key names (e.g. BATCH2_TOTAL). To avoid one script's values
// clobbering the other's, values are scoped under a section header line
// ("After Uploading PO" / "After Uploading VCC") — a key is only matched
// within the body of lines between its own section header and the next
// blank line (or EOF).
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

/** Appends a timestamped alert line to Report_PO.env — never throws, so a logging failure can't itself break the run. */
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
 * Report_PO.env, and additionally logs an alert if it exceeds thresholdMs. This
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
 * Report_PO.env and continues) per the spec — only a total failure to find the
 * search result at all still throws (there'd be nothing to verify/clear
 * otherwise).
 */
async function performSearchCycle(
  page: Page,
  searchBox: Locator,
  searchButton: Locator,
  clearButton: Locator,
  searchValue: string,
  passLabel: string
) {
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
 * sample_excel/sample_po.csv against the downloaded CSV. Never throws — a
 * missing sample file, a parse failure, or a genuine mismatch are all just
 * logged (console + Report_PO.env) so the rest of the automation continues
 * regardless. Always writes a result line to Report_PO.env (match or
 * mismatch), so a successful comparison is still visible instead of being
 * silent.
 */
function compareHeaderAgainstSample() {
  try {
    if (!fs.existsSync(SAMPLE_PO_CSV_PATH)) {
      const message = `Sample file not found at ${SAMPLE_PO_CSV_PATH} — skipping CSV header comparison.`;
      console.warn(message);
      appendReportAlert(message);
      return;
    }
    const sampleRows: string[][] = parseCsv(fs.readFileSync(SAMPLE_PO_CSV_PATH, 'utf-8'), {
      relax_column_count: true,
      skip_empty_lines: true,
    });
    const downloadedRows: string[][] = parseCsv(fs.readFileSync(DOWNLOADED_PO_CSV_PATH, 'utf-8'), {
      relax_column_count: true,
      skip_empty_lines: true,
    });

    const sampleHeader = sampleRows[0] ?? [];
    const downloadedHeader = downloadedRows[0] ?? [];

    const headersMatch =
      sampleHeader.length === downloadedHeader.length &&
      sampleHeader.every((value, i) => value === downloadedHeader[i]);

    if (headersMatch) {
      const message = `Header Comparison Result: MATCH (${downloadedHeader.length} columns compared against ${SAMPLE_PO_CSV_PATH}).`;
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
 * Validates every value in the downloaded CSV's Payroll_Acct_code column
 * (column H) against the expected XXXX-XXXX-XXXX-XXXX-XXX format. Never
 * throws — a missing column, a parse failure, or a genuine format mismatch
 * are all just logged (console + Report_PO.env) so the rest of the
 * automation continues regardless. Logs the exact spec alert ONCE if any
 * row fails (not once per row), per "If any account code does not match...
 * write the following alert message" — individual bad rows are still
 * printed to the console for diagnosis. Always writes a result line to
 * Report_PO.env either way (pass or fail), so a successful validation is
 * still visible in the report instead of being silent.
 */
function validatePayrollAcctCodeColumn() {
  try {
    const downloadedRows: string[][] = parseCsv(fs.readFileSync(DOWNLOADED_PO_CSV_PATH, 'utf-8'), {
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
 * Runs the PO upload/batch/transaction workflow on an already-logged-in
 * page (i.e. after loginToEcampus() has resolved). Resets Report_PO.env
 * itself, so this is safe to call standalone or as one step in a
 * continuous multi-workflow session (see scripts/runAllEcampus.ts) — in the
 * latter case, `page` may currently be on any prior workflow's end page
 * rather than the dashboard; the "Upload" nav link below is expected to be
 * present in the persistent left-side navigation regardless.
 */
export async function runUploadPO(page: Page): Promise<void> {
  // Reset Report_PO.env at the start of every run, so it reflects only this
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

    // Playwright's setInputFiles() sets the file directly on the <input
    // type="file">, so there's no need to click a "Choose File" button first
    // (that button just opens the native OS file dialog, which Playwright
    // bypasses). NOTE: adjust the file input selector after inspecting the
    // real page — this assumes an id of "po_file_input", per the existing
    // pages/mis_loginpage.ts.
    const fileInput = page.locator('#po_file_input, input[type="file"]').first();
    await fileInput.waitFor({ state: 'attached', timeout: DEFAULT_TIMEOUT });
    await fileInput.setInputFiles(UPLOAD_FILE_PATH);

    // The field has no accessible label of "Cash Account Code" — its
    // accessible name is actually the masked placeholder text shown in the
    // box (e.g. "-1010-9111-EXRR-R09"), per the existing, already-working
    // fillacnum locator in pages/mis_loginpage.ts. NOTE: if the placeholder
    // text differs on the live page, inspect it and update this string.
    const cashAccountField = page.getByRole('textbox', { name: '-1010-9111-EXRR-R09' }).first();
    await cashAccountField.click();
    await cashAccountField.fill(CASH_ACCOUNT_CODE);

    const uploadSubmitButton = page.getByRole('button', { name: 'Upload' });
    const uploadStartTime = Date.now();
    await uploadSubmitButton.click();

    // -------------------------------------------------------------------
    // Batches — first pass
    // -------------------------------------------------------------------
    await safeWaitForURL(page, /\/m-batches/, 'batches page (first pass)');

    // Soft, non-fatal timing check: log an alert if the upload (click ->
    // landing on the batches page) took more than 3 seconds. This never
    // marks the automation as failed or stops execution — it's purely a
    // logging concern, and the remaining steps continue regardless.
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
      throw new Error(`Failed reading Total/Processed/Pending on first Batches pass: ${(err as Error).message}`);
    }

    const total1 = parseCount(totalText, 'first-pass Total');
    const processed1 = parseCount(processedText, 'first-pass Processed');
    const pending1 = parseCount(pendingText, 'first-pass Pending');

    writeSectionKeyValue(PO_SECTION, 'BATCH1_TOTAL', String(total1));
    writeSectionKeyValue(PO_SECTION, 'BATCH1_PROCESSED', String(processed1));
    writeSectionKeyValue(PO_SECTION, 'BATCH1_PENDING', String(pending1));

    // Confirmed logic: if Pending > 0, drill into Pending to work the
    // unprocessed items; otherwise click Processed.
    if (pending1 > 0) {
      await pendingLinkLocator.click();
    } else {
      await processedLinkLocator.click();
    }

    // NOTE: the exact batch id ("221") and pass index ("0") in this URL are
    // specific to this environment/run and may differ — matched generically
    // here as .../m-transactions/<id>/<pass> rather than hardcoded literally.
    await safeWaitForURL(page, /\/m-transactions\/\d+\/0/, 'transactions page (first pass, e.g. m-transactions/221/0)');

    // -------------------------------------------------------------------
    // PO Transaction — first pass
    // -------------------------------------------------------------------
    // NOTE: adjust this selector — starting point assumes a "Pending" pill/
    // link within the PO Transaction section.
    const poPendingLocator = page.locator('div.pill.pill-info', { hasText: 'Pending' }).first();
    await poPendingLocator.click();

    const selectSubsLocator = page
      .locator('span.select2-container.select2-container--bootstrap-5')
      .filter({ hasText: 'Select Subs' })
      .first();
    await selectSubsLocator.click();

    // Select2 keeps a rendered results list in the DOM even after it's
    // closed, so an unscoped `li.select2-results__option` can silently match
    // a stale/hidden option from elsewhere on the page instead of the
    // dropdown you just opened — the click succeeds but selects nothing.
    // Scope to the currently-open container (Select2's ".select2-container
    // --open" modifier class) to avoid that. NOTE: if this page uses an
    // older Select2 version without the "--open" class, inspect the live
    // DOM and adjust.
    const openDropdown = page.locator('.select2-container--open .select2-results__options');
    await openDropdown.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });

    // Sub-option is picked dynamically (always the first real result)
    // rather than a hardcoded code, since the correct sub can vary per row.
    // Excludes the underlying <select>'s own placeholder option ("Select
    // Subs" itself shows up as the first result item in Select2), disabled
    // options, and "No results found" placeholders.
    const subOptions = openDropdown
      .locator('li.select2-results__option:not(.select2-results__option--disabled):not([aria-disabled="true"])')
      .filter({ hasNotText: /no results found/i })
      .filter({ hasNotText: /^select subs$/i });
    const firstSubOption = subOptions.first();
    await firstSubOption.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });

    const chosenSubText = (await firstSubOption.innerText()).trim();
    console.log(`Selecting sub option: "${chosenSubText}"`);
    await firstSubOption.click();

    const saveChangesButton = page.getByRole('button', { name: 'Save Changes' });
    await saveChangesButton.click();

    try {
      await page.getByText('Posted', { exact: true }).waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
    } catch (err) {
      throw new Error(`Timed out waiting for "Posted" status after Save Changes: ${(err as Error).message}`);
    }

    // -------------------------------------------------------------------
    // Batches — second pass
    // -------------------------------------------------------------------
    const batchesNavLink = page.getByRole('link', { name: 'Batches' });
    await timeStep(
      'Batches page (second pass)',
      6000,
      'Batch loading time is taking more than 6 seconds.',
      async () => {
        await batchesNavLink.click();
        await safeWaitForURL(page, /\/m-batches/, 'batches page (second pass)');
      }
    );

    let totalText2: string;
    let processedText2: string;
    let pendingText2: string;
    try {
      totalText2 = await totalLocator.innerText();
      processedText2 = await processedLinkLocator.innerText();
      pendingText2 = await pendingLinkLocator.innerText();
    } catch (err) {
      throw new Error(`Failed reading Total/Processed/Pending on second Batches pass: ${(err as Error).message}`);
    }

    const total2 = parseCount(totalText2, 'second-pass Total');
    const processed2 = parseCount(processedText2, 'second-pass Processed');
    const pending2 = parseCount(pendingText2, 'second-pass Pending');

    writeSectionKeyValue(PO_SECTION, 'BATCH2_TOTAL', String(total2));
    writeSectionKeyValue(PO_SECTION, 'BATCH2_PROCESSED', String(processed2));
    writeSectionKeyValue(PO_SECTION, 'BATCH2_PENDING', String(pending2));

    // Same confirmed logic as the first pass.
    if (pending2 > 0) {
      await pendingLinkLocator.click();
    } else {
      await processedLinkLocator.click();
    }

    await safeWaitForURL(page, /\/m-transactions\/\d+\/1/, 'transactions page (second pass, e.g. m-transactions/221/1)');

    // NOTE: starting-point selector — inspect the real page for the actual
    // "Export CSV" button/link (sits near "Reversal") and adjust if needed.
    const exportCsvButton = page.getByText('Export CSV', { exact: true });
    const [download] = await Promise.all([page.waitForEvent('download'), exportCsvButton.click()]);
    await download.saveAs(DOWNLOADED_PO_CSV_PATH);

    // Compares only the header line (column names) of sample_excel/sample_po.csv
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
    writeSectionKeyValue(PO_SECTION, 'ACCOUNT_NUMBER_8150', accountNumber);

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

    const searchBox = page.locator('input[name="search"]');
    const searchButton = page.getByRole('button', { name: 'Search Records' });
    const clearButton = page.getByRole('link', { name: 'Clear' });

    // First search: the 8150... account number read above (persisted to and
    // re-read from .env.po, per the requirement that these are separate
    // read/write steps rather than reusing the in-memory variable directly).
    // Each cycle: search -> verify result appears (soft 3s alert) -> verify
    // Created At date (soft alert on mismatch) -> Clear (soft 3s alert).
    const searchValue1 = readSectionKeyValue(PO_SECTION, 'ACCOUNT_NUMBER_8150');
    await performSearchCycle(page, searchBox, searchButton, clearButton, searchValue1, 'first search (8150 number)');

    // Second search: the fixed Cash Account Code used during upload.
    await performSearchCycle(page, searchBox, searchButton, clearButton, CASH_ACCOUNT_CODE, 'second search (Cash Account Code)');
  }

  console.log('\n✅ Reconciliation workflow completed successfully. Results written to .env.po');
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
    await runUploadPO(page);
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
// scripts/ecampusUploadPO.ts` or `npm run reconcile:ecampus`) — NOT when
// runUploadPO is imported by scripts/runAllEcampus.ts, which would otherwise
// launch an extra, unwanted browser window per import.
if (require.main === module) {
  main().catch((err) => {
    console.error('Reconciliation workflow failed:', err);
    process.exit(1);
  });
}
