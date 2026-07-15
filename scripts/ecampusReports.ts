/**
 * Test case 9 — Reports.
 *
 * Runs after Financial Year (test case 8, scripts/ecampusFinancialYear.ts)
 * on the same logged-in page, per spec: "Do not end the automation...
 * Continue with the Reports module."
 *
 * Per the spec's closing "Important" section — "Do not stop the automation
 * if any URL validation fails. Write the failure message into
 * Report_Consolidated.md. Continue executing the remaining Reports module
 * validations." — EVERY step in this module is non-fatal (wrapped in
 * tryStep()), including the primary nav-type clicks that throw in earlier
 * modules (Budget, Detailed Listing, etc.). That's a deliberate deviation
 * from those modules' "no fallback alert given => throw" convention: this
 * spec explicitly overrides it for the whole module.
 *
 * NOTE: this page (Reports / Financial Reports / Balance Sheet / Income
 * Statement / NECHE Report / Board Report / Report Analytics / All Vendor
 * Transactions, plus the Settings/Charts/Layout popups on each report page)
 * has no existing precedent anywhere else in this project — every selector
 * below is a best-effort starting-point guess based on the link/button text
 * given in the spec. Expect to need live-DOM-driven fixes, same as every
 * other module in this project.
 *
 * Some alert messages aren't given verbatim in the spec for a few steps
 * (e.g. the very first "Reports" nav click, the date-filter fill, the
 * filtered-URL wait) — those use a reasonable message following the same
 * "<X> is not loaded."/"Could not <action>." style already established
 * elsewhere in this project.
 *
 * Run with:
 *   npm run reports:ecampus
 * or:
 *   npx tsx scripts/ecampusReports.ts
 */

import { chromium, Page } from 'playwright';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { loginToEcampus, safeWaitForURL } from './ecampusSession';

dotenv.config();

const REPORT_ENV_PATH = path.resolve('Report_Reports.env');
const DEFAULT_TIMEOUT = 20000;
const POPUP_TIMEOUT = 5000;
const ALL_VENDOR_TRANSACTIONS_LOAD_THRESHOLD_MS = 2000;
const BALANCE_SHEET_LOAD_THRESHOLD_MS = 2000;

// These are native <input type="date"> fields (confirmed markup:
// <input type="date" name="start_date" class="input" ...>). Two separate
// keystroke-simulation attempts (fill() with a full string, then
// pressSequentially() with raw digits after a Home key press) both landed
// every digit in the year segment instead of filling day/month/year in
// order (confirmed via screenshot — "dd-mm-52025"), so instead of simulating
// keystrokes at all, the date is set directly on the input's underlying
// value — the day/month/year IDL attribute this control natively exposes
// and is defined (per the HTML spec) to accept as a single ISO
// YYYY-MM-DD string, which the browser then displays broken out into its
// own day/month/year segments. Day 11 / Month 05 / Year 2025 for Start
// Date, Day 11 / Month 06 / Year 2026 for End Date.
const START_DATE_ISO = '2025-05-11';
const END_DATE_ISO = '2026-06-11';

/** Appends a timestamped alert line to Report_Reports.env — never throws, so a logging failure can't itself break the run. */
function appendReportAlert(message: string) {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(REPORT_ENV_PATH, line);
  } catch (err) {
    console.error(`Failed to write alert to ${REPORT_ENV_PATH}: ${(err as Error).message}`);
  }
}

/**
 * Runs `action`; on any failure, logs `failureAlert` (console + Report_Reports.env)
 * and swallows the error, so the caller always continues to the next step —
 * per this module's "never stop on a URL validation failure" instruction.
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

/**
 * Locates a card's "Open" action, confirmed via live markup to be an <a>
 * whose href IS the destination URL — same convention as the Budget
 * module's Reset link fix:
 *   <a href="https://forms.ecampusbuddy.com/index.php/m-all-vendor-transactions" class="btn btn-sm">Open <i class="bi bi-arrow-right ms-1"></i></a>
 * Targeted by class + href suffix rather than the card title/ancestor DOM
 * structure (which failed against the real page — the earlier text/ancestor
 * guess never found a matching "Open" element).
 */
