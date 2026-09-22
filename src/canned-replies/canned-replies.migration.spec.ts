import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ANNOUNCE-API-5 — the two migrations' CONTENT (plan AC-1, AC-11; design §5.3).
 *
 * The four defaults are seeded by the migration SQL itself (D-4), so the only proof that they are
 * byte-equal to the former hardcoded `CannedRepliesCard.tsx` REPLIES is the file. The DB check after
 * `migrate dev` is recorded in the implement log.
 */

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');

const readMigration = (suffix: string): Buffer => {
  const dir = readdirSync(MIGRATIONS).find((d) => d.endsWith(suffix));
  if (!dir) throw new Error(`no migration folder ends with ${suffix}`);
  return readFileSync(join(MIGRATIONS, dir, 'migration.sql'));
};

/** Pasted from design §1.4 — the four defaults, in `sortOrder` order. */
const DEFAULTS = [
  {
    id: 'canned_reply_default_1',
    title: 'แจ้งวิธีจองสถานที่',
    text: 'สวัสดีค่ะ จองสถานที่ได้ที่เมนู "จองสถานที่" ด้านล่างห้องแชทนี้ เลือกสถานที่ วันและเวลา แล้วกดยืนยัน ระบบจะแจ้งผลการอนุมัติทาง LINE ภายใน 1 วันทำการค่ะ',
  },
  {
    id: 'canned_reply_default_2',
    title: 'แจ้งเงื่อนไขการยกเลิก',
    text: 'ยกเลิกการจองได้เองที่เมนู "การจองของฉัน" ก่อนเวลาใช้งานอย่างน้อย 24 ชั่วโมง หากน้อยกว่านั้นกรุณาติดต่อเจ้าหน้าที่ผ่านแชทนี้ค่ะ',
  },
  {
    id: 'canned_reply_default_3',
    title: 'แจ้งสถานะคำขอรออนุมัติ',
    text: 'ได้รับคำขอจองของท่านแล้วค่ะ ขณะนี้อยู่ระหว่างรอเจ้าหน้าที่อนุมัติ เมื่อพิจารณาแล้วระบบจะแจ้งผลให้ทราบทาง LINE โดยอัตโนมัติค่ะ',
  },
  {
    id: 'canned_reply_default_4',
    title: 'ติดต่อนอกเวลาทำการ',
    text: 'ขอบคุณที่ติดต่อมาค่ะ ขณะนี้อยู่นอกเวลาทำการ (จันทร์–ศุกร์ 08:30–16:30 น.) เจ้าหน้าที่จะตอบกลับโดยเร็วที่สุดในวันทำการถัดไปค่ะ',
  },
] as const;

describe('migration add_canned_replies_table (AC-11)', () => {
  const bytes = readMigration('_add_canned_replies_table');
  const sql = bytes.toString('utf8');

  it('is UTF-8 WITHOUT a BOM', () => {
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(sql.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('creates exactly the canned_replies table with no secondary index', () => {
    expect(sql.match(/CREATE TABLE "([^"]+)"/g)).toEqual([
      'CREATE TABLE "canned_replies"',
    ]);
    expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX/);
    expect(sql).not.toMatch(/\bDROP\b|\bALTER TABLE\b/);
  });

  it.each(DEFAULTS.map((d, i) => [d.id, i, d] as const))(
    '%s (sortOrder %i): its title and text are present byte-for-byte as SQL literals',
    (id, sortOrder, d) => {
      const tuple = `('${id}', '${d.title}', '${d.text}', ${sortOrder}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
      expect(sql).toContain(tuple);
    },
  );

  it('the literals need no escaping: no apostrophe or backslash in any of them', () => {
    for (const d of DEFAULTS) {
      expect(`${d.title}${d.text}`).not.toMatch(/['\\]/);
    }
    // The ASCII quotes and the two U+2013 en dashes survived as themselves.
    expect(DEFAULTS[0].text).toContain('"จองสถานที่"');
    expect(DEFAULTS[3].text).toContain('จันทร์\u2013ศุกร์ 08:30\u201316:30 น.');
  });

  it('inserts exactly four rows with the fixed ids, guarded by ON CONFLICT DO NOTHING', () => {
    expect(sql.match(/canned_reply_default_\d/g)).toEqual(
      DEFAULTS.map((d) => d.id),
    );
    expect(sql.match(/CURRENT_TIMESTAMP, CURRENT_TIMESTAMP\)/g)).toHaveLength(
      4,
    );
    expect(sql).toContain(
      'INSERT INTO "canned_replies" ("id", "title", "text", "sortOrder", "createdAt", "updatedAt")',
    );
    expect(sql.trimEnd().endsWith('ON CONFLICT ("id") DO NOTHING;')).toBe(true);
  });
});

describe('migration add_deleted_at_to_announcements (AC-1)', () => {
  const sql = readMigration('_add_deleted_at_to_announcements').toString(
    'utf8',
  );

  it('adds only the nullable deletedAt column and its index, on announcements only', () => {
    expect(sql).not.toMatch(/CREATE TABLE|\bDROP\b|INSERT|UPDATE/);
    expect(sql).toContain(
      'ADD COLUMN     "deletedAt" TIMESTAMP(3);', // nullable: no NOT NULL, no DEFAULT → existing rows NULL
    );
    expect(sql).not.toMatch(/NOT NULL|DEFAULT/);
    expect(sql).toContain(
      'CREATE INDEX "announcements_deletedAt_createdAt_idx" ON "announcements"("deletedAt", "createdAt");',
    );
    const tables = [...sql.matchAll(/(?:TABLE|ON) "([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(tables.length).toBeGreaterThan(0);
    expect(new Set(tables)).toEqual(new Set(['announcements']));
  });
});
