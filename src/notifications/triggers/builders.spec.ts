import { AppAccess } from '@prisma/client';
import { normaliseCreateInput } from '../notifications.service';
import {
  buildB1,
  buildB2,
  buildB3,
  buildB4,
  buildB5,
  buildC1,
  buildC2,
  buildC3,
  buildC4,
  buildC5,
  buildF1,
  buildF2,
  buildU1,
  buildU2,
  buildU3,
  clip,
  codeList,
  when,
} from './builders';

const PHONE_RE = /\d{3}-?\d{3}-?\d{4}/;
const PERSON = {
  firstName: 'สมชาย',
  lastName: 'ใจดี',
  personnelRole: { name: 'ครู' },
  department: { name: 'ฝ่ายวิชาการ' },
};
const SLOT = {
  startAt: new Date('2026-09-18T02:00:00Z'),
  endAt: new Date('2026-09-18T04:00:00Z'),
};

describe('builders — pure text helpers', () => {
  it('codeList: ≤10 codes joined, no suffix', () => {
    const codes = Array.from({ length: 10 }, (_, i) => `BR-${i}`);
    expect(codeList(codes, 10)).toBe(codes.join(', '));
  });

  it('codeList: 11 codes shows the first 10 plus "และอีก 1 รายการ"', () => {
    const codes = Array.from({ length: 11 }, (_, i) => `BR-${i}`);
    const result = codeList(codes, 11);
    expect(result).toBe(`${codes.slice(0, 10).join(', ')} และอีก 1 รายการ`);
  });

  it('codeList: 25 total (only 10 codes passed) shows "และอีก 15 รายการ"', () => {
    const codes = Array.from({ length: 10 }, (_, i) => `BR-${i}`);
    expect(codeList(codes, 25)).toBe(`${codes.join(', ')} และอีก 15 รายการ`);
  });

  it('clip: a 5000-char subject clips inside the builder, keeping the body well under 1000', () => {
    const huge = 'ก'.repeat(5000);
    const input = buildF1({ code: 'FDB-1', subject: huge, reporter: PERSON });
    expect(input.body.length).toBeLessThanOrEqual(1000);
    expect(clip(huge, 120).length).toBe(120);
  });

  it('when(): one shared period → "<date> เวลา <period>"', () => {
    expect(when([SLOT])).toMatch(/เวลา/);
  });

  it('when(): mixed periods → "(หลายช่วงเวลา)"', () => {
    const other = {
      startAt: new Date('2026-09-18T05:00:00Z'),
      endAt: new Date('2026-09-18T06:00:00Z'),
    };
    expect(when([SLOT, other])).toContain('(หลายช่วงเวลา)');
  });
});