function openLinkByHref(page: Page, hrefSuffix: string) {
  return page.locator(`a.btn.btn-sm[href$="${hrefSuffix}"]`).first();
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
 * Sets a native <input type="date"> field's value directly (ISO
 * YYYY-MM-DD) and verifies the browser actually accepted it, rather than
 * simulating keystrokes.
 *
 * Two keystroke-based attempts against the live page both failed the same
 * way — every digit piled into the year segment while day/month stayed
 * empty placeholders (screenshot showed "dd-mm-52025") — regardless of
 * whether a Home key press preceded typing. Setting .value on a date input
 * IS how this control natively supports being given a full date at once
 * (the HTML spec defines its value IDL attribute as exactly this ISO
 * string), so this is the standards-based way of entering it, not a
 * workaround: the browser itself is responsible for splitting it into the
 * displayed day/month/year segments correctly.
 *
 * Reads the value back afterward with inputValue() (which for a date input
 * returns the same ISO string, independent of the dd-mm-yyyy display
 * format) and throws if it doesn't match, so a rejected/ignored value is
 * caught before the Filter click rather than silently proceeding with
 * whatever the field happened to already contain.
 */
async function fillNativeDateInput(field: ReturnType<Page['locator']>, isoValue: string, fieldLabel: string): Promise<void> {
  await field.fill(isoValue);
  const actualValue = await field.inputValue();
  if (actualValue !== isoValue) {
    throw new Error(`${fieldLabel} field shows "${actualValue}", expected "${isoValue}"`);
  }
}

