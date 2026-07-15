/**
 * Test case 7 — Budget.
 *
 * Runs after Trial Balance revisit (test case 6, scripts/ecampusTrialBalanceRevisit.ts)
 * on the same logged-in page, per spec: "do not end the automation... continue
 * with the Budget module."
 *
 * Almost every step here is an independent, non-fatal validation per the
 * spec's closing instruction ("do not stop or fail the automation if any
 * validation fails... log the appropriate alert message and continue"). Each
 * such step is wrapped in tryStep() below: on failure, it logs the exact
 * alert message given in the spec to Report_Budget.env and moves on. Only
 * the two primary nav-type clicks with no specified fallback message
 * ("Budget" itself, and "Detailed Listing") are treated as real/structural
 * failures that throw, matching the convention used in the other scripts.
 *
 * NOTE: this page (budgetDeptChart / Spend Distribution DoughnutChart,
 * Department Breakdown, Detailed Listing, Import Budget Data, Budget
 * Allocation Records) has no existing precedent anywhere else in this
 * project — every selector below is a best-effort starting-point guess.
 *
 * Chart-change detection (budgetDeptChart, DoughnutChart) doesn't assume any
 * particular charting library exposes its data via a global JS variable —
 * instead it screenshots the chart's <canvas> element before and after
 * selecting a filter and compares the two images. This is framework-agnostic
 * but coarse: a chart that re-renders with visually identical output would
 * be a false negative. NOTE: if a global Chart.js instance (or similar) is
 * confirmed to exist on the real page, comparing its .data via page.evaluate()
 * would be more precise — swap this out once you've inspected the live page.
 *
 * The spec asked for alerts to be logged directly into Report_Consolidated.md,
 * but that file is fully regenerated (overwritten) by
 * scripts/consolidateReports.ts every time it runs, so writing into it
 * directly here would just get clobbered the next time the run-all
 * orchestrator calls the consolidation step. Instead this uses its own
 * Report_Budget.env, matching the Report_PO.env / Report_VCC.env / etc.
 * convention, added as a section in consolidateReports.ts — so its content
 * still ends up in Report_Consolidated.md, just without the clobbering risk.
 *
 * Run with:
 *   npm run budget:ecampus
 * or:
 *   npx tsx scripts/ecampusBudget.ts
 */

import { chromium, Page } from 'playwright';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { loginToEcampus, safeWaitForURL } from './ecampusSession';

dotenv.config();

const REPORT_ENV_PATH = path.resolve('Report_Budget.env');
const DEFAULT_TIMEOUT = 20000;
const UPLOAD_TIME_THRESHOLD_MS = 2000;
const ALL_DROPDOWN_CLICKABLE_THRESHOLD_MS = 1000;
const ALL_DROPDOWN_VALUE = '2000';

/** Appends a timestamped alert line to Report_Budget.env — never throws, so a logging failure can't itself break the run. */
function appendReportAlert(message: string) {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(REPORT_ENV_PATH, line);
  } catch (err) {
    console.error(`Failed to write alert to ${REPORT_ENV_PATH}: ${(err as Error).message}`);
  }
}

/**
 * Runs `action`; on any failure, logs `failureAlert` (console + Report_Budget.env)
 * and swallows the error, so the caller always continues to the next step —
 * this is the "if X fails, log alert Y, continue" pattern that almost every
 * step in this module follows.
 */
async function tryStep(action: () => Promise<void>, failureAlert: string): Promise<void> {
  try {
    await action();
  } catch (err) {
    console.warn(`⚠️ ${failureAlert} (${(err as Error).message})`);
    appendReportAlert(failureAlert);
  }
}

/** Opens a Select2-style dropdown and clicks the option matching `optionText`. Same convention as scripts/ecampusInternalAccounts.ts. */
async function selectSelect2Option(page: Page, trigger: ReturnType<Page['locator']>, optionText: string): Promise<void> {
  await trigger.click();
  const openDropdown = page.locator('.select2-container--open .select2-results__options');
  await openDropdown.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });

  const option = openDropdown
    .locator('li.select2-results__option:not(.select2-results__option--disabled):not([aria-disabled="true"])')
    .filter({ hasNotText: /no results found/i })
    .filter({ hasText: optionText })
    .first();
  await option.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
  await option.click();
}

