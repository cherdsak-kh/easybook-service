import { attributionOf, formatActor } from './attribution';

describe('formatActor / attributionOf (NOTIF-EVENTS-1 B-2)', () => {
  it('all three parts present: "ชื่อ นามสกุล · ตำแหน่ง · กลุ่ม/ฝ่าย", position before group', () => {
    const result = formatActor('สมชาย ใจดี', 'ครู', 'ฝ่ายวิชาการ');
    expect(result).toBe('สมชาย ใจดี · ครู · ฝ่ายวิชาการ');
    expect(result).toMatch(/^[^·]+ · [^·]+ · [^·]+$/);
  });

  it.each([
    ['name only', 'สมชาย', null, null, 'สมชาย'],
    ['name + position', 'สมชาย', 'ครู', null, 'สมชาย · ครู'],
    ['name + department', 'สมชาย', null, 'ฝ่ายวิชาการ', 'สมชาย · ฝ่ายวิชาการ'],
    ['position only', null, 'ครู', null, 'ครู'],
    ['department only', null, null, 'ฝ่ายวิชาการ', 'ฝ่ายวิชาการ'],
    [
      'position + department, no name',
      null,
      'ครู',
      'ฝ่ายวิชาการ',
      'ครู · ฝ่ายวิชาการ',
    ],
    ['none', null, null, null, ''],
  ])(
    'drops an empty part WITH its separator: %s',
    (_label, name, position, department, expected) => {
      expect(formatActor(name, position, department)).toBe(expected);
    },
  );

  it('an empty string is treated the same as null/undefined', () => {
    expect(formatActor('', '', '')).toBe('');
    expect(formatActor('  ', undefined, '')).toBe('');
  });

  it('collapses internal whitespace within a part', () => {
    expect(formatActor('สมชาย   ใจดี', 'ครู', null)).toBe('สมชาย ใจดี · ครู');
  });

  it('a literal "·" inside a part is replaced, never dropped, so the separator stays unambiguous', () => {
    expect(formatActor('สมชาย', 'ครู · ผู้ช่วย', null)).toBe(
      'สมชาย · ครู - ผู้ช่วย',
    );
  });

  it('attributionOf: null/undefined input uses the fallback', () => {
    expect(attributionOf(null)).toBe('ไม่ระบุชื่อ');
    expect(attributionOf(undefined, 'ผู้ใช้ LINE ที่ยังไม่ลงทะเบียน')).toBe(
      'ผู้ใช้ LINE ที่ยังไม่ลงทะเบียน',
    );
  });

  it('attributionOf: an all-empty PersonFacts also falls back', () => {
    expect(
      attributionOf({
        firstName: '',
        lastName: '',
        personnelRole: null,
        department: null,
      }),
    ).toBe('ไม่ระบุชื่อ');
  });

  it('attributionOf: reads firstName/lastName/personnelRole.name/department.name', () => {
    expect(
      attributionOf({
        firstName: 'สมชาย',
        lastName: 'ใจดี',
        personnelRole: { name: 'ครู' },
        department: { name: 'ฝ่ายวิชาการ' },
      }),
    ).toBe('สมชาย ใจดี · ครู · ฝ่ายวิชาการ');
  });
});
