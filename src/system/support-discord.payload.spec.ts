import { SystemRole } from '@prisma/client';
import {
  buildDiscordPayload,
  truncateText,
  type SupportPayloadInput,
} from './support-discord.payload';
import {
  SUPPORT_SEVERITIES,
  SUPPORT_SEVERITY_EMOJI,
  type SupportSeverity,
} from './support.constants';

/** 2026-10-05 23:55 Bangkok is 16:55 UTC the same day; 17:00 UTC is already the 6th. */
const AT = new Date('2026-10-05T16:55:00.000Z');
const F = 'ㅤ';
const FENCE = '`'.repeat(3);
const ZWSP = '​';

const base = (
  over: Partial<SupportPayloadInput> = {},
): SupportPayloadInput => ({
  code: 'INC-1148',
  category: 'web',
  severity: 'normal',
  role: SystemRole.ADMIN,
  reporterName: 'สมชาย ใจดี',
  phoneNumber: '081-234-5678',
  path: '/backend/bookings/requests',
  description: 'ปุ่มบันทึกไม่ทำงาน',
  diagnostics: 'UA: test\nviewport: 390x844',
  timestamp: AT,
  files: [],
  ...over,
});

const contentOf = (over: Partial<SupportPayloadInput> = {}): string =>
  buildDiscordPayload(base(over)).content;

describe('truncateText()', () => {
  it('returns a value at the limit untouched', () => {
    expect(truncateText('a'.repeat(10), 10)).toBe('a'.repeat(10));
  });

  it('truncates to max including the ellipsis', () => {
    const out = truncateText('a'.repeat(50), 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith('…')).toBe(true);
  });

  it('never leaves a lone high surrogate before the ellipsis', () => {
    // 😀 is a surrogate pair; cutting at max-1 = 3 would split it.
    expect(truncateText('ab😀😀', 4)).toBe('ab…');
  });

  it('a non-positive budget yields an empty string', () => {
    expect(truncateText('abc', 0)).toBe('');
    expect(truncateText('abc', -5)).toBe('');
  });
});

describe('buildDiscordPayload — envelope', () => {
  it('has no embeds and the fixed Discord fields', () => {
    const p = buildDiscordPayload(base());
    expect(p.username).toBe('EasyBook Incident Bot');
    expect(p.tts).toBe(false);
    expect(p.flags).toBe(0);
    expect(p.embeds).toEqual([]);
    expect(p.components).toEqual([]);
    expect(Object.keys(p).sort()).toEqual(
      [
        'allowed_mentions',
        'attachments',
        'components',
        'content',
        'embeds',
        'flags',
        'tts',
        'username',
      ].sort(),
    );
  });

  it('no files -> attachments is []', () => {
    expect(buildDiscordPayload(base()).attachments).toEqual([]);
  });

  it('files -> attachments carry id and the server-generated filename; no attachment:// anywhere', () => {
    const p = buildDiscordPayload(
      base({
        files: [
          { filename: 'screenshot-1.png' },
          { filename: 'screenshot-2.jpg' },
        ],
      }),
    );
    expect(p.attachments).toEqual([
      { id: 0, filename: 'screenshot-1.png' },
      { id: 1, filename: 'screenshot-2.jpg' },
    ]);
    expect(JSON.stringify(p)).not.toContain('attachment://');
  });
});

describe('buildDiscordPayload — severity', () => {
  it.each([
    ['critical', '@here\n', ['everyone'], '🔴'],
    ['urgent', '@Tech Support\n', [], '🟡'],
    ['normal', '', [], '🔵'],
  ] as const)(
    '%s -> ping prefix %j, allowed_mentions.parse %j, emoji %s',
    (severity, prefix, parse, emoji) => {
      const p = buildDiscordPayload(base({ severity }));
      expect(p.content.startsWith(`${prefix}# รายการปัญหาจากระบบ ที่ `)).toBe(
        true,
      );
      if (!prefix) expect(p.content).not.toContain('@');
      expect(p.allowed_mentions).toEqual({ parse });
      expect(p.content).toContain(`/2569 ${emoji}\n`);
      expect(SUPPORT_SEVERITY_EMOJI[severity]).toBe(emoji);
    },
  );

  it('every severity yields a distinct emoji and a fitting message', () => {
    const emojis = SUPPORT_SEVERITIES.map(
      (s: SupportSeverity) => SUPPORT_SEVERITY_EMOJI[s],
    );
    expect(new Set(emojis).size).toBe(3);
  });

  it('user text cannot ping: allowed_mentions.parse stays [] and the mention sits in a code fence', () => {
    const p = buildDiscordPayload(
      base({ description: '@everyone @here <@&123>', severity: 'normal' }),
    );
    expect(p.allowed_mentions.parse).toEqual([]);
    expect(p.content).toContain(`${FENCE}\n@everyone @here <@&123>\n${FENCE}`);
  });
});