/**
 * Selects `optionText` from the "All" filter dropdown, trying a native
 * <select> first before falling back to the Select2-style interaction used
 * elsewhere on this site.
 *
 * Checks VISIBILITY, not just existence, before choosing the native-select
 * path — Select2 (used elsewhere on this site) commonly HIDES the original
 * native <select> and builds a separate custom UI on top of it. An
 * existence-only check (.count() > 0) would still find that hidden native
 * element and try to .selectOption() on it, which times out/throws because
 * a hidden element is never actionable — even if the real, visible widget
 * (the Select2 UI) would have worked fine via the fallback path below.
 */
async function selectAllDropdownOption(page: Page, optionText: string): Promise<void> {
  const nativeSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'All' }) }).first();
  if (await nativeSelect.isVisible().catch(() => false)) {
    await nativeSelect.selectOption({ label: optionText });
    return;
  }

  const select2Dropdown = page.locator('span.select2-container').filter({ hasText: /^all$/i }).first();
  await selectSelect2Option(page, select2Dropdown, optionText);
}

/**
 * Polls (every 100ms) until whichever "All" dropdown trigger actually exists
 * on the page — native <select> or the Select2 span — becomes visible, i.e.
 * clickable. Used to time how long the dropdown takes to become interactive,
 * per the spec's "measure the time... for the All dropdown to become
 * clickable" requirement, kept separate from selectAllDropdownOption() (which
 * performs the actual selection) so the timing reflects only the wait, not
 * the click/selection itself.
 */
async function waitForAllDropdownClickable(page: Page, timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
  const nativeSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'All' }) }).first();
  const select2Dropdown = page.locator('span.select2-container').filter({ hasText: /^all$/i }).first();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await nativeSelect.isVisible().catch(() => false)) return;
    if (await select2Dropdown.isVisible().catch(() => false)) return;
    await page.waitForTimeout(100);
  }
  throw new Error('All dropdown never became visible/clickable');
}

/**
 * Snapshots a <canvas> element's current state as a comparable string, or
 * null if it can't be found/read — used to detect whether a chart changed.
 *
 * Prefers the underlying Chart.js instance's actual .data (via the
 * Chart.getChart() static helper Chart.js v3+ exposes) over a raw pixel
 * snapshot, when available — a pixel snapshot has been observed in practice
 * to occasionally come back byte-identical for two frames that are visually
 * different on screen (animation/render timing artifacts), producing a
 * false "chart is not changed" alert even though the chart genuinely
 * updated. Comparing the chart's actual dataset values sidesteps that
 * entirely, since it's a direct, timing-independent signal. Falls back to
 * toDataURL() if Chart.js (or a chart instance bound to this canvas) isn't
 * exposed on window — so this still works for any charting library.
 *
 * visibleTimeout defaults to the full DEFAULT_TIMEOUT for the initial
 * "before" capture (the chart may still be on its first render), but
 * waitForCanvasChange() below passes a much shorter timeout per poll
 * attempt, since by then the canvas has already been visible once — there's
 * no reason to wait up to 20s on every single poll iteration.
 */
async function captureCanvasSnapshot(page: Page, canvasSelector: string, visibleTimeout = DEFAULT_TIMEOUT): Promise<string | null> {
  try {
    const canvas = page.locator(canvasSelector).first();
    await canvas.waitFor({ state: 'visible', timeout: visibleTimeout });
    return await canvas.evaluate((el) => {
      const canvasEl = el as HTMLCanvasElement;
      const chartInstance = (window as any).Chart?.getChart?.(canvasEl);
      if (chartInstance && chartInstance.data) {
        try {
          return 'chartdata:' + JSON.stringify(chartInstance.data);
        } catch {
          // not serializable — fall through to a pixel snapshot instead
        }
      }
      return 'pixels:' + canvasEl.toDataURL();
    });
  } catch {
    return null;
  }
}

