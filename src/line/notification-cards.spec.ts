import type { messagingApi } from '@line/bot-sdk';
import { AUTO_REJECTED_REASON } from '../bookings/bookings.constants';
import {
  AUTO_REJECTED_NOTICE,
  buildDecisionCard,
  buildReminderCard,
  type DecisionCardOptions,
  type DecisionCardStatus,
  type ReminderCardOptions,
} from './notification-cards';

/**
 * The bubble's shape and copy are asserted HERE, against
 * `docs/prototypes/client-portal/line_notification_rich_cards_spec.md`. The services' specs only
 * assert which notice goes out for which transition.
 */

const LIFF = 'https://liff.line.me/1234567890-abcdefgh';

/** Every text node in the bubble, flattened, so a test can ask "does it say this anywhere". */
const textsOf = (node: unknown): string[] => {
  if (!node || typeof node !== 'object') return [];
  const n = node as Record<string, unknown>;
  const here = n.type === 'text' && typeof n.text === 'string' ? [n.text] : [];
  const kids = Array.isArray(n.contents) ? n.contents.flatMap(textsOf) : [];
  const parts = ['header', 'body', 'footer', 'hero'].flatMap((k) =>
    k in n ? textsOf(n[k]) : [],
  );
  return [...here, ...kids, ...parts];
};

const bubbleOf = (m: messagingApi.FlexMessage) =>
  m.contents as messagingApi.FlexBubble;

const base = (
  status: DecisionCardStatus,
  over: Partial<DecisionCardOptions> = {},
): DecisionCardOptions => ({
  status,
  bookingCode: 'BR-25690918-001',
  purpose: 'อบรมเชิงปฏิบัติการพัฒนาเว็บแอป',
  attendees: 50,
  venueName: 'ห้องประชุมใหญ่ อาคาร 50 พรรษา',
  venueLocation: 'ชั้น 3 อาคาร 50 พรรษา',
  dateText: '18 ก.ย. 2569',
  periodText: '09:00 - 12:00 น.',
  bookingId: 'bk1',
  venueId: 'vn1',
  liffUrl: LIFF,
  ...over,
});

const ALL: DecisionCardStatus[] = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'AUTO_REJECTED',
  'EXPIRED',
  'CANCELLED_BY_STAFF',
  'CANCELLED_BY_USER',
  'SLOT_AVAILABLE',
];

