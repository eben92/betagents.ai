/**
 * Builds the spreadsheet as one importable workbook.
 *
 * The app creates every tab on first run, so this is not required — it exists so
 * you can review the layout before handing over credentials, and so you can
 * start from a spreadsheet that is already correct.
 *
 * Produces a single `.xlsx` with all 16 tabs, their header rows, and a `_readme`
 * tab documenting every column. Google Sheets imports the whole workbook in one
 * step, tabs and all.
 *
 *   npm run spreadsheet [outputPath]
 */

import ExcelJS from "exceljs";

import { ALL_TABS, TAB_SCHEMAS, type TabName } from "../agent/lib/sheets/schema";

/** What each tab is for, in the order a cycle touches them. */
const PURPOSE: Record<TabName, string> = {
  research: "One row per match assessed. Refreshed in place, keyed on matchKey.",
  shortlist: "Candidate selections. The operator's price is written back here.",
  drafts: "Bets the Planner intends to place, before review.",
  approved: "Bets the Reviewer cleared. One approval per draft.",
  bets: "Every placement attempt. This tab is the duplicate-bet guard.",
  active_bets: "Bets still running, with the last score seen.",
  settlements: "Settled results. One settlement per bet.",
  balances: "Every balance reading, with the bankroll breakdown at that moment.",
  profit_history: "One row per betting day, recomputed from that day's settlements.",
  reports: "Everything sent to Telegram, whether or not delivery succeeded.",
  errors: "Failures worth a human's attention.",
  wakeups: "Scheduled work. The system sleeps until the earliest pending row.",
  system_state: "Internal key/value state: status, locked profit, day markers, locks.",
  settings: "Operator-editable key/value overrides.",
};

/** Why a tab's uniqueness key matters. Removing one breaks a real guarantee. */
const KEY_MEANING: Partial<Record<TabName, string>> = {
  research: "One research row per match, so a re-run refreshes instead of duplicating.",
  approved: "A draft cannot be approved twice.",
  bets: "A bet cannot be placed twice. This is the system's core safety guarantee.",
  settlements: "A result cannot be counted twice.",
  profit_history: "One row per betting day.",
  system_state: "One row per key.",
  settings: "One row per key.",
};

const HEADER_FILL = "FFEFEFEF";

function styleHeaderRow(sheet: ExcelJS.Worksheet, columnCount: number): void {
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  header.alignment = { vertical: "middle" };
  header.commit();

  // Freeze the header and add a filter so a 24-column tab stays readable.
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columnCount },
  };
}

function addReadme(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet("_readme", {
    properties: { tabColor: { argb: "FF4285F4" } },
  });

  sheet.columns = [
    { width: 22 },
    { width: 18 },
    { width: 10 },
    { width: 72 },
  ];

  const title = sheet.addRow(["betagents — spreadsheet layout"]);
  title.font = { bold: true, size: 14 };

  for (const line of [
    "",
    "This workbook is the datastore. There is no database; every tab below is a table.",
    "",
    "To use it: File → Import → Upload → Replace spreadsheet. All tabs arrive together.",
    "Then share the spreadsheet with your service account's email as an Editor, and put",
    "the spreadsheet id (the part of the URL between /d/ and /edit) in",
    "GOOGLE_SHEETS_SPREADSHEET_ID.",
    "",
    "You can delete this _readme tab. The app ignores tabs it does not own.",
    "",
    "Column order is the wire format: columns are matched by name, so appending one at",
    "the end is safe and reordering is not. Do not rename or remove a column.",
    "",
  ]) {
    sheet.addRow([line]);
  }

  const tabsHeader = sheet.addRow(["Tab", "Unique key", "Columns", "What it holds"]);
  tabsHeader.font = { bold: true };
  tabsHeader.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };

  for (const tab of ALL_TABS) {
    const schema = TAB_SCHEMAS[tab];
    sheet.addRow([tab, schema.uniqueBy ?? "—", schema.columns.length, PURPOSE[tab]]);
  }

  sheet.addRow([]);
  const guaranteesHeader = sheet.addRow(["Uniqueness keys — do not remove", "", "", ""]);
  guaranteesHeader.font = { bold: true };

  for (const tab of ALL_TABS) {
    const schema = TAB_SCHEMAS[tab];
    const meaning = KEY_MEANING[tab];
    if (!schema.uniqueBy || !meaning) continue;
    sheet.addRow([tab, schema.uniqueBy, "", meaning]);
  }

  sheet.addRow([]);
  const typesHeader = sheet.addRow(["Column types", "", "", ""]);
  typesHeader.font = { bold: true };

  for (const [type, meaning] of [
    ["string", "Plain text."],
    ["number", "A number. Do not apply currency formatting; it is read back raw."],
    ["boolean", "TRUE / FALSE."],
    ["json", "A JSON literal in one cell, e.g. a list of sources or candidate markets."],
  ]) {
    sheet.addRow([type, "", "", meaning]);
  }

  sheet.addRow([]);
  const columnsHeader = sheet.addRow(["Tab", "Column", "Type", ""]);
  columnsHeader.font = { bold: true };
  columnsHeader.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };

  for (const tab of ALL_TABS) {
    for (const column of TAB_SCHEMAS[tab].columns) {
      sheet.addRow([tab, column.name, column.type, ""]);
    }
  }

  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

async function main(): Promise<void> {
  const outputPath = process.argv[2] ?? "betagents-spreadsheet.xlsx";

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "betagents";
  workbook.created = new Date();

  addReadme(workbook);

  for (const tab of ALL_TABS) {
    const schema = TAB_SCHEMAS[tab];
    const sheet = workbook.addWorksheet(tab);

    sheet.columns = schema.columns.map((column) => ({
      header: column.name,
      key: column.name,
      // Wide enough for the header, and for the values these columns hold.
      width: Math.min(46, Math.max(12, column.name.length + 4, column.type === "json" ? 30 : 0)),
    }));

    styleHeaderRow(sheet, schema.columns.length);
  }

  await workbook.xlsx.writeFile(outputPath);

  console.log(`Wrote ${outputPath}`);
  console.log(`  ${ALL_TABS.length} tabs plus _readme`);
  console.log("  Import with: File → Import → Upload → Replace spreadsheet");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