/**
 * Captures a <canvas> snapshot only once it's "stable" — i.e. two
 * consecutive captures a short interval apart are identical — rather than a
 * single immediate capture. Used for the "before" baseline: if the chart is
 * still mid-animation on its initial render when captured, that
 * transitional (possibly blank/partial) frame becomes the baseline, and a
 * later "after" capture landing on a similarly-transitional frame can
 * coincidentally match it, producing a false "did not change" result even
 * though the chart is genuinely updating. Bounded by maxWaitMs so a chart
 * that never settles doesn't hang the run — falls back to the last capture.
 */
async function captureStableCanvasSnapshot(
  page: Page,
  canvasSelector: string,
  maxWaitMs = 4000,
  pollIntervalMs = 300
): Promise<string | null> {
  const deadline = Date.now() + maxWaitMs;
  let previous = await captureCanvasSnapshot(page, canvasSelector);
  while (Date.now() < deadline) {
    await page.waitForTimeout(pollIntervalMs);
    const current = await captureCanvasSnapshot(page, canvasSelector, 1000);
    if (current !== null && current === previous) {
      return current; // two consecutive matches — settled
    }
    previous = current;
  }
  return previous;
}

/**
 * Polls a chart's <canvas> every pollIntervalMs (fast: 250ms) until its
 * image differs from `beforeSnapshot`, returning as soon as a change is
 * detected — rather than a single immediate check right after the filter
 * is applied, which can false-negative if the chart's data fetch/animation
 * hasn't finished yet. Capped at maxWaitMs total so a genuinely unchanged
 * (or broken) chart doesn't hang the run; still much shorter than
 * DEFAULT_TIMEOUT since a real update is expected to land within a few
 * seconds, not 20.
 */