describe('buildDecisionCard', () => {
  it.each([
    ['PENDING', '#f59e0b', '#0f172a', 'ยื่นคำขอสำเร็จ (รอการพิจารณา)'],
    ['APPROVED', '#047857', '#ffffff', 'อนุมัติคำขอแล้ว'],
    ['REJECTED', '#be123c', '#ffffff', 'คำขอไม่ได้รับอนุมัติ'],
    ['AUTO_REJECTED', '#0369a1', '#ffffff', AUTO_REJECTED_NOTICE],
    ['EXPIRED', '#334155', '#ffffff', 'หมดเวลาพิจารณา'],
    [
      'CANCELLED_BY_STAFF',
      '#be123c',
      '#ffffff',
      'การจองของคุณถูกยกเลิกโดยเจ้าหน้าที่',
    ],
    ['CANCELLED_BY_USER', '#334155', '#ffffff', 'ยกเลิกรายการจองสำเร็จแล้ว'],
    ['SLOT_AVAILABLE', '#047857', '#ffffff', 'ช่วงเวลานี้เปิดให้จองอีกครั้ง'],
  ] as [DecisionCardStatus, string, string, string][])(
    '%s wears %s with %s ink and the spec headline',
    (status, fill, ink, headline) => {
      const card = buildDecisionCard(base(status));
      const header = bubbleOf(card).header as messagingApi.FlexBox;
      const [eyebrow, title] = header.contents as messagingApi.FlexText[];

      expect(card.type).toBe('flex');
      expect(header.backgroundColor).toBe(fill);
      expect(title.text).toBe(headline);
      expect(title.color).toBe(ink);
      // Spec §1.1: eyebrow at 75% of the ink.
      expect(eyebrow.color).toBe(`${ink}bf`);
    },
  );

  it.each([
    [
      'PENDING',
      'ยื่นคำขอจองสำเร็จ: ห้องประชุมใหญ่ อาคาร 50 พรรษา วันที่ 18 ก.ย. 2569 09:00 - 12:00 น. (รหัส BR-25690918-001) อยู่ระหว่างรอพิจารณา',
    ],
    [
      'APPROVED',
      'อนุมัติคำขอจอง: ห้องประชุมใหญ่ อาคาร 50 พรรษา วันที่ 18 ก.ย. 2569 09:00 - 12:00 น. (รหัส BR-25690918-001)',
    ],
    [
      'REJECTED',
      'คำขอจองไม่ผ่านการอนุมัติ: ห้องประชุมใหญ่ อาคาร 50 พรรษา วันที่ 18 ก.ย. 2569 09:00 - 12:00 น.',
    ],
    [
      'AUTO_REJECTED',
      'ช่วงเวลา 18 ก.ย. 2569 09:00 - 12:00 น. ห้องประชุมใหญ่ อาคาร 50 พรรษา มีผู้ได้รับสิทธิ์แล้ว ระบบจึงยกเลิกคำขอของคุณ',
    ],
    [
      'EXPIRED',
      'คำขอจองหมดเวลาพิจารณา: ห้องประชุมใหญ่ อาคาร 50 พรรษา วันที่ 18 ก.ย. 2569 09:00 - 12:00 น. (รหัส BR-25690918-001)',
    ],
    [
      'CANCELLED_BY_STAFF',
      'การจองของคุณถูกยกเลิก: ห้องประชุมใหญ่ อาคาร 50 พรรษา วันที่ 18 ก.ย. 2569 09:00 - 12:00 น. โดยเจ้าหน้าที่',
    ],
    [
      'CANCELLED_BY_USER',
      'ยกเลิกการจองสำเร็จ: ห้องประชุมใหญ่ อาคาร 50 พรรษา วันที่ 18 ก.ย. 2569 09:00 - 12:00 น. (รหัส BR-25690918-001)',
    ],
    [
      'SLOT_AVAILABLE',
      'ช่วงเวลา 18 ก.ย. 2569 09:00 - 12:00 น. ห้องประชุมใหญ่ อาคาร 50 พรรษา เปิดให้จองได้อีกครั้ง',
    ],
  ] as [DecisionCardStatus, string][])(
    '%s altText follows the spec template',
    (status, altText) => {
      expect(buildDecisionCard(base(status)).altText).toBe(altText);
    },
  );

  it.each([
    ['PENDING', 'รหัสคำขอ'],
    ['APPROVED', 'รหัสการจอง'],
    ['REJECTED', 'รหัสคำขอ'],
    ['AUTO_REJECTED', 'รหัสคำขอ'],
    ['EXPIRED', 'รหัสคำขอ'],
    ['CANCELLED_BY_STAFF', 'รหัสการจอง'],
    ['CANCELLED_BY_USER', 'รหัสคำขอ'],
  ] as [DecisionCardStatus, string][])(
    '%s uses the Purpose-First 2-box layout with the "%s" label',
    (status, codeLabel) => {
      const texts = textsOf(bubbleOf(buildDecisionCard(base(status))));

      // Box 1 — ข้อมูลการจอง
      expect(texts).toEqual(
        expect.arrayContaining([
          'ข้อมูลการจอง',
          codeLabel,
          'BR-25690918-001',
          'วัตถุประสงค์',
          'อบรมเชิงปฏิบัติการพัฒนาเว็บแอป',
          'ผู้เข้าร่วม',
          '50 คน',
        ]),
      );
      // Box 2 — ข้อมูลสถานที่
      expect(texts).toEqual(
        expect.arrayContaining([
          'ข้อมูลสถานที่',
          'สถานที่',
          'ห้องประชุมใหญ่ อาคาร 50 พรรษา',
          'อาคาร/พิกัด',
          'ชั้น 3 อาคาร 50 พรรษา',
          'วันที่ใช้งาน',
          '18 ก.ย. 2569',
          'ช่วงเวลา',
          '09:00 - 12:00 น.',
        ]),
      );
      // Box 1 comes before box 2.
      expect(texts.indexOf('ข้อมูลการจอง')).toBeLessThan(
        texts.indexOf('ข้อมูลสถานที่'),
      );
    },
  );

  it('SLOT_AVAILABLE shows the venue box only', () => {
    const texts = textsOf(bubbleOf(buildDecisionCard(base('SLOT_AVAILABLE'))));

    expect(texts).toContain('ข้อมูลสถานที่');
    expect(texts).not.toContain('ข้อมูลการจอง');
    expect(texts).not.toContain('BR-25690918-001');
  });

  it('drops the location row, never renders an empty text node', () => {
    const card = buildDecisionCard(
      base('APPROVED', { venueLocation: undefined, purpose: '  ' }),
    );
    const texts = textsOf(bubbleOf(card));

    expect(texts).not.toContain('อาคาร/พิกัด');
    expect(texts).not.toContain('วัตถุประสงค์');
    // LINE rejects the WHOLE message on an empty text node.
    for (const status of ALL) {
      for (const t of textsOf(bubbleOf(buildDecisionCard(base(status))))) {
        expect(t.trim().length).toBeGreaterThan(0);
      }
    }
  });

  describe('🔴 D-C13 — AUTO_REJECTED never reveals who took the slot or why', () => {
    const leak =
      'อนุมัติให้ นายสมศักดิ์ รักเรียน เพื่อจัดงานเลี้ยงรุ่นคณะวิศวะ';

    it('ignores any reason passed in, in the bubble AND in the altText', () => {
      const card = buildDecisionCard(base('AUTO_REJECTED', { reason: leak }));
      const serialised = JSON.stringify(card);

      expect(serialised).not.toContain('สมศักดิ์');
      expect(serialised).not.toContain('งานเลี้ยงรุ่น');
      expect(textsOf(bubbleOf(card))).not.toContain('เหตุผลจากเจ้าหน้าที่');
    });

    it('never carries the stored auto-reject reason either', () => {
      const card = buildDecisionCard(
        base('AUTO_REJECTED', { reason: AUTO_REJECTED_REASON }),
      );

      expect(JSON.stringify(card)).not.toContain(AUTO_REJECTED_REASON);
    });

    it('says only the obscured spec wording', () => {
      const card = buildDecisionCard(base('AUTO_REJECTED'));

      expect(AUTO_REJECTED_NOTICE).toBe(
        'ช่วงเวลาดังกล่าวมีผู้ได้รับสิทธิ์แล้ว',
      );
      expect(card.altText).toContain('มีผู้ได้รับสิทธิ์แล้ว');
      expect(textsOf(bubbleOf(card))).toEqual(
        expect.arrayContaining([
          AUTO_REJECTED_NOTICE,
          'ขออภัย ช่วงเวลาที่คุณส่งคำขอมีผู้ได้รับอนุมัติสิทธิ์การใช้งานแล้ว ระบบจึงทำการยกเลิกคำขอของคุณโดยอัตโนมัติ',
          'คุณสามารถเลือกดูตารางและยื่นคำขอในช่วงเวลาอื่นได้ทันที',
        ]),
      );
    });
  });

  it.each([
    ['REJECTED', 'เหตุผลประกอบ'],
    ['CANCELLED_BY_STAFF', 'เหตุผลการยกเลิก'],
  ] as [DecisionCardStatus, string][])(
    '%s shows the operator reason in its own bordered box, labelled "%s"',
    (status, label) => {
      const card = buildDecisionCard(
        base(status, { reason: 'สถานที่ปิดปรับปรุงระบบไฟฟ้า' }),
      );
      const body = bubbleOf(card).body as messagingApi.FlexBox;
      const box = body.contents.find(
        (c) => (c as messagingApi.FlexBox).borderColor === '#e2e8f0',
      ) as messagingApi.FlexBox;

      expect(box).toBeDefined();
      expect(textsOf(box)).toEqual([
        'เหตุผลจากเจ้าหน้าที่',
        label,
        'สถานที่ปิดปรับปรุงระบบไฟฟ้า',
      ]);
    },
  );

  it('omits the reason box when the reason is blank, and ignores a reason on APPROVED', () => {
    expect(
      textsOf(bubbleOf(buildDecisionCard(base('REJECTED', { reason: ' ' })))),
    ).not.toContain('เหตุผลจากเจ้าหน้าที่');
    expect(
      JSON.stringify(buildDecisionCard(base('APPROVED', { reason: 'ลับ' }))),
    ).not.toContain('ลับ');
  });

  it.each([
    ['PENDING', 'ดูรายละเอียดคำขอจอง', '#0f172a', '#/booking/bk1'],
    ['APPROVED', 'ดูรายละเอียดคำขอจอง', '#047857', '#/booking/bk1'],
    ['REJECTED', 'เลือกจองช่วงเวลาอื่น', '#0f172a', '#/venue/vn1'],
    ['AUTO_REJECTED', 'ค้นหาช่วงเวลาอื่นที่ว่าง', '#0369a1', '#/venue/vn1'],
    ['EXPIRED', 'เลือกจองช่วงเวลาอื่น', '#334155', '#/venue/vn1'],
    ['CANCELLED_BY_STAFF', 'ดูรายละเอียดคำขอจอง', '#0f172a', '#/booking/bk1'],
    ['CANCELLED_BY_USER', 'ค้นหาสถานที่เพื่อจองใหม่', '#334155', '#/venues'],
    ['SLOT_AVAILABLE', 'ส่งคำขอจองทันที', '#047857', '#/venue/vn1'],
  ] as [DecisionCardStatus, string, string, string][])(
    '%s CTA "%s" (%s) deep-links to LIFF %s',
    (status, label, color, route) => {
      const footer = bubbleOf(buildDecisionCard(base(status)))
        .footer as messagingApi.FlexBox;
      const button = footer.contents[0] as messagingApi.FlexButton;

      expect(button.style).toBe('primary');
      expect(button.color).toBe(color);
      expect(button.action).toEqual({
        type: 'uri',
        label,
        uri: `${LIFF}${route}`,
      });
    },
  );

  it.each(ALL)(
    '%s hides the footer when LINE_LIFF_URL is unset (fail-soft CTA)',
    (status) => {
      expect(
        bubbleOf(buildDecisionCard(base(status, { liffUrl: null }))).footer,
      ).toBeUndefined();
      expect(
        bubbleOf(buildDecisionCard(base(status, { liffUrl: undefined })))
          .footer,
      ).toBeUndefined();
    },
  );

  it('hides the footer when the route cannot be built, rather than linking nowhere', () => {
    expect(
      bubbleOf(buildDecisionCard(base('APPROVED', { bookingId: undefined })))
        .footer,
    ).toBeUndefined();
    expect(
      bubbleOf(buildDecisionCard(base('EXPIRED', { venueId: undefined })))
        .footer,
    ).toBeUndefined();
  });

  it('EXPIRED carries its "apply again" footnote', () => {
    expect(textsOf(bubbleOf(buildDecisionCard(base('EXPIRED'))))).toContain(
      'หากยังต้องการใช้งานสถานที่ กรุณายื่นคำขอใหม่อีกครั้ง',
    );
  });
});