describe('buildDiscordPayload — content', () => {
  it('golden string: critical, web, ADMIN, 23.55 Bangkok, the PO example', () => {
    const content = contentOf({
      severity: 'critical',
      files: [
        { filename: 'screenshot-1.png' },
        { filename: 'screenshot-2.png' },
      ],
    });
    const expected = [
      '@here',
      '# รายการปัญหาจากระบบ ที่ INC-1148/2569 🔴',
      '> วันที่ 5 ตุลาคม 2569  เวลา 23.55 น.',
      F,
      '**ผู้แจ้ง:**',
      `||${FENCE}สมชาย ใจดี  (เจ้าหน้าที่ดูแลระบบ)${FENCE}||`,
      '**เบอร์โทรศัพท์:**',
      `||${FENCE}081-234-5678${FENCE}||`,
      F,
      '**ประเภท:**',
      `${FENCE}บั๊กหน้าเว็บ${FENCE}`,
      '**ระดับ:**',
      `${FENCE}วิกฤต${FENCE}`,
      '**หน้าที่พบปัญหา:**',
      `${FENCE}/backend/bookings/requests${FENCE}`,
      '**รายละเอียด:**',
      `${FENCE}\nปุ่มบันทึกไม่ทำงาน\n${FENCE}`,
      '**ข้อมูลเวอร์ชันระบบ:**',
      `${FENCE}\nUA: test\nviewport: 390x844\n${FENCE}`,
    ].join('\n');
    expect(content).toBe(expected);
  });

  it('role label follows the SESSION role', () => {
    expect(contentOf({ role: SystemRole.VIEWER })).toContain(
      `${FENCE}สมชาย ใจดี  (ผู้ดูข้อมูล)${FENCE}`,
    );
    expect(contentOf({ role: SystemRole.SUPER_ADMIN })).toContain(
      '(ผู้ดูแลระบบสูงสุด)',
    );
  });

  it('a forged role in the diagnostics is just text', () => {
    const c = contentOf({
      role: SystemRole.VIEWER,
      diagnostics: 'บทบาท: ผู้ดูแลระบบสูงสุด (SUPER_ADMIN)',
    });
    expect(c).toContain('(ผู้ดูข้อมูล)');
  });

  it('missing name -> em dash; null or blank phone -> ไม่ได้ระบุ', () => {
    const none = contentOf({ reporterName: undefined, phoneNumber: null });
    expect(none).toContain(`||${FENCE}—  (เจ้าหน้าที่ดูแลระบบ)${FENCE}||`);
    expect(none).toContain(`||${FENCE}ไม่ได้ระบุ${FENCE}||`);
    expect(contentOf({ reporterName: '  ', phoneNumber: '   ' })).toContain(
      `||${FENCE}ไม่ได้ระบุ${FENCE}||`,
    );
    expect(contentOf({ phoneNumber: undefined })).toContain(
      `||${FENCE}ไม่ได้ระบุ${FENCE}||`,
    );
  });

  it('diagnostics absent or blank -> em dash inside its fence', () => {
    for (const diagnostics of [undefined, '', '   ']) {
      expect(contentOf({ diagnostics }).endsWith(`${FENCE}\n—\n${FENCE}`)).toBe(
        true,
      );
    }
  });

  it('description and diagnostics open their fence on its own line (no language-tag swallowing)', () => {
    const c = contentOf({ description: 'first line\nsecond' });
    expect(c).toContain(
      `**รายละเอียด:**\n${FENCE}\nfirst line\nsecond\n${FENCE}`,
    );
    expect(c).toContain(`**ข้อมูลเวอร์ชันระบบ:**\n${FENCE}\nUA: test`);
  });
});

