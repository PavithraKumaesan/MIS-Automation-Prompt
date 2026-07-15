/**
 * Shared login/session helpers for the eCampusBuddy automation scripts.
 *
 * Used two ways:
 *  - Standalone (npm run reconcile:ecampus / upload-vcc:ecampus / etc.): each
 *    script's own main() launches its own browser, calls loginToEcampus()
 *    once, then runs its own workflow — unchanged behavior from before.
 *  - Continuous session (npm run run-all:ecampus, scripts/runAllEcampus.ts):
 *    ONE browser + ONE loginToEcampus() call (one captcha solve) is shared
 *    across all four workflows, run back-to-back on the same page. Each
 *    workflow function (runUploadPO, runUploadVCC, runUploadTrialBalance,
 *    runUploadPayroll) starts by clicking the "Upload" left-nav link
 *    directly, rather than assuming it's starting from the dashboard — that
 *    link is expected to be present in the persistent left-side navigation
 *    regardless of which page a prior workflow ended on, so no dashboard
 *    revisit is needed between workflows.
 */

import { Page } from 'playwright';
import readline from 'readline';

export const LOGIN_URL = 'https://forms.ecampusbuddy.com/index.php/m-welcome';
const POST_SIGNIN_LOAD_TIMEOUT = 5000;

export function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

/** Wraps page.waitForURL with a clearer error message on timeout, including the URL actually reached. */
export async function safeWaitForURL(page: Page, urlPattern: string | RegExp, description: string, timeout = 20000) {
  try {
    await page.waitForURL(urlPattern, { timeout });
  } catch (err) {
    throw new Error(
      `Timed out waiting for URL to reach "${description}" (pattern: ${urlPattern}). ` +
        `Current URL is "${page.url()}". Original error: ${(err as Error).message}`
    );
  }
}

/**
 * Logs into eCampusBuddy: navigates to the login page, fills credentials
 * from ECAMPUS_USERNAME/ECAMPUS_PASSWORD, pauses for you to solve the
 * captcha manually (readline — `await page.pause()` right after the click
 * below is the Playwright Inspector alternative), clicks Sign In, and waits
 * for the dashboard to load. Leaves `page` on m-dashboard when it resolves.
 *
 * onAlert, if provided, receives the post-signin "page took > 5s to load"
 * alert message so the caller can log it to its own report file — standalone
 * scripts pass their own appendReportAlert; the continuous-session runner
 * passes nothing (console-only), since that alert isn't tied to any single
 * workflow's report when login only happens once for the whole session.
 */
export async function loginToEcampus(page: Page, onAlert?: (message: string) => void): Promise<void> {
  const username = process.env.ECAMPUS_USERNAME;
  const password = process.env.ECAMPUS_PASSWORD;

  if (!username || !password) {
    throw new Error('Missing credentials. Set ECAMPUS_USERNAME and ECAMPUS_PASSWORD in your .env file.');
  }

  await page.goto(LOGIN_URL);

  // NOTE: starting-point selectors — inspect the real page (right-click ->
  // Inspect) and adjust if the markup differs.
  const usernameField = page.locator('input[type="email"], input[name="email"], input[name="username"]').first();
  const passwordField = page.locator('input[type="password"]').first();
  const signInButton = page.locator('button:has-text("Sign In"), button:has-text("Secure Sign In")').first();

  await usernameField.fill(username);
  await passwordField.fill(password);

  console.log('\nCredentials filled in.');
  console.log('Please solve the captcha manually in the browser window that just opened.');
  console.log('Once the captcha is solved, come back here and press Enter to continue.');
  console.log(
    '\n(Alternative: instead of the readline prompt below, you could call ' +
      '`await page.pause()` right here to drop into the Playwright Inspector, ' +
      'solve the captcha, then click "Resume" in the Inspector toolbar.)\n'
  );
  await waitForEnter('Press Enter once the captcha is solved to continue login... ');

  await signInButton.click();

  // Soft, non-fatal check: if the page hasn't finished loading within 5
  // seconds of clicking Sign In, log an alert and keep going regardless —
  // this must never throw or stop the script. The actual dashboard
  // navigation is still awaited normally right after, with its own real
  // error handling.
  try {
    await page.waitForLoadState('load', { timeout: POST_SIGNIN_LOAD_TIMEOUT });
  } catch {
    const alertMessage = 'Page loading is   taking more than 5 seconds.';
    console.warn(`⚠️ ${alertMessage}`);
    onAlert?.(alertMessage);
  }

  await safeWaitForURL(page, /\/m-dashboard/, 'dashboard page');
}