describe('buildReminderCard', () => {
  const reminder = (
    over: Partial<ReminderCardOptions> = {},
  ): ReminderCardOptions => ({
    leadTimeText: '1 ชั่วโมง',
    bookingCode: 'BR-25690918-001',
    purpose: 'อบรมเชิงปฏิบัติการพัฒนาเว็บแอป',
    attendees: 50,
    venueName: 'ห้องประชุมใหญ่ อาคาร 50 พรรษา',
    venueLocation: 'ชั้น 3 อาคาร 50 พรรษา',
    dateText: 'วันนี้ (18 ก.ย. 2569)',
    periodText: '09:00 - 12:00 น.',
    ...over,
  });

  it('is amber with DARK ink, and the spec headline', () => {
    const header = bubbleOf(buildReminderCard(reminder()))
      .header as messagingApi.FlexBox;
    const [eyebrow, title] = header.contents as messagingApi.FlexText[];

    expect(header.backgroundColor).toBe('#f59e0b');
    expect(title.color).toBe('#0f172a');
    expect(eyebrow.color).toBe('#0f172abf');
    expect(eyebrow.text).toBe('เตือนความจำการใช้งาน');
    expect(title.text).toBe('ใกล้ถึงเวลาเข้าใช้งานแล้ว');
  });

  it('is pure informational — no footer, no button, ever', () => {
    const card = buildReminderCard(reminder());

    expect(bubbleOf(card).footer).toBeUndefined();
    expect(JSON.stringify(card)).not.toContain('"button"');
    expect(JSON.stringify(card)).not.toContain('liff');
  });

  it.each(['1 ชั่วโมง', '30 นาที'] as ReminderCardOptions['leadTimeText'][])(
    'states the lead time "%s"',
    (leadTimeText) => {
      expect(
        textsOf(bubbleOf(buildReminderCard(reminder({ leadTimeText })))),
      ).toContain(`รายการจองสถานที่ของคุณใกล้จะเริ่มต้นในอีก ${leadTimeText}`);
    },
  );

  it('keeps the Purpose-First boxes, with "รหัสการจอง" and "วันที่"', () => {
    const texts = textsOf(bubbleOf(buildReminderCard(reminder())));

    expect(texts).toEqual(
      expect.arrayContaining([
        'ข้อมูลการจอง',
        'รหัสการจอง',
        'BR-25690918-001',
        'อบรมเชิงปฏิบัติการพัฒนาเว็บแอป',
        '50 คน',
        'ข้อมูลสถานที่',
        'วันที่',
        'วันนี้ (18 ก.ย. 2569)',
        '09:00 - 12:00 น.',
        'เมื่อถึงเวลาตามกำหนด คุณสามารถเข้าใช้งานสถานที่ได้ทันที',
      ]),
    );
    expect(texts.indexOf('ข้อมูลการจอง')).toBeLessThan(
      texts.indexOf('ข้อมูลสถานที่'),
    );
  });

  it('altText follows the spec template', () => {
    expect(buildReminderCard(reminder()).altText).toBe(
      'เตือนความจำ: ใกล้ถึงเวลาเข้าใช้สถานที่ ห้องประชุมใหญ่ อาคาร 50 พรรษา เวลา 09:00 - 12:00 น.',
    );
  });
});
