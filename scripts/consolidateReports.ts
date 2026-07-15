/**
 * Consolidates Report_PO.env, Report_VCC.env, Report_TB.env,
 * Report_payroll.env, Report_Accounts.env, Report_TB_Revisit.env,
 * Report_Budget.env, Report_FinancialYear.env, Report_Reports.env, and
 * Report_AuditLogs.env into a single, human-readable plain-text report:
 * Report_Consolidated.md — one banner-style section per module, each a flat
 * bullet list of its validation results/timings/alerts. Alert-type lines
 * (mismatches, over-threshold timings, failures) get an inline "WARNING: "
 * prefix rather than being split into a separate subsection. Any duration
 * embedded in a message as raw milliseconds (e.g. "1345ms") is converted to
 * seconds, or minutes+seconds once it reaches 60s, for readability.
 *
 * Purely reads/writes local files — no browser, no login, so it runs
 * instantly and can be invoked any time, independent of which of the four
 * upload scripts have actually been run.
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

const OUTPUT_PATH = path.resolve('Report_Consolidated.md');
const BANNER = '='.repeat(30);

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
// Heuristic: these substrings indicate a genuine alert/warning line, as
// opposed to a purely informational one (durations, MATCH results, etc.).
const ALERT_PATTERN = /does not match|is taking more than|not matching|NOT MATCH|timed out|could not|failed|not found/i;

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

/** Reads a report file and returns its entries as display-ready bullet text (WARNING-prefixed where applicable), or null if the file doesn't exist. */
function readEntries(filePath: string): string[] | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/).filter((line) => line.trim() !== '');
  const entries: string[] = [];
  for (const line of lines) {
    const match = line.match(ENTRY_PATTERN);
    if (!match) continue;
    const [, , rawMessage] = match;
    const message = humanizeDurations(rawMessage);
    entries.push(ALERT_PATTERN.test(rawMessage) ? `WARNING: ${message}` : message);
  }
  return entries;
}

function buildSection(source: ReportSource): string {
  const header = `${BANNER}\n${source.title}\n${BANNER}`;
  const entries = readEntries(path.resolve(source.file));

  if (entries === null) {
    return `${header}\n(No ${source.file} found — this module hasn't been run yet.)`;
  }
  if (entries.length === 0) {
    return `${header}\nCurrently, no actions were performed in this module.`;
  }
  return `${header}\n${entries.map((e) => `• ${e}`).join('\n')}`;
}

function main() {
  const generatedAt = new Date().toISOString();
  const sections = REPORT_SOURCES.map(buildSection);

  const output = [`eCampusBuddy Automation — Consolidated Report`, `Generated: ${generatedAt}`, ...sections].join('\n\n');

  fs.writeFileSync(OUTPUT_PATH, output);
  console.log(`✅ Consolidated report written to ${OUTPUT_PATH}`);
}

main();