async function waitForCanvasChange(
  page: Page,
  canvasSelector: string,
  beforeSnapshot: string | null,
  maxWaitMs = 12000,
  pollIntervalMs = 250
): Promise<string | null> {
  if (beforeSnapshot === null) {
    return captureCanvasSnapshot(page, canvasSelector, 3000);
  }
  const deadline = Date.now() + maxWaitMs;
  let lastSnapshot: string | null = null;
  while (Date.now() < deadline) {
    lastSnapshot = await captureCanvasSnapshot(page, canvasSelector, 1000);
    if (lastSnapshot !== null && lastSnapshot !== beforeSnapshot) {
      return lastSnapshot; // changed — exit immediately, no further waiting
    }
    await page.waitForTimeout(pollIntervalMs);
  }
  return lastSnapshot;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Runs `clickAction`, then verifies the given chart canvas changed as a
 * result — comparing actual before/after snapshots (via
 * captureStableCanvasSnapshot / waitForCanvasChange) rather than a fixed
 * wait, since the chart refresh can take a variable amount of time.
 *
 * The click and the chart-change check are two SEPARATE failure modes with
 * two separate alerts: if `clickAction` itself never completes (e.g. the
 * button locator times out), `clickFailureAlert` is logged and the
 * chart-change check is skipped entirely — logging `notChangedAlert` in that
 * case would be misleading, since "the chart didn't change" implies the
 * button action actually happened, which it didn't.
 */
async function verifyChartChangesAfterAction(
  page: Page,
  chartSelector: string,
  clickAction: () => Promise<void>,
  clickFailureAlert: string,
  notChangedAlert: string
): Promise<void> {
  const before = await captureStableCanvasSnapshot(page, chartSelector);

  let clicked = false;
  await tryStep(async () => {
    await clickAction();
    clicked = true;
  }, clickFailureAlert);

  if (!clicked) {
    return;
  }

  await tryStep(async () => {
    if (before === null) {
      throw new Error(`Could not locate the chart canvas at all via "${chartSelector}" — check the selector against the real page`);
    }
    const after = await waitForCanvasChange(page, chartSelector, before);
    if (after === null) {
      throw new Error('Chart canvas disappeared after the action');
    }
    if (before === after) {
      throw new Error('Chart canvas image is identical before and after the action');
    }
  }, notChangedAlert);
}

/**
 * Verifies every text in `expectedTexts` is visible somewhere on the page;
 * throws (for tryStep to catch) listing whichever are missing.
 *
 * Matches case-insensitively — { exact: false } alone only relaxes
 * whitespace, not case, and column headers here are quite likely rendered
 * all-caps via CSS text-transform (the same issue already hit and fixed for
 * the "ACTIONS" column header in scripts/ecampusTrialBalanceRevisit.ts),
 * which a plain case-sensitive substring match would never match.
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
 * Same as verifyAllVisible(), but scoped to a specific container Locator
 * instead of searching the whole page. Needed for column labels like
 * "-20%"/"-15%"/"-10%" under Budget Allocation Records, which are also used
 * verbatim as the simulation buttons' labels earlier on this same page —
 * a page-wide getByText().first() there can resolve to one of those buttons
 * instead of the actual table header, and report "not visible" if that
 * button happens to be hidden/removed at that point in the flow, even though
 * the real table header is visible further down the page.
 */
async function verifyAllVisibleWithin(container: ReturnType<Page['locator']>, expectedTexts: string[]): Promise<void> {
  const missing: string[] = [];
  for (const text of expectedTexts) {
    const isVisible = await container.getByText(new RegExp(escapeRegExp(text), 'i')).first().isVisible().catch(() => false);
    if (!isVisible) missing.push(text);
  }
  if (missing.length > 0) {
    throw new Error(`Missing: ${missing.join(', ')}`);
  }
}

/**
 * Runs the Budget workflow on an already-logged-in page (i.e. after
 * loginToEcampus() has resolved, and typically after
 * runTrialBalanceRevisit() in a continuous session). Resets
 * Report_Budget.env itself, so this is safe to call standalone or as a step
 * in scripts/runAllEcampus.ts.
 */
export async function runBudget(page: Page): Promise<void> {
  // Reset Report_Budget.env at the start of every run, so it reflects only
  // this run's alerts instead of growing forever across repeated runs.
  fs.writeFileSync(REPORT_ENV_PATH, '');

  // -------------------------------------------------------------------
  // Budget navigation
  // -------------------------------------------------------------------
  // Same "rail-link" / href-based selector already proven reliable for the
  // "Upload"/"Trial Balance" nav links in the other scripts — avoids
  // matching by accessible name/text, which has repeatedly turned out to be
  // unreliable on this app's left-nav (leading spaces/icons in the real
  // text). No fallback alert was specified for this click, so it's treated
  // as a real/structural failure (throws), consistent with primary nav
  // elsewhere.
  const budgetNavLink = page.locator('a.rail-link[href$="/m-budget"]').first();
  await budgetNavLink.click();
  await safeWaitForURL(page, /\/m-budget$/, 'budget page');

  // -------------------------------------------------------------------
  // Filter by cost center and verify both charts update
  // -------------------------------------------------------------------
  // NOTE: canvas element ids are guesses based on the JS variable names
  // given in the spec ("budgetDeptChart", "DoughnutChart") — inspect the
  // real page and adjust if the <canvas> id differs from its chart variable
  // name.
  const budgetDeptChartSelector = '#budgetDeptChart';
  // Confirmed via live page inspection: the Spend Distribution doughnut
  // chart's actual canvas id is "spendDoughnutChart", not "DoughnutChart"
  // (the earlier guess based on the spec's JS variable name) — the alert
  // text itself still says "DoughnutChart" per the spec's exact wording.
  const doughnutChartSelector = '#spendDoughnutChart';

  // Captured via captureStableCanvasSnapshot (waits for two consecutive
  // identical frames), not a single immediate capture — a chart that's still
  // mid-animation on its first render would otherwise be baselined on a
  // transitional frame, which a later "after" capture landing on a similarly
  // transitional frame could coincidentally match, producing a false
  // "not changed" result even though the chart genuinely updates.
  const budgetDeptChartBefore = await captureStableCanvasSnapshot(page, budgetDeptChartSelector);
  const doughnutChartBefore = await captureStableCanvasSnapshot(page, doughnutChartSelector);

  // Time how long the "All" dropdown takes to become clickable, always
  // recording the duration; alert only if it exceeds the 1-second threshold.
  // Kept as its own tryStep/timing block, separate from the actual selection
  // below, so a slow-but-successful dropdown is measured accurately.
  const allDropdownWaitStart = Date.now();
  await tryStep(async () => {
    await waitForAllDropdownClickable(page);
    const clickableDurationMs = Date.now() - allDropdownWaitStart;
    appendReportAlert(`All dropdown became clickable in: ${clickableDurationMs}ms`);
    if (clickableDurationMs > ALL_DROPDOWN_CLICKABLE_THRESHOLD_MS) {
      appendReportAlert('All dropdown is taking more than 1 second to become clickable.');
    }
  }, 'All dropdown never became clickable.');

  await tryStep(
    () => selectAllDropdownOption(page, ALL_DROPDOWN_VALUE),
    'Could not select 2000 from the All dropdown.'
  );

  // NOTE: these throw distinct messages for "never found the canvas at all"
  // (almost certainly a wrong #budgetDeptChart/#DoughnutChart selector guess
  // — inspect the real page for the actual id/class) vs. "found it both
  // times but the image is identical" (a genuine no-change finding) — the
  // previous version conflated both cases under "is not changed", which
  // meant a wrong selector guess would always report "not changed" even if
  // the chart was visibly updating correctly.
  await tryStep(async () => {
    if (budgetDeptChartBefore === null) {
      throw new Error(`Could not locate the budgetDeptChart canvas at all via "${budgetDeptChartSelector}" — check the selector against the real page`);
    }
    const budgetDeptChartAfter = await waitForCanvasChange(page, budgetDeptChartSelector, budgetDeptChartBefore);
    if (budgetDeptChartAfter === null) {
      throw new Error('budgetDeptChart canvas disappeared after selecting 2000');
    }
    if (budgetDeptChartBefore === budgetDeptChartAfter) {
      throw new Error('budgetDeptChart canvas image is identical before and after selecting 2000');
    }
  }, 'budgetDeptChart is not changed.');

  await tryStep(async () => {
    if (doughnutChartBefore === null) {
      throw new Error(`Could not locate the DoughnutChart canvas at all via "${doughnutChartSelector}" — check the selector against the real page`);
    }
    const doughnutChartAfter = await waitForCanvasChange(page, doughnutChartSelector, doughnutChartBefore);
    if (doughnutChartAfter === null) {
      throw new Error('DoughnutChart canvas disappeared after selecting 2000');
    }
    if (doughnutChartBefore === doughnutChartAfter) {
      throw new Error('DoughnutChart canvas image is identical before and after selecting 2000');
    }
  }, 'DoughnutChart is not changed.');

  // -------------------------------------------------------------------
  // Budget simulation controls (-20% / -15% / -10% / resetSimulation / Reset)
  // -------------------------------------------------------------------
  // NOTE: best-effort selectors (no live DOM access). The percentage buttons
  // are scoped to role="button" so they don't collide with the identically
  // labeled "-20%"/"-15%"/"-10%" column headers further down in the Budget
  // Allocation Records table (those are matched via getByText, not button
  // role, in verifyAllVisible() below). resetSimulation is targeted by its
  // onclick handler name — the same convention already proven reliable for
  // the Delete button in scripts/ecampusTrialBalanceRevisit.ts
  // (button[onclick*="..."]) since a click-handler name is more stable than
  // accessible text — with a text-based fallback via .or() in case the
  // button doesn't actually carry that onclick attribute. The plain "Reset"
  // control is confirmed via live markup to be an <a> link, not a <button>
  // — `<a href="https://forms.ecampusbuddy.com/index.php/m-budget" class="btn btn-sm">Reset</a>`
  // — so getByRole('button', ...) could never match it regardless of the
  // name filter; targeted by its class + href instead, same DOM-structure
  // convention already proven reliable elsewhere in this project.
  const simulationButton = (text: string) => page.getByRole('button', { name: new RegExp(escapeRegExp(text), 'i') }).first();

  await verifyChartChangesAfterAction(
    page,
    budgetDeptChartSelector,
    () => simulationButton('-20%').click(),
    'Could not click the -20% button.',
    'budgetDeptChart is not changed after selecting -20%.'
  );

  await verifyChartChangesAfterAction(
    page,
    budgetDeptChartSelector,
    () => simulationButton('-15%').click(),
    'Could not click the -15% button.',
    'budgetDeptChart is not changed after selecting -15%.'
  );

  await verifyChartChangesAfterAction(
    page,
    budgetDeptChartSelector,
    () => simulationButton('-10%').click(),
    'Could not click the -10% button.',
    'budgetDeptChart is not changed after selecting -10%.'
  );

  const resetSimulationButton = page
    .locator('button[onclick*="resetSimulation" i]')
    .or(simulationButton('Reset Simulation'))
    .first();
  await verifyChartChangesAfterAction(
    page,
    budgetDeptChartSelector,
    () => resetSimulationButton.click(),
    'Could not click the resetSimulation button.',
    'budgetDeptChart is not changed after resetSimulation.'
  );

  const resetButton = page
    .locator('a.btn.btn-sm[href$="/m-budget"]')
    .filter({ hasText: /^reset$/i })
    .first();
  await verifyChartChangesAfterAction(
    page,
    budgetDeptChartSelector,
    () => resetButton.click(),
    'Could not click the Reset button.',
    'budgetDeptChart is not changed after Reset.'
  );

  // -------------------------------------------------------------------
  // Department Breakdown
  // -------------------------------------------------------------------
  await tryStep(async () => {
    const departmentBreakdownSection = page.getByText('Department Breakdown', { exact: false }).first();
    await departmentBreakdownSection.scrollIntoViewIfNeeded();
    await departmentBreakdownSection.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
    await verifyAllVisible(page, ['COST CENTER', 'BUDGETED', 'ACTUAL SPENT', 'VARIANCE', 'UTILIZATION']);
  }, 'Department Breakdown section is not visible.');

  // -------------------------------------------------------------------
  // Detailed Listing
  // -------------------------------------------------------------------
  await page.evaluate(() => window.scrollTo(0, 0));

  // No fallback alert was specified for this click, so — consistent with
  // the Budget nav click above — it's treated as a real/structural failure.
  // NOTE: starting-point selector — inspect the real page and adjust.
  const detailedListingLink = page.getByText('Detailed Listing', { exact: true });
  await detailedListingLink.click();
  await safeWaitForURL(page, /\/m-budget\/listing/, 'budget detailed listing page');

  // NOTE: starting-point selector for the year dropdown shown in the
  // listing header — inspect the real page and adjust.
  const listingYearDropdown = page.locator('span.select2-container').filter({ hasText: /fy-2025/i }).first();
  await tryStep(async () => {
    await listingYearDropdown.click();
    const openDropdown = page.locator('.select2-container--open .select2-results__options');
    await openDropdown.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
    // Close it again without selecting anything — this step only verifies
    // the options are displayed, per the spec.
    await page.keyboard.press('Escape');
  }, 'Year options are not visible.');

  // -------------------------------------------------------------------
  // Import Budget Data
  // -------------------------------------------------------------------
  // NOTE: starting-point selector — inspect the real page and adjust.
  const importBudgetDataButton = page.getByText('Import Budget Data', { exact: true });
  await importBudgetDataButton.click();

  await tryStep(
    () => verifyAllVisible(page, ['Financial Year', 'Select CSV / Excel File']),
    'Import Budget Data sections are not visible.'
  );

  let sampleCsvPath: string | null = null;
  await tryStep(async () => {
    const sampleLink = page.getByText('Sample', { exact: true });
    const [download] = await Promise.all([page.waitForEvent('download'), sampleLink.click()]);
    const ext = path.extname(download.suggestedFilename()) || '.csv';
    sampleCsvPath = path.resolve('reports', `downloaded_budget_sample${ext}`);
    await download.saveAs(sampleCsvPath);
  }, 'Sample CSV file is not downloading.');

  // NOTE: assumed to be a second, distinct dropdown within the Import
  // Budget Data section (as opposed to listingYearDropdown above) — inspect
  // the real page and adjust if it's actually the same element.
  const importYearDropdown = page.locator('span.select2-container').filter({ hasText: /fy-2025/i }).last();
  await tryStep(async () => {
    await importYearDropdown.click();
    const openDropdown = page.locator('.select2-container--open .select2-results__options');
    await openDropdown.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
    await page.keyboard.press('Escape');
  }, 'FY-2025 year options are not visible.');

  // -------------------------------------------------------------------
  // Upload the sample CSV
  // -------------------------------------------------------------------
  if (sampleCsvPath) {
    const chooseFileInput = page.locator('input[type="file"]').first();
    await chooseFileInput.waitFor({ state: 'attached', timeout: DEFAULT_TIMEOUT });
    await chooseFileInput.setInputFiles(sampleCsvPath);

    // Broadened to a case-insensitive substring match rather than exact —
    // exact: true has repeatedly failed elsewhere in this project for
    // "Upload"-labeled buttons/links (likely a leading space or icon in the
    // real accessible name).
    const uploadButton = page.getByRole('button', { name: /upload/i }).first();
    const uploadStart = Date.now();
    await uploadButton.click();

    // Exact success message given in the spec, matched with a substring
    // regex so a different duplicate-row count doesn't break the match.
    try {
      await page.getByText(/CSV uploaded successfully/i).first().waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
    } catch (err) {
      console.warn(`Could not detect the CSV upload success message: ${(err as Error).message}`);
    }

    // Always record the upload duration, per the spec's "Measure the total
    // upload time and record it" instruction.
    const uploadDurationMs = Date.now() - uploadStart;
    appendReportAlert(`Budget CSV upload duration: ${uploadDurationMs}ms`);
    if (uploadDurationMs > UPLOAD_TIME_THRESHOLD_MS) {
      const alertMessage = 'Uploading time is taking more than 2 seconds.';
      console.warn(`⚠️ ${alertMessage} (${uploadDurationMs}ms)`);
      appendReportAlert(alertMessage);
    }
  } else {
    console.warn('Skipping CSV upload — the sample file was never downloaded.');
  }

  // -------------------------------------------------------------------
  // Budget Allocation Records
  // -------------------------------------------------------------------
  // NOTE: starting-point selector — inspect the real page and adjust.
  const budgetAllocationRecordsSection = page.getByText('Budget Allocation Records', { exact: false }).first();
  await budgetAllocationRecordsSection.scrollIntoViewIfNeeded();

  // Scoped to the table immediately following the section heading (rather
  // than a page-wide search) — "-20%"/"-15%"/"-10%" are also the exact
  // labels used by the simulation buttons above, so a page-wide check could
  // wrongly match one of those buttons instead of the real column header.
  const budgetAllocationRecordsTable = budgetAllocationRecordsSection.locator('xpath=following::table[1]');

  await tryStep(
    () => verifyAllVisibleWithin(budgetAllocationRecordsTable, ['ID', 'COST CENTER', 'ORIGINAL TOTAL', '-20%', '-15%', '-10%', 'CREATED', 'ACTIONS']),
    'Required columns are not visible under Budget Allocation Records.'
  );

  console.log('\n✅ Budget workflow completed.');
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
    await runBudget(page);
    await browser.close();
  } finally {
    if (browser.isConnected()) {
      await browser.close();
    }
  }
}

// Only auto-run when this file is executed directly — NOT when runBudget is
// imported by scripts/runAllEcampus.ts, which would otherwise launch an
// extra, unwanted browser window per import.
if (require.main === module) {
  main().catch((err) => {
    console.error('Budget workflow failed:', err);
    process.exit(1);
  });
}
