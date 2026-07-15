/**
 * Test case 5 — Internal Accounts.
 *
 * Runs after Payroll (per spec: "do not end the automation... continue with
 * the following Internal Accounts validation steps"). On an already-logged-in
 * page, exercises the Accounts tabs, creates a sample Internal Account, and
 * imports a sample CSV. The Trial Balance revisit that originally followed
 * this in the same spec is now test case 6, in
 * scripts/ecampusTrialBalanceRevisit.ts, so the two run as separate,
 * independently-reported steps in scripts/runAllEcampus.ts.
 *
 * Almost every step here is an independent, non-fatal validation per the
 * spec's closing instruction ("do not stop the automation if any validation
 * fails... log the appropriate alert message and continue"). Each such step
 * is wrapped in tryStep() below: on failure, it logs the exact alert message
 * given in the spec to Report_Accounts.env and moves on. Only the very first
 * "Accounts" nav click has no specified fallback message, so — consistent
 * with the primary nav clicks in the other scripts — it's treated as a
 * real/structural failure that throws.
 *
 * NOTE: this page (Accounts, Object Class/Code fields, Internal Master
 * Accounts, Import Accounts) has no existing precedent anywhere else in this
 * project, unlike e.g. the VCC upload toggle which could be cross-checked
 * against pages/mis_loginpage.ts. Every selector below is a best-effort
 * starting-point guess — expect more of these to need correction after a
 * live run than in the other scripts.
 *
 * The spec asked for alerts to be logged directly into Report_Consolidated.md,
 * but that file is fully regenerated (overwritten) by
 * scripts/consolidateReports.ts every time it runs, so writing into it
 * directly here would just get clobbered the next time the run-all
 * orchestrator calls the consolidation step. Instead this uses its own
 * Report_Accounts.env, matching the Report_PO.env / Report_VCC.env /
 * Report_TB.env / Report_payroll.env convention, added as a section in
 * consolidateReports.ts — so its content still ends up in
 * Report_Consolidated.md, just without the clobbering risk.
 *
 * Run with:
 *   npm run accounts:ecampus
 * or:
 *   npx tsx scripts/ecampusInternalAccounts.ts
 */

import { chromium, Page } from 'playwright';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { loginToEcampus, safeWaitForURL } from './ecampusSession';

dotenv.config();

const REPORT_ENV_PATH = path.resolve('Report_Accounts.env');
const DEFAULT_TIMEOUT = 20000;
const IMPORT_TIME_THRESHOLD_MS = 3000;

// Account fields used both to fill the form and to verify the created row.
const FUND = '0001';
const DEPARTMENT = '1101';
const SUBSIDIARY = '0000';
const OBJECT_CLASS = 'EXEA';
const OBJECT_CODE = 'E11';
const DESCRIPTION = 'sample Accounts';
const GROUP_VALUE = '4120';
// NOTE: guessed composite format (Fund-Department-Subsidiary-ObjectClass-
// ObjectCode), matching the dash-separated account-code convention used
// everywhere else in this project (e.g. "1101-0001-0011-1000-000"). Adjust
// if the real Account Code column renders a different format.
const EXPECTED_ACCOUNT_CODE = `${FUND}-${DEPARTMENT}-${SUBSIDIARY}-${OBJECT_CLASS}-${OBJECT_CODE}`;

/** Appends a timestamped alert line to Report_Accounts.env — never throws, so a logging failure can't itself break the run. */
function appendReportAlert(message: string) {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(REPORT_ENV_PATH, line);
  } catch (err) {
    console.error(`Failed to write alert to ${REPORT_ENV_PATH}: ${(err as Error).message}`);
  }
}

/**
 * Runs `action`; on any failure, logs `failureAlert` (console + Report_Accounts.env)
 * and swallows the error, so the caller always continues to the next step —
 * this is the "if X cannot be done, log alert Y, continue" pattern that
 * almost every step in this module follows.
 */
async function tryStep(action: () => Promise<void>, failureAlert: string): Promise<void> {
  try {
    await action();
  } catch (err) {
    console.warn(`⚠️ ${failureAlert} (${(err as Error).message})`);
    appendReportAlert(failureAlert);
  }
}

/** Opens a Select2-style dropdown and clicks the option matching `optionText` (or the first real option if optionText is omitted). */
async function selectSelect2Option(page: Page, trigger: ReturnType<Page['locator']>, optionText?: string): Promise<void> {
  await trigger.click();
  const openDropdown = page.locator('.select2-container--open .select2-results__options');
  await openDropdown.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });

  const options = openDropdown
    .locator('li.select2-results__option:not(.select2-results__option--disabled):not([aria-disabled="true"])')
    .filter({ hasNotText: /no results found/i });

  const option = optionText ? options.filter({ hasText: optionText }).first() : options.first();
  await option.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
  await option.click();
}

