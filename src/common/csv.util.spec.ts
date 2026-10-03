import { csvCell, csvHeaders, neutralise, toCsv } from './csv.util';

describe('csv.util', () => {
  it('starts with a UTF-8 BOM, uses CRLF and ends with a CRLF', () => {
    const out = toCsv([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out.slice(1)).toBe('a,b\r\nc,d\r\n');
  });

  it('quotes cells holding a comma, a quote or a line break (RFC 4180) and doubles quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('cr\rhere')).toBe('"cr\rhere"');
  });

  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx'])(
    'neutralises a formula leader: %j',
    (cell) => {
      expect(neutralise(cell)).toBe(`'${cell}`);
    },
  );

  it('leaves an ordinary or empty cell alone and writes null/undefined as empty', () => {
    expect(neutralise('hello')).toBe('hello');
    expect(neutralise('')).toBe('');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(7)).toBe('7');
  });

  it('keeps Thai text intact and writes an empty line for an empty array', () => {
    expect(toCsv([['ประวัติ'], [], ['x']]).slice(1)).toBe(
      'ประวัติ\r\n\r\nx\r\n',
    );
  });

  it('builds an ASCII attachment header with no-store and nosniff', () => {
    const h = csvHeaders('easybook-audit_2026-09-01_2026-09-30.csv');
    expect(h['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(h['Content-Disposition']).toBe(
      'attachment; filename="easybook-audit_2026-09-01_2026-09-30.csv"',
    );
    expect(h['Cache-Control']).toBe('no-store');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
  });
});