describe('buildDiscordPayload — Bangkok date', () => {
  const dateLine = (iso: string): string =>
    contentOf({ timestamp: new Date(iso) })
      .split('\n')
      .find((l) => l.startsWith('> วันที่'))!;

  it.each([
    // [UTC instant, expected line]
    ['2026-10-05T16:55:00.000Z', '> วันที่ 5 ตุลาคม 2569  เวลา 23.55 น.'],
    ['2026-10-05T17:00:00.000Z', '> วันที่ 6 ตุลาคม 2569  เวลา 00.00 น.'],
    ['2026-10-05T16:59:59.999Z', '> วันที่ 5 ตุลาคม 2569  เวลา 23.59 น.'],
    ['2026-10-05T08:55:00.000Z', '> วันที่ 5 ตุลาคม 2569  เวลา 15.55 น.'],
    ['2026-10-05T00:05:00.000Z', '> วันที่ 5 ตุลาคม 2569  เวลา 07.05 น.'],
    // Year end: 31 Dec 18:30 UTC is 1 Jan 01:30 in Bangkok, next Buddhist year.
    ['2026-12-31T18:30:00.000Z', '> วันที่ 1 มกราคม 2570  เวลา 01.30 น.'],
    ['2026-12-31T16:59:00.000Z', '> วันที่ 31 ธันวาคม 2569  เวลา 23.59 น.'],
    // Month rollover and a leap day.
    ['2028-02-28T17:00:00.000Z', '> วันที่ 29 กุมภาพันธ์ 2571  เวลา 00.00 น.'],
    ['2026-04-30T20:00:00.000Z', '> วันที่ 1 พฤษภาคม 2569  เวลา 03.00 น.'],
  ])('%s -> %s', (iso, line) => {
    expect(dateLine(iso)).toBe(line);
  });

  it('puts the Buddhist year of the BANGKOK date in the heading, not the UTC year', () => {
    const c = contentOf({ timestamp: new Date('2026-12-31T18:30:00.000Z') });
    expect(c).toContain('# รายการปัญหาจากระบบ ที่ INC-1148/2570 🔵');
  });

  it('uses two spaces before เวลา and a dot between hours and minutes', () => {
    expect(dateLine('2026-10-05T16:55:00.000Z')).toContain('2569  เวลา 23.55');
  });
});