describe('builders — per-UC binding columns and actionUrl validity', () => {
  it('U1', () => {
    const i = buildU1({ ...PERSON, phone: '081-234-5678' });
    expect(i).toMatchObject({
      category: 'REGISTRATION',
      tone: 'AMBER',
      icon: 'user-plus',
      targetRole: 'ADMIN',
      actionUrl: '/backend/line-users',
      actionLabel: 'ตรวจสอบการลงทะเบียน',
    });
    expect(i.body).toContain('สมชาย ใจดี');
    expect(i.body).toContain('081-234-5678');
    expect(() => normaliseCreateInput(i)).not.toThrow();
  });

  it('U2', () => {
    const i = buildU2(PERSON);
    expect(i).toMatchObject({
      category: 'REGISTRATION',
      tone: 'AMBER',
      icon: 'arrow-path',
      targetRole: 'ADMIN',
      actionUrl: '/backend/line-users',
    });
    expect(i.body).toContain('สมชาย ใจดี');
    expect(() => normaliseCreateInput(i)).not.toThrow();
  });

  it('U3', () => {
    const i = buildU3({
      registration: PERSON,
      access: AppAccess.PENDING,
      pendingCount: 2,
      pendingCodes: ['BR-1', 'BR-2'],
    });
    expect(i).toMatchObject({
      category: 'REGISTRATION',
      tone: 'SLATE',
      icon: 'user-minus',
      targetRole: 'SUPER_ADMIN',
      actionUrl: '/backend/line-users',
    });
    expect(i.body).toContain('รอตรวจสอบ');
    expect(i.body).toContain('BR-1, BR-2');
    expect(() => normaliseCreateInput(i)).not.toThrow();
  });

  it('U3 with no registration falls back to the LINE-user copy', () => {
    const i = buildU3({
      registration: null,
      access: AppAccess.ALLOWED,
      pendingCount: 1,
      pendingCodes: ['BR-1'],
    });
    expect(i.body).toContain('ผู้ใช้ LINE ที่ยังไม่ลงทะเบียน');
  });

  it('B1', () => {
    const i = buildB1({
      code: 'BR-1',
      venueName: 'ห้อง A',
      slots: [SLOT],
      requester: PERSON,
    });
    expect(i).toMatchObject({
      category: 'BOOKING',
      tone: 'SKY',
      icon: 'calendar',
      targetRole: 'ADMIN',
      code: 'BR-1',
      actionUrl: '/backend/bookings/requests?status=PENDING',
    });
    expect(i.body).toContain('BR-1');
    expect(i.body).toContain('ห้อง A');
    expect(i.body).toContain('สมชาย ใจดี');
    expect(() => normaliseCreateInput(i)).not.toThrow();
  });

  it('B2 — whole request, ALL target, no phone', () => {
    const i = buildB2({
      code: 'BR-1',
      venueName: 'ห้อง A',
      slots: [SLOT],
      requester: PERSON,
      slotOnly: false,
    });
    expect(i.targetRole).toBe('ALL');
    expect(i.body).not.toMatch(PHONE_RE);
    expect(() => normaliseCreateInput(i)).not.toThrow();
  });

  it('B2 — slot-only variant names the freed slot, not the whole request', () => {
    const i = buildB2({
      code: 'BR-1',
      venueName: 'ห้อง A',
      slots: [SLOT],
      requester: PERSON,
      slotOnly: true,
    });
    expect(i.body).toContain('ยกเลิกเฉพาะ');
  });

  it('B3 — single expiry names the code and venue', () => {
    const i = buildB3({
      count: 1,
      codes: ['BR-1'],
      single: { venueName: 'ห้อง A', startAt: SLOT.startAt },
    });
    expect(i.code).toBe('BR-1');
    expect(i.body).toContain('BR-1');
    expect(() => normaliseCreateInput(i)).not.toThrow();
  });

  it('B3 — N>1 has a null code and a code list in the body', () => {
    const i = buildB3({ count: 2, codes: ['BR-1', 'BR-2'] });
    expect(i.code).toBeNull();
    expect(i.body).toContain('หมดอายุ 2 รายการ');
  });

  it('B4', () => {
    const i = buildB4({
      approvedCode: 'BR-1',
      venueName: 'ห้อง A',
      loserCodes: ['BR-2', 'BR-3'],
      actorText: 'วีระ ทองดี · ผู้ดูแลระบบ',
    });
    expect(i).toMatchObject({
      category: 'BOOKING',
      tone: 'ROSE',
      icon: 'queue-list',
      targetRole: 'ADMIN',
      code: 'BR-1',
    });
    expect(i.title).toContain('2 รายการ');
    expect(i.body).toContain('BR-2, BR-3');
    expect(() => normaliseCreateInput(i)).not.toThrow();
  });

  it('B5 — ALL target, no phone, no requester name used', () => {
    const i = buildB5({
      code: 'BR-1',
      venueName: 'ห้อง A',
      slots: [SLOT],
      actorText: 'วีระ ทองดี',
    });
    expect(i.targetRole).toBe('ALL');
    expect(i.body).not.toMatch(PHONE_RE);
    expect(() => normaliseCreateInput(i)).not.toThrow();
  });

  it('F1', () => {
    const i = buildF1({ code: 'FDB-1', subject: 'ขอบคุณ', reporter: PERSON });
    expect(i).toMatchObject({
      category: 'FEEDBACK',
      tone: 'SKY',
      icon: 'chat-bubble',
      targetRole: 'ADMIN',
      code: 'FDB-1',
    });
    expect(() => normaliseCreateInput(i)).not.toThrow();
  });

  it('F2 — ALL target, no phone even though the reporter has one elsewhere', () => {
    const i = buildF2({
      code: 'ISS-1',
      subject: 'แอร์เสีย',
      venueName: 'ห้อง A',
      reporter: PERSON,
    });
    expect(i.targetRole).toBe('ALL');
    expect(i.body).not.toMatch(PHONE_RE);
    expect(() => normaliseCreateInput(i)).not.toThrow();
  });

  it('F2 — no venue falls back to "ไม่ระบุสถานที่"', () => {
    const i = buildF2({
      code: 'ISS-1',
      subject: 'แอร์เสีย',
      venueName: null,
      reporter: PERSON,
    });
    expect(i.body).toContain('ไม่ระบุสถานที่');
  });

  it('C1', () => {
    const i = buildC1({
      operation: 'push',
      kind: 'RATE_LIMITED',
      status: 429,
      at: SLOT.startAt,
    });
    expect(i).toMatchObject({
      category: 'SYSTEM',
      tone: 'ROSE',
      icon: 'link-slash',
      targetRole: 'ADMIN',
    });
    expect(i.body).toContain('HTTP 429');
    expect(() => normaliseCreateInput(i)).not.toThrow();
  });

  it('C2 — never a double "v"', () => {
    const i = buildC2({ previous: 'v0.7.0', current: '0.8.0' });
    expect(i.code).toBe('v0.8.0');
    expect(i.title).toContain('v0.8.0');
    expect(i.body).toBe('v0.7.0 → v0.8.0 · รีเฟรชหน้าจอเพื่อใช้งานฟีเจอร์ใหม่');
    expect(() => normaliseCreateInput(i)).not.toThrow();
  });

  it('C3', () => {
    const i = buildC3({
      venueName: 'ห้อง A',
      reason: 'ปิดปรับปรุง',
      actorText: 'วีระ ทองดี',
    });
    expect(i).toMatchObject({
      category: 'SYSTEM',
      tone: 'AMBER',
      icon: 'building-office',
      targetRole: 'ALL',
    });
    expect(i.title).toContain('ห้อง A');
    expect(() => normaliseCreateInput(i)).not.toThrow();
  });

  it('C4', () => {
    const i = buildC4({
      key: 'booking.cancel_lead_minutes',
      oldValue: '60',
      newValue: '120',
      actorText: 'วีระ ทองดี',
    });
    expect(i).toMatchObject({
      category: 'SYSTEM',
      tone: 'SLATE',
      icon: 'adjustments-horizontal',
      targetRole: 'ADMIN',
    });
    expect(i.code).toBe('booking.cancel_lead_minutes');
    expect(i.body).toContain('60 → 120');
    expect(() => normaliseCreateInput(i)).not.toThrow();
  });

  it('C5', () => {
    const i = buildC5({
      status: 500,
      errorCode: 'P2034',
      handler: 'VenuesController.list',
      method: 'GET',
      routeTemplate: '/api/v1/venues',
    });
    expect(i).toMatchObject({
      category: 'SYSTEM',
      tone: 'ROSE',
      icon: 'bug-ant',
      targetRole: 'SUPER_ADMIN',
      code: 'P2034',
    });
    expect(i.title).toContain('500');
    expect(() => normaliseCreateInput(i)).not.toThrow();
  });

  it('every ALL-targeted body fails the phone regex', () => {
    const bodies = [
      buildB2({
        code: 'BR-1',
        venueName: 'A',
        slots: [SLOT],
        requester: PERSON,
        slotOnly: false,
      }).body,
      buildB5({ code: 'BR-1', venueName: 'A', slots: [SLOT], actorText: 'x' })
        .body,
      buildF2({ code: 'ISS-1', subject: 's', venueName: 'A', reporter: PERSON })
        .body,
      buildC2({ previous: '0.1.0', current: '0.2.0' }).body,
      buildC3({ venueName: 'A', reason: 'r', actorText: 'x' }).body,
    ];
    for (const body of bodies) expect(body).not.toMatch(PHONE_RE);
  });
});