/**
 * Finds an <input> by matching hints against its own name/id/placeholder
 * attributes, rather than by proximity to nearby label text.
 *
 * Two label-proximity approaches were tried first (page.locator('label')
 * containing the text, then page.getByText() for any element containing the
 * text) and both ended up matching the wrong input — specifically, the
 * page's generic top-level "Search Records" box, which just happened to be
 * the next <input> in document order after wherever the label text was
 * found. Proximity-based search is unreliable here because unrelated UI
 * (like that search box) sits between the label and the real field, so this
 * targets the input's own attributes instead, which doesn't depend on
 * document position at all.
 *
 * NOTE: the exact attribute values are an unverified guess (common naming
 * patterns for each hint) — inspect the real page's form field attributes
 * and adjust the hint list per field if this still matches the wrong
 * element or nothing at all.
 */
function fieldByAttributeHints(page: Page, hints: string[]) {
  const selector = hints
    .map((hint) => `input[name*="${hint}" i], input[id*="${hint}" i], input[placeholder*="${hint}" i]`)
    .join(', ');
  return page.locator(selector).first();
}

/**
 * Runs the Internal Accounts workflow on an already-logged-in page (i.e.
 * after loginToEcampus() has resolved, and typically after
 * runUploadPayroll() in a continuous session). Resets Report_Accounts.env
 * itself, so this is safe to call standalone or as a step in
 * scripts/runAllEcampus.ts.
 */