describe('buildDiscordPayload — sanitisation', () => {
  it('normalises CRLF and lone CR to LF', () => {
    const c = contentOf({
      description: 'a\r\nb\rc',
      diagnostics: 'x\r\ny',
    });
    expect(c).not.toContain('\r');
    expect(c).toContain('\na\nb\nc\n');
    expect(c).toContain('\nx\ny\n');
  });

  it('a run of three backticks in description/diagnostics cannot close the fence', () => {
    const c = contentOf({
      description: `before ${FENCE} after\n${'`'.repeat(5)}`,
      diagnostics: `x${FENCE}y`,
    });
    const body = c.slice(c.indexOf('**รายละเอียด:**'));
    // Only the four real fences (open/close for each of the two blocks) remain as triple runs.
    expect(body.match(/`{3,}/g)).toHaveLength(4);
    expect(body).toContain(`before \`${ZWSP}\`${ZWSP}\` after`);
  });

  it('inline fields: backticks are neutralised and never touch the fence', () => {
    const c = contentOf({ path: '`/a```b`' });
    const line = c.split('\n').find((l) => l.includes('/a'))!;
    expect(line.startsWith(FENCE + ZWSP + '`')).toBe(true);
    expect(line.endsWith('`' + ZWSP + FENCE)).toBe(true);
    // exactly the opening and closing fence as 3+ runs
    expect(line.match(/`{3,}/g)).toHaveLength(2);
  });

  it('inline fields: a newline in the path collapses to a space', () => {
    const c = contentOf({ path: '/a\r\n/b\n\n/c' });
    expect(c).toContain(`${FENCE}/a /b /c${FENCE}`);
  });

  it('`||` in the reporter name or phone cannot break the spoiler', () => {
    const c = contentOf({
      reporterName: 'a||b|||c',
      phoneNumber: '1||2',
    });
    const [nameLine] = c
      .split('\n')
      .filter((l) => l.startsWith('||') && l.includes('(เจ้าหน้าที่'));
    const phoneLine =
      c.split('\n')[c.split('\n').indexOf('**เบอร์โทรศัพท์:**') + 1];
    for (const line of [nameLine, phoneLine]) {
      const inner = line.slice(2, -2);
      expect(line.startsWith('||')).toBe(true);
      expect(line.endsWith('||')).toBe(true);
      expect(inner).not.toContain('||');
    }
    expect(nameLine).toContain(`a|${ZWSP}|b|${ZWSP}|${ZWSP}|c`);
    expect(phoneLine).toContain(`1|${ZWSP}|2`);
  });

  it('a newline in the reporter name or phone collapses', () => {
    const c = contentOf({ reporterName: 'a\nb', phoneNumber: '1\r\n2' });
    expect(c).toContain(`||${FENCE}a b  (`);
    expect(c).toContain(`||${FENCE}1 2${FENCE}||`);
  });
});

describe('buildDiscordPayload — 2000-character invariant', () => {
  const widest = (over: Partial<SupportPayloadInput> = {}) =>
    base({
      severity: 'critical',
      code: 'INC-25691005-223107',
      reporterName: 'ก'.repeat(300),
      phoneNumber: '0'.repeat(300),
      path: '/'.repeat(200),
      description: 'd'.repeat(1000),
      diagnostics: 'g'.repeat(2000),
      ...over,
    });

  const check = (content: string) => {
    expect(content.length).toBeLessThanOrEqual(2000);
    // Code points are never more than UTF-16 units, so this holds too (Discord may count either way).
    expect([...content].length).toBeLessThanOrEqual(2000);
  };

  it('worst case: 1000-char description, max diagnostics, long name, critical ping, max path', () => {
    const { content } = buildDiscordPayload(widest());
    check(content);
    // The description has priority and survives whole; diagnostics is what shrinks.
    expect(content).toContain(`${FENCE}\n${'d'.repeat(1000)}\n${FENCE}`);
    const diag = content.slice(content.lastIndexOf(`${FENCE}\n`));
    expect(diag).toContain('…\n' + FENCE);
    expect(content.endsWith(`…\n${FENCE}`)).toBe(true);
    // The full budget is used: no slack left on the table.
    expect(content.length).toBe(2000);
  });

  it('worst case with backtick/ZWSP expansion in every user field', () => {
    const { content } = buildDiscordPayload(
      widest({
        reporterName: '`'.repeat(300),
        path: '`'.repeat(200),
        description: '`'.repeat(1000),
        diagnostics: '`'.repeat(2000),
      }),
    );
    check(content);
  });

  it('worst case in astral characters never splits a surrogate pair', () => {
    const { content } = buildDiscordPayload(
      widest({ description: '😀'.repeat(500), diagnostics: '😀'.repeat(1000) }),
    );
    check(content);
    // No high surrogate without a low one after it, and no low one without a high one before it.
    expect(content).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(content).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });

  it.each(['normal', 'urgent', 'critical'] as const)(
    '%s at the input caps fits',
    (severity) => {
      check(buildDiscordPayload(widest({ severity })).content);
    },
  );

  it('a short report is not truncated at all', () => {
    const c = contentOf();
    expect(c).not.toContain('…');
    expect(c.length).toBeLessThan(2000);
  });

  it('diagnostics keeps at least one character even when the description eats everything', () => {
    const { content } = buildDiscordPayload(
      widest({ path: '/'.repeat(200), description: 'd'.repeat(1900) }),
    );
    check(content);
    expect(content.endsWith(`\n${FENCE}`)).toBe(true);
    const tail = content.split(`${FENCE}\n`).pop()!;
    expect(tail.length).toBeGreaterThan(FENCE.length + 1);
  });
});
