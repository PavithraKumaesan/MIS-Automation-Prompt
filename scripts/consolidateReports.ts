/**
 * Consolidates Report_PO.env, Report_VCC.env, Report_TB.env,
 * Report_payroll.env, Report_Accounts.env, Report_TB_Revisit.env,
 * Report_Budget.env, Report_FinancialYear.env, Report_Reports.env, and
 * Report_AuditLogs.env into a single Excel workbook: MIS_Consolidated.xlsx.
 *
 * Replaces the previous Markdown output (Report_Consolidated.md) with the
 * user's Excel reporting template — one ROW per module rather than one
 * banner section, with each module's log lines split into columns instead
 * of a flat bullet list:
 *   Module | Time Duration | Header Comparison | Account Code | Warning | No Action
 *
 * Every line in a module's report file is classified into exactly one
 * column:
 *   - "Header Comparison Result: ..." lines (MATCH or NOT MATCH)  -> Header Comparison
 *   - Payroll_Acct_code validation lines (pass or fail)           -> Account Code
 *   - Always-logged raw duration lines (e.g. "...: 1345ms")       -> Time Duration
 *   - Everything else (threshold-breach alerts, failed
 *     clicks/validations, missing sections, etc.)                 -> Warning
 * A module whose report file is empty or missing gets a note in the
 * No Action column instead, with the other four columns left blank.
 *
 * Any duration embedded in a message as raw milliseconds (e.g. "1345ms") is
 * converted to seconds, or minutes+seconds once it reaches 60s, for
 * readability, same as the previous Markdown version.
 *
 * Purely reads/writes local files — no browser, no login, so it runs
 * instantly and can be invoked any time, independent of which modules have
 * actually been run.
 *
 * Run with:
 *   npm run consolidate:ecampus
 * or:
 *   npx tsx scripts/consolidateReports.ts
 *
 * Also invoked automatically at the end of scripts/runAllEcampus.ts.
 */

import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';

const OUTPUT_PATH = path.resolve('MIS_Consolidated.xlsx');

interface ReportSource {
  title: string;
  file: string;
}

const REPORT_SOURCES: ReportSource[] = [
  { title: 'PO Report', file: 'Report_PO.env' },
  { title: 'VCC Report', file: 'Report_VCC.env' },
  { title: 'Trial Balance Report', file: 'Report_TB.env' },
  { title: 'Payroll Report', file: 'Report_payroll.env' },
  { title: 'Internal Accounts Report', file: 'Report_Accounts.env' },
  { title: 'Trial Balance Revisit Report', file: 'Report_TB_Revisit.env' },
  { title: 'Budget Report', file: 'Report_Budget.env' },
  { title: 'Financial Year Report', file: 'Report_FinancialYear.env' },
  { title: 'Reports Report', file: 'Report_Reports.env' },
  { title: 'Audit Logs Report', file: 'Report_AuditLogs.env' },
];

const ENTRY_PATTERN = /^\[(.+?)\]\s*(.*)$/;
const HEADER_COMPARISON_PATTERN = /header comparison result/i;
const ACCOUNT_CODE_PATTERN = /payroll_acct_code|account code number/i;
// Matches the raw "<number>ms" suffix every always-logged duration line in
// this project uses (e.g. "Batches page load time: 1353ms") — conditional
// threshold-breach alerts are phrased in whole seconds ("...more than 2
// seconds.") with no embedded "ms", so they never match this and correctly
// fall through to the Warning catch-all instead.
const DURATION_PATTERN = /\d+\s*ms\b/;

/** Converts a millisecond count to "X sec" (under 60s) or "X min Y sec" (60s+). */
function formatDuration(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds >= 60) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.round(totalSeconds % 60);
    return `${minutes} min ${seconds} sec`;
  }
  const rounded = Math.round(totalSeconds * 100) / 100;
  return `${rounded} sec`;
}

/** Replaces any "<number>ms" occurrences in a message with a human-readable duration. */
function humanizeDurations(message: string): string {
  return message.replace(/(\d+)\s*ms\b/g, (_match, msDigits: string) => formatDuration(parseInt(msDigits, 10)));
}

/** "PO Report" -> "PO", "Internal Accounts Report" -> "Internal Accounts", etc. */
function moduleNameFromTitle(title: string): string {
  return title.replace(/\s*Report$/i, '').trim();
}

interface ModuleRowData {
  module: string;
  timeDuration: string[];
  headerComparison: string[];
  accountCode: string[];
  warning: string[];
  noAction: string[];
}

/**
 * Reads one module's report file and classifies every line into exactly
 * one of the four result columns, or fills No Action if the module has no
 * entries (or hasn't been run at all yet).
 */
function buildModuleRow(source: ReportSource): ModuleRowData {
  const row: ModuleRowData = {
    module: moduleNameFromTitle(source.title),
    timeDuration: [],
    headerComparison: [],
    accountCode: [],
    warning: [],
    noAction: [],
  };

  const filePath = path.resolve(source.file);
  if (!fs.existsSync(filePath)) {
    row.noAction.push('Module has not been run yet.');
    return row;
  }

  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) {
    row.noAction.push('Currently, no actions were performed in this module.');
    return row;
  }

  for (const line of lines) {
    const match = line.match(ENTRY_PATTERN);
    if (!match) continue;
    const [, , rawMessage] = match;
    const message = humanizeDurations(rawMessage);

    if (HEADER_COMPARISON_PATTERN.test(rawMessage)) {
      row.headerComparison.push(message);
    } else if (ACCOUNT_CODE_PATTERN.test(rawMessage)) {
      row.accountCode.push(message);
    } else if (DURATION_PATTERN.test(rawMessage)) {
      row.timeDuration.push(message);
    } else {
      // Catch-all: every remaining message in this project is either a
      // conditional threshold-breach alert or a tryStep failure alert —
      // both are genuine warnings, so nothing falls through uncategorized.
      row.warning.push(message);
    }
  }

  return row;
}

async function main() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('MIS Consolidated Report');

  sheet.columns = [
    { header: 'Module', key: 'module', width: 22 },
    { header: 'Time Duration', key: 'timeDuration', width: 45 },
    { header: 'Header Comparison', key: 'headerComparison', width: 45 },
    { header: 'Account Code', key: 'accountCode', width: 50 },
    { header: 'Warning', key: 'warning', width: 60 },
    { header: 'No Action', key: 'noAction', width: 45 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };

  for (const source of REPORT_SOURCES) {
    const data = buildModuleRow(source);
    const row = sheet.addRow({
      module: data.module,
      timeDuration: data.timeDuration.join('\n'),
      headerComparison: data.headerComparison.join('\n'),
      accountCode: data.accountCode.join('\n'),
      warning: data.warning.join('\n'),
      noAction: data.noAction.join('\n'),
    });
    row.alignment = { vertical: 'top', wrapText: true };
  }

  await workbook.xlsx.writeFile(OUTPUT_PATH);
  console.log(`✅ Consolidated Excel report written to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error('Failed to generate MIS_Consolidated.xlsx:', err);
  process.exit(1);
});