export async function runInternalAccounts(page: Page): Promise<void> {
  // Reset Report_Accounts.env at the start of every run, so it reflects only
  // this run's alerts instead of growing forever across repeated runs.
  fs.writeFileSync(REPORT_ENV_PATH, '');

  // -------------------------------------------------------------------
  // Accounts navigation
  // -------------------------------------------------------------------
  // Same "rail-link" / href-based selector already proven reliable for the
  // "Upload" nav link in the other scripts — avoids matching by accessible
  // name/text, which failed here with exact: true (likely a leading space
  // or icon in the real link's text, the same root cause behind the earlier
  // "Upload" selector bug). Unlike the steps below, no fallback alert was
  // specified for this first click, so — consistent with the primary nav
  // clicks in the other scripts — it's treated as a real/structural failure
  // (throws) rather than a soft alert.
  const accountsNavLink = page.locator('a.rail-link[href$="/m-accounts"]').first();
  await accountsNavLink.click();
  await safeWaitForURL(page, /\/m-accounts$/, 'accounts page');

  // NOTE: starting-point selectors for the four Accounts tabs — inspect the
  // real page and adjust if these aren't plain text links/tabs.
  const externalAccountsTab = page.getByText('External Accounts', { exact: true });
  await tryStep(async () => {
    await externalAccountsTab.click();
    await safeWaitForURL(page, /\/m-accounts\?tab=external/, 'external accounts tab');
  }, 'External Accounts link is not properly loaded.');

  const accountGroupTab = page.getByText('Account Groups', { exact: true });
  await tryStep(async () => {
    await accountGroupTab.click();
    await safeWaitForURL(page, /\/m-accounts\?tab=groups/, 'account group tab');
  }, 'Account Group link is not properly loaded.');

  const accountsSupportGroupTab = page.getByText('Account Sub Groups', { exact: true });
  await tryStep(async () => {
    await accountsSupportGroupTab.click();
    await safeWaitForURL(page, /\/m-accounts\?tab=subgroups/, 'accounts support group tab');
  }, 'Accounts Support Group link is not properly loaded.');

  const internalAccountsTab = page.getByText('Internal Accounts', { exact: true });
  await tryStep(async () => {
    await internalAccountsTab.click();
    // Observed live: returning to this tab lands on "?tab=internal" (unlike
    // the very first landing on Accounts, which has no query string at all).
    await safeWaitForURL(page, /\/m-accounts\?tab=internal/, 'internal accounts tab');
  }, 'Internal Accounts page is not properly loaded.');

  // -------------------------------------------------------------------
  // Create a sample Internal Account
  // -------------------------------------------------------------------
  // NOTE: starting-point selectors for the Search/Type Group and Select Sub
  // Group dropdowns — assumed to be Select2 widgets, same convention as
  // "Select Subs" in scripts/ecampusUploadPO.ts / scripts/ecampusUploadVCC.ts.
  const searchGroupDropdown = page
    .locator('span.select2-container')
    .filter({ hasText: /search.*group|type.*group/i })
    .first();
  await tryStep(
    () => selectSelect2Option(page, searchGroupDropdown, GROUP_VALUE),
    'Account Group could not be selected.'
  );

  const selectSubGroupDropdown = page
    .locator('span.select2-container')
    .filter({ hasText: /select sub group/i })
    .first();
  await tryStep(
    () => selectSelect2Option(page, selectSubGroupDropdown),
    'Account Sub Group could not be selected.'
  );

  // NOTE: starting-point selectors for the plain text fields, matched by
  // name/id/placeholder attribute hints (see fieldByAttributeHints() doc
  // comment above for why) — inspect the real page and adjust the hints per
  // field if this matches the wrong element or nothing at all. Each is
  // explicitly clicked before filling, to ensure the automation is actually
  // interacting with the intended textbox rather than just programmatically
  // setting its value.
  const fundField = fieldByAttributeHints(page, ['fund']);
  await tryStep(async () => {
    await fundField.click();
    await fundField.fill(FUND);
  }, 'Could not enter the Fund number.');

  const departmentField = fieldByAttributeHints(page, ['department', 'dept']);
  await tryStep(async () => {
    await departmentField.click();
    await departmentField.fill(DEPARTMENT);
  }, 'Could not enter the Department number.');

  const subsidiaryField = fieldByAttributeHints(page, ['subsidiary', 'subsid']);
  await tryStep(async () => {
    await subsidiaryField.click();
    await subsidiaryField.fill(SUBSIDIARY);
  }, 'Could not enter the Subsidiary number.');

  // .fill() replaces the field's existing content entirely, so no separate
  // "clear first" step is needed for the Object Class/Object Code fields.
  const objectClassField = fieldByAttributeHints(page, ['object_class', 'objectclass', 'objclass']);
  await tryStep(async () => {
    await objectClassField.click();
    await objectClassField.fill(OBJECT_CLASS);
  }, 'Could not enter the Object Class.');

  const objectCodeField = fieldByAttributeHints(page, ['object_code', 'objectcode', 'objcode']);
  await tryStep(async () => {
    await objectCodeField.click();
    await objectCodeField.fill(OBJECT_CODE);
  }, 'Could not enter the Object Code.');

  const descriptionField = fieldByAttributeHints(page, ['description', 'desc']);
  await descriptionField.click();
  await descriptionField.fill(DESCRIPTION);

  const addAccountButton = page.getByRole('button', { name: 'Add Account' });
  await addAccountButton.click();

  // Verify the newly created row in "Internal Master Accounts" matches what
  // was entered. NOTE: starting-point selector — assumes the section can be
  // found by its heading text, and the newest row is the first one; inspect
  // the real page and adjust.
  await tryStep(async () => {
    const masterAccountsSection = page.getByText('Internal Master Accounts', { exact: false }).first();
    await masterAccountsSection.scrollIntoViewIfNeeded();

    const createdRow = page.locator('tr').filter({ hasText: EXPECTED_ACCOUNT_CODE }).first();
    await createdRow.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });

    const rowText = await createdRow.innerText();
    const expectedFragments = [EXPECTED_ACCOUNT_CODE, DESCRIPTION, GROUP_VALUE, FUND, DEPARTMENT, SUBSIDIARY];
    const allPresent = expectedFragments.every((fragment) => rowText.includes(fragment));
    if (!allPresent) {
      throw new Error(`Created row text "${rowText}" did not contain all expected values`);
    }
  }, 'The created Internal Account details do not match the values entered during account creation.');

  // -------------------------------------------------------------------
  // Import Accounts
  // -------------------------------------------------------------------
  // NOTE: starting-point selectors — inspect the real page and adjust.
  const importAccountsSection = page.getByText('Import Accounts', { exact: false }).first();
  await importAccountsSection.scrollIntoViewIfNeeded();

  const sampleLink = page.getByText('Sample', { exact: true });
  const [sampleDownload] = await Promise.all([page.waitForEvent('download'), sampleLink.click()]);
  const sampleExt = path.extname(sampleDownload.suggestedFilename()) || '.csv';
  const samplePath = path.resolve('reports', `downloaded_accounts_sample${sampleExt}`);
  await sampleDownload.saveAs(samplePath);

  const chooseFileInput = page.locator('input[type="file"]').first();
  await chooseFileInput.waitFor({ state: 'attached', timeout: DEFAULT_TIMEOUT });
  await chooseFileInput.setInputFiles(samplePath);

  const importButton = page.getByRole('button', { name: 'Import' });
  const importStart = Date.now();
  await importButton.click();

  // NOTE: no specific "import complete" signal was given — this is a
  // best-effort wait for a success-ish message, generous but non-fatal if
  // it's never found (the measured duration below is still recorded either
  // way, just possibly including extra wait time if this guess is wrong).
  try {
    await page.getByText(/success|imported/i).first().waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
  } catch {
    console.warn('Could not detect an explicit import-completion message — measuring elapsed time regardless.');
  }

  // Always record the import duration, per the spec's "measure the total
  // time taken... Record the import time" instruction.
  const importDurationMs = Date.now() - importStart;
  appendReportAlert(`Import duration: ${importDurationMs}ms`);
  if (importDurationMs > IMPORT_TIME_THRESHOLD_MS) {
    const alertMessage = 'Import action is taking more than 3 seconds.';
    console.warn(`⚠️ ${alertMessage} (${importDurationMs}ms)`);
    appendReportAlert(alertMessage);
  }

  console.log('\n✅ Internal Accounts workflow completed.');
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
    await runInternalAccounts(page);
    await browser.close();
  } finally {
    if (browser.isConnected()) {
      await browser.close();
    }
  }
}

// Only auto-run when this file is executed directly — NOT when
// runInternalAccounts is imported by scripts/runAllEcampus.ts, which would
// otherwise launch an extra, unwanted browser window per import.
if (require.main === module) {
  main().catch((err) => {
    console.error('Internal Accounts workflow failed:', err);
    process.exit(1);
  });
}
