/**
 * Checks a generated workbook still matches the live schema.
 *
 * The workbook is a copy of `TAB_SCHEMAS`, so it silently rots whenever a
 * column is added. This catches that.
 *
 *   npx tsx scripts/verify-spreadsheet.ts [path]
 */

import ExcelJS from "exceljs";

import { ALL_TABS, TAB_SCHEMAS } from "../agent/lib/sheets/schema";

async function main(): Promise<void> {
  const path = process.argv[2] ?? "betagents-spreadsheet.xlsx";
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);

  console.log("tabs:", workbook.worksheets.map((sheet) => sheet.name).join(", "));
  console.log();

  let problems = 0;
  for (const tab of ALL_TABS) {
    const sheet = workbook.getWorksheet(tab);
    if (!sheet) {
      console.log(`MISSING  ${tab}`);
      problems += 1;
      continue;
    }

    const header = (sheet.getRow(1).values as unknown[]).slice(1).map(String);
    const expected = TAB_SCHEMAS[tab].columns.map((column) => column.name);

    if (JSON.stringify(header) !== JSON.stringify(expected)) {
      console.log(`MISMATCH ${tab}\n  workbook: ${header.join(", ")}\n  schema:   ${expected.join(", ")}`);
      problems += 1;
      continue;
    }

    console.log(`ok       ${tab.padEnd(16)} ${expected.length} cols, header frozen`);
  }

  console.log();
  if (problems > 0) {
    console.error(`${problems} problem(s). Re-run: npm run spreadsheet`);
    process.exitCode = 1;
    return;
  }
  console.log("Every tab matches the schema.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