/** Waits (bounded by `timeout`) for `locator` to become visible, returning false instead of throwing on timeout. */
async function isVisibleWithWait(locator: ReturnType<Page['locator']>, timeout = POPUP_TIMEOUT): Promise<boolean> {
  try {
    await locator.waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Verifies every text in `expectedTexts` is visible somewhere on the page;
 * throws (for tryStep to catch) if any are missing. Case-insensitive —
 * column/field labels are quite likely rendered all-caps via CSS
 * text-transform, the same issue already hit and fixed for the "ACTIONS"
 * column header in scripts/ecampusTrialBalanceRevisit.ts and the Budget
 * Allocation Records columns in scripts/ecampusBudget.ts.
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
 * Clicks `clickAction`, then waits for the URL to match `urlPattern` —
 * wrapped as a single non-fatal step logging `notLoadedAlert` if either the
 * click or the URL wait fails.
 */
async function clickAndVerifyUrl(
  page: Page,
  clickAction: () => Promise<void>,
  urlPattern: RegExp,
  notLoadedAlert: string
): Promise<void> {
  await tryStep(async () => {
    await clickAction();
    await safeWaitForURL(page, urlPattern, notLoadedAlert, DEFAULT_TIMEOUT);
  }, notLoadedAlert);
}

/**
 * Same as clickAndVerifyUrl(), but also times the click-to-URL-match
 * duration, always recording it to Report_Reports.env, and additionally
 * alerting (a separate message from `notLoadedAlert`) if it exceeds
 * `thresholdMs`. The timing/threshold alert only fires when the page
 * actually loaded — a click/URL failure only logs `notLoadedAlert`.
 */
async function clickAndMeasureLoad(
  page: Page,
  clickAction: () => Promise<void>,
  urlPattern: RegExp,
  notLoadedAlert: string,
  durationLabel: string,
  thresholdMs: number,
  overThresholdAlert: string
): Promise<void> {
  const start = Date.now();
  await tryStep(async () => {
    await clickAction();
    await safeWaitForURL(page, urlPattern, notLoadedAlert, DEFAULT_TIMEOUT);
    const durationMs = Date.now() - start;
    appendReportAlert(`${durationLabel}: ${durationMs}ms`);
    if (durationMs > thresholdMs) {
      appendReportAlert(overThresholdAlert);
    }
  }, notLoadedAlert);
}

/**
 * Runs the Settings / Charts / Layout popup validations for a given report
 * page (Balance Sheet, Income Statement, NECHE Report), per the spec's
 * "Perform the same popup validations" instruction. Each popup check is its
 * own non-fatal step; Cancel is always attempted afterward regardless of
 * whether the popup was detected, so a false-negative visibility check
 * doesn't leave a stray popup open blocking the rest of the flow.
 */
async function validateReportPopups(page: Page, reportName: string): Promise<void> {
  const cancelButton = () => page.getByRole('button', { name: /^cancel$/i }).first();
  // Strips a redundant trailing "Report" from names like "NECHE Report" /
  // "Board Report" — confirmed against the live page that the Layout
  // popup's title drops it (e.g. "Edit Report Layout: NECHE", not
  // "Edit Report Layout: NECHE Report"), while single-word-type names like
  // "Balance Sheet"/"Income Statement" are unaffected (no trailing "Report"
  // to strip).
  const layoutTitleName = reportName.replace(/\s*report$/i, '').trim();

  await tryStep(async () => {
    await clickableText(page, 'Settings').click();
    const visible = await isVisibleWithWait(page.getByText(/report settings?/i).first());
    if (!visible) {
      throw new Error(`Report Setting popup not visible for ${reportName}`);
    }
  }, 'Setting popup is not visible.');
  await tryStep(() => cancelButton().click(), `Could not close the Settings popup for ${reportName}.`);

  await tryStep(async () => {
    await clickableText(page, 'Charts').click();
    const visible = await isVisibleWithWait(page.getByText(/report charts/i).first());
    if (!visible) {
      throw new Error(`Report Charts popup not visible for ${reportName}`);
    }
  }, 'Charts popup is not visible.');
  await tryStep(() => cancelButton().click(), `Could not close the Charts popup for ${reportName}.`);

  await tryStep(async () => {
    await clickableText(page, 'Layout').click();
    const layoutPopupPattern = new RegExp(`edit report layout:?\\s*${escapeRegExp(layoutTitleName)}`, 'i');
    const visible = await isVisibleWithWait(page.getByText(layoutPopupPattern).first());
    if (!visible) {
      throw new Error(`Edit Report Layout: ${reportName} popup not visible`);
    }
  }, `Edit Report Layout: ${reportName} popup is not visible.`);
  await tryStep(() => cancelButton().click(), `Could not close the Layout popup for ${reportName}.`);
}

/**
 * Runs the Reports workflow on an already-logged-in page (i.e. after
 * loginToEcampus() has resolved, and typically after runFinancialYear() in a
 * continuous session). Resets Report_Reports.env itself, so this is safe to
 * call standalone or as a step in scripts/runAllEcampus.ts.
 */
export async function runReports(page: Page): Promise<void> {
  // Reset Report_Reports.env at the start of every run, so it reflects only
  // this run's alerts instead of growing forever across repeated runs.
  fs.writeFileSync(REPORT_ENV_PATH, '');

  // Same "rail-link" / href-based selector already proven reliable for the
  // other left-nav links in this project.
  const reportsNavLink = page.locator('a.rail-link[href$="/m-reports"]').first();

  // -------------------------------------------------------------------
  // Reports module — per-page URL-load sweep
  // -------------------------------------------------------------------
  await clickAndVerifyUrl(page, () => reportsNavLink.click(), /\/m-reports$/, 'Reports URL is not loaded.');

  await clickAndVerifyUrl(
    page,
    () => clickableText(page, 'Financial Reports').click(),
    /\/m-reports$/,
    'Financial Reports URL is not loaded.'
  );

  await clickAndVerifyUrl(
    page,
    () => clickableText(page, 'Balance Sheet').click(),
    /\/report-analytics\/m-balance-sheet$/,
    'Balance Sheet URL is not loaded.'
  );

  await clickAndVerifyUrl(
    page,
    () => clickableText(page, 'Income Statement').click(),
    /\/report-analytics\/m-income-statement$/,
    'Income Statement URL is not loaded.'
  );

  await clickAndVerifyUrl(
    page,
    () => clickableText(page, 'NECHE Report').click(),
    /\/report-analytics\/m-neche-report$/,
    'NECHE Report URL is not loaded.'
  );

  await clickAndVerifyUrl(
    page,
    () => clickableText(page, 'Board Report').click(),
    /\/report-analytics\/m-board-report$/,
    'Board Report URL is not loaded.'
  );

  await clickAndVerifyUrl(
    page,
    () => clickableText(page, 'Report Analytics').click(),
    /\/m-reports$/,
    'Report Analytics URL is not loaded.'
  );

  // -------------------------------------------------------------------
  // All Vendor Transactions Validation
  // -------------------------------------------------------------------
  await clickAndMeasureLoad(
    page,
    () => openLinkByHref(page, '/m-all-vendor-transactions').click(),
    /\/m-all-vendor-transactions/,
    'All Vendor Transactions URL is not loaded.',
    'All Vendor Transactions page load time',
    ALL_VENDOR_TRANSACTIONS_LOAD_THRESHOLD_MS,
    'All Vendor Transactions loading is taking more than 2 seconds.'
  );

  await tryStep(
    () => verifyAllVisible(page, ['TOTAL AMOUNT', 'NO. OF VENDORS', 'TOTAL RECORDS']),
    'TOTAL AMOUNT, NO. OF VENDORS, TOTAL RECORDS are not visible.'
  );

  await tryStep(async () => {
    const exportButton = clickableText(page, 'Export CSV');
    const downloadStart = Date.now();
    const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
    const ext = path.extname(download.suggestedFilename()) || '.csv';
    const downloadPath = path.resolve('reports', `downloaded_all_vendor_transactions${ext}`);
    await download.saveAs(downloadPath);
    const downloadDurationMs = Date.now() - downloadStart;
    appendReportAlert(`All Vendor Transactions CSV download duration: ${downloadDurationMs}ms`);
  }, 'CSV file is not downloading.');

  await tryStep(async () => {
    const startDateField = fieldByAttributeHints(page, ['start_date', 'startdate', 'start']);
    await fillNativeDateInput(startDateField, START_DATE_ISO, 'Start Date');

    const endDateField = fieldByAttributeHints(page, ['end_date', 'enddate', 'end']);
    await fillNativeDateInput(endDateField, END_DATE_ISO, 'End Date');
  }, 'Could not enter the date filters for All Vendor Transactions.');

  await clickAndVerifyUrl(
    page,
    // Broadened from an anchored ^filter$ match to a substring — anchored
    // exact-name matches have repeatedly failed elsewhere in this project
    // when the real button also has a leading icon or extra whitespace in
    // its accessible name (e.g. the Reset button fix in ecampusBudget.ts).
    () => page.getByRole('button', { name: /filter/i }).first().click(),
    /\/m-all-vendor-transactions\?start_date=2025-05-11&end_date=2026-06-11&vendor=&search=/,
    'Filtered All Vendor Transactions URL is not loaded.'
  );

  // -------------------------------------------------------------------
  // Balance Sheet Report Validation
  // -------------------------------------------------------------------
  // "Click Reports near All Vendor Transactions" — interpreted as the same
  // persistent left-nav "Reports" link used above (still present regardless
  // of which page the previous step left off on), not a separate element.
  await clickAndVerifyUrl(page, () => reportsNavLink.click(), /\/m-reports$/, 'Reports URL is not loaded.');

  await clickAndMeasureLoad(
    page,
    // NOTE: Balance Sheet's "Open" href is inferred by the same pattern as
    // the confirmed All Vendor Transactions markup (href = destination URL)
    // — not yet directly confirmed; adjust if this specific one still fails.
    () => openLinkByHref(page, '/report-analytics/m-balance-sheet').click(),
    /\/report-analytics\/m-balance-sheet$/,
    'Balance Sheet URL is not loaded.',
    'Balance Sheet page load time',
    BALANCE_SHEET_LOAD_THRESHOLD_MS,
    'Balance Sheet loading is taking more than 2 seconds.'
  );

  await validateReportPopups(page, 'Balance Sheet');

  // -------------------------------------------------------------------
  // Income Statement Validation
  // -------------------------------------------------------------------
  await clickAndVerifyUrl(
    page,
    () => clickableText(page, 'Income Statement').click(),
    /\/report-analytics\/m-income-statement$/,
    'Income Statement URL is not loaded.'
  );

  await validateReportPopups(page, 'Income Statement');

  // -------------------------------------------------------------------
  // NECHE Report Validation
  // -------------------------------------------------------------------
  await clickAndVerifyUrl(
    page,
    () => clickableText(page, 'NECHE Report').click(),
    /\/report-analytics\/m-neche-report$/,
    'NECHE Report URL is not loaded.'
  );

  await validateReportPopups(page, 'NECHE Report');

  // -------------------------------------------------------------------
  // Board Report Validation
  // -------------------------------------------------------------------
  await clickAndVerifyUrl(
    page,
    () => clickableText(page, 'Board Report').click(),
    /\/report-analytics\/m-board-report$/,
    'Board Report URL is not loaded.'
  );

  await clickAndVerifyUrl(
    page,
    () => clickableText(page, 'Report Analytics').click(),
    /\/m-reports$/,
    'Report Analytics URL is not loaded.'
  );

  console.log('\n✅ Reports workflow completed.');
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
    await runReports(page);
    await browser.close();
  } finally {
    if (browser.isConnected()) {
      await browser.close();
    }
  }
}

// Only auto-run when this file is executed directly — NOT when runReports is
// imported by scripts/runAllEcampus.ts, which would otherwise launch an
// extra, unwanted browser window per import.
if (require.main === module) {
  main().catch((err) => {
    console.error('Reports workflow failed:', err);
    process.exit(1);
  });
}
