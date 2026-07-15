/**
 * Runs all ten eCampusBuddy automation workflows back-to-back in a SINGLE
 * browser session:
 *   1. Upload PO             (runUploadPO, from scripts/ecampusUploadPO.ts)
 *   2. Upload VCC            (runUploadVCC, from scripts/ecampusUploadVCC.ts)
 *   3. Upload Trial Balance  (runUploadTrialBalance, from scripts/ecampusUploadTrialBalance.ts)
 *   4. Upload Payroll        (runUploadPayroll, from scripts/ecampusUploadPayroll.ts)
 *   5. Internal Accounts     (runInternalAccounts, from scripts/ecampusInternalAccounts.ts)
 *   6. Trial Balance revisit (runTrialBalanceRevisit, from scripts/ecampusTrialBalanceRevisit.ts)
 *   7. Budget                (runBudget, from scripts/ecampusBudget.ts)
 *   8. Financial Year        (runFinancialYear, from scripts/ecampusFinancialYear.ts)
 *   9. Reports               (runReports, from scripts/ecampusReports.ts)
 *  10. Audit Logs            (runAuditLogs, from scripts/ecampusAuditLogs.ts)
 *
 * Logs in exactly ONCE (one manual captcha solve) via loginToEcampus(), then
 * runs each workflow in turn on that same logged-in page — you are NOT
 * prompted to log in or solve a captcha again between workflows. Each
 * workflow starts by clicking the relevant left-nav link directly (present
 * regardless of which page the previous workflow ended on), rather than
 * returning to the dashboard first.
 *
 * If one workflow throws, it's logged and the runner moves on to the next
 * workflow in the same session anyway (they're independent, with
 * independent report files) — a failure in PO doesn't stop VCC/TB/Payroll/
 * Accounts/TB-revisit/Budget/Financial Year/Reports/Audit Logs from being
 * attempted. The browser closes once at the very end, and a summary of
 * which workflows succeeded/failed is printed.
 *
 * Once all ten have finished (regardless of outcome), automatically runs
 * scripts/consolidateReports.ts to merge Report_PO.env / Report_VCC.env /
 * Report_TB.env / Report_payroll.env / Report_Accounts.env /
 * Report_TB_Revisit.env / Report_Budget.env / Report_FinancialYear.env /
 * Report_Reports.env / Report_AuditLogs.env into Report_Consolidated.md.
 *
 * Run with:
 *   npm run run-all:ecampus
 * or:
 *   npx tsx scripts/runAllEcampus.ts
 *
 * To run only one of these — with its own independent login/captcha — use
 * its own script instead, e.g.:
 *   npm run upload-vcc:ecampus
 */

import { chromium, Page } from 'playwright';
import { spawnSync } from 'child_process';
import { loginToEcampus } from './ecampusSession';
import { runUploadPO } from './ecampusUploadPO';
import { runUploadVCC } from './ecampusUploadVCC';
import { runUploadTrialBalance } from './ecampusUploadTrialBalance';
import { runUploadPayroll } from './ecampusUploadPayroll';
import { runInternalAccounts } from './ecampusInternalAccounts';
import { runTrialBalanceRevisit } from './ecampusTrialBalanceRevisit';
import { runBudget } from './ecampusBudget';
import { runFinancialYear } from './ecampusFinancialYear';
import { runReports } from './ecampusReports';
import { runAuditLogs } from './ecampusAuditLogs';

const WORKFLOWS: { name: string; run: (page: Page) => Promise<void> }[] = [
  { name: 'Upload PO', run: runUploadPO },
  { name: 'Upload VCC', run: runUploadVCC },
  { name: 'Upload Trial Balance', run: runUploadTrialBalance },
  { name: 'Upload Payroll', run: runUploadPayroll },
  { name: 'Internal Accounts', run: runInternalAccounts },
  { name: 'Trial Balance revisit', run: runTrialBalanceRevisit },
  { name: 'Budget', run: runBudget },
  { name: 'Financial Year', run: runFinancialYear },
  { name: 'Reports', run: runReports },
  { name: 'Audit Logs', run: runAuditLogs },
];

function runConsolidateReports(): number {
  // shell: true so this resolves to npx.cmd on Windows regardless of
  // PowerShell execution-policy restrictions on npx.ps1.
  const result = spawnSync('npx', ['tsx', 'scripts/consolidateReports.ts'], { stdio: 'inherit', shell: true });
  if (result.error) {
    console.error(`Failed to launch consolidateReports.ts: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

async function main() {
  // headless: false so the captcha is visible and solvable by hand.
  // slowMo delays each Playwright action so the run is easy to follow visually.
  const browser = await chromium.launch({ headless: false, slowMo: 1000 });

  const results: { name: string; ok: boolean; error?: string }[] = [];

  try {
    const page = await browser.newPage();

    // ONE login, ONE captcha solve, for the entire session.
    await loginToEcampus(page);

    for (const workflow of WORKFLOWS) {
      console.log(`\n=== Running ${workflow.name} ===\n`);
      try {
        await workflow.run(page);
        results.push({ name: workflow.name, ok: true });
        console.log(`\n✅ ${workflow.name} completed.`);
      } catch (err) {
        const message = (err as Error).message;
        results.push({ name: workflow.name, ok: false, error: message });
        console.error(`\n❌ ${workflow.name} failed: ${message}`);
        console.error('Continuing to the next workflow in the same session...');
      }
    }
  } finally {
    // Guarantees the browser closes even if something above throws
    // unexpectedly outside the per-workflow try/catch (e.g. during login).
    if (browser.isConnected()) {
      await browser.close();
    }
  }

  console.log('\n=== Run All (Single Session) Summary ===');
  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.error ? `: ${r.error}` : ''}`);
  }

  console.log('\n=== Consolidating reports ===\n');
  const consolidateExitCode = runConsolidateReports();
  if (consolidateExitCode !== 0) {
    console.error(`⚠️ Report consolidation exited with code ${consolidateExitCode}.`);
  }

  const anyFailed = results.some((r) => !r.ok);
  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  console.error('Run All (Single Session) failed:', err);
  process.exit(1);
});
