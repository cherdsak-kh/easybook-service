/**
 * The one CSV writer (Hubs 5 and 6, AC-A9 / AC-D10): UTF-8 BOM so Excel reads Thai, RFC 4180 quoting,
 * CRLF line endings and a trailing CRLF.
 *
 * 🔴 FORMULA INJECTION: a cell beginning with `= + - @`, a tab or a CR is prefixed with `'` so a
 * spreadsheet shows it as text instead of evaluating it. Empty values are written EMPTY (never a `-`
 * placeholder), so no placeholder is itself neutralised.
 */

const FORMULA_LEADERS = ['=', '+', '-', '@', '\t', '\r'];

export function neutralise(cell: string): string {
  return cell.length > 0 && FORMULA_LEADERS.includes(cell[0])
    ? `'${cell}`
    : cell;
}

export function csvCell(value: string | number | null | undefined): string {
  const text = neutralise(
    value === null || value === undefined ? '' : String(value),
  );
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(
  lines: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>,
): string {
  return `\uFEFF${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** Response headers of a CSV download. The filename is ASCII by construction (dates and a fixed stem). */
export function csvHeaders(fileName: string): Record<string, string> {
  return {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
}
