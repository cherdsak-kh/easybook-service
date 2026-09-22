import type { messagingApi } from '@line/bot-sdk';
import {
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_TITLE_MAX,
} from '../announcements/announcements.constants';
import {
  ANNOUNCEMENT_ALT_PREFIX,
  ANNOUNCEMENT_CARD_HEADER,
  buildAnnouncementCard,
  buildAnnouncementText,
} from './announcement-card';
import { ALT_TEXT_MAX_CHARS } from './notification-cards';

/**
 * AC-3 / D-F / D-K. The limits are asserted against NAMED numbers, so raising a DTO cap (title 100,
 * body 1000) without re-checking LINE's limits fails here, loudly.
 */
const LINE_TEXT_MAX_CHARS = 5000; // LINE: a text message's `text`
const LINE_ALT_TEXT_MAX_CHARS = 400; // LINE: a Flex message's `altText`
const LINE_FLEX_MAX_BYTES = 30_000; // LINE: a Flex container, JSON-encoded

const SENT_AT = '22 ก.ย. 2569 14:05 น.';

const texts = (
  box: messagingApi.FlexComponent | undefined,
): messagingApi.FlexText[] =>
  ((box as messagingApi.FlexBox).contents ?? []) as messagingApi.FlexText[];

describe('buildAnnouncementCard (AC-3, D-K)', () => {
  const card = buildAnnouncementCard({
    title: 'ปิดปรับปรุงห้องประชุม',
    body: 'บรรทัดแรก\nบรรทัดที่สอง',
    sentAtText: SENT_AT,
  });
  const bubble = card.contents as messagingApi.FlexBubble;

  it('is one Flex bubble', () => {
    expect(card.type).toBe('flex');
    expect(bubble.type).toBe('bubble');
  });

  it('has the emerald "ประกาศจาก EasyBook" header band with white text', () => {
    expect(bubble.header?.backgroundColor).toBe('#047857');
    const [header] = texts(bubble.header);
    expect(header.text).toBe(ANNOUNCEMENT_CARD_HEADER);
    expect(header.text).toBe('ประกาศจาก EasyBook');
    expect(header.color).toBe('#ffffff');
  });

  it('carries the title (bold) and the body, both wrapped — newlines kept', () => {
    const [title, body] = texts(bubble.body);
    expect(title).toMatchObject({
      text: 'ปิดปรับปรุงห้องประชุม',
      weight: 'bold',
      wrap: true,
    });
    expect(body).toMatchObject({
      text: 'บรรทัดแรก\nบรรทัดที่สอง',
      wrap: true,
    });
  });

  it('has a text-only footer: the send time and "EasyBook"', () => {
    const footer = texts(bubble.footer);
    expect(footer.map((t) => t.type)).toEqual(['text', 'text']);
    expect(footer.map((t) => t.text)).toEqual([SENT_AT, 'EasyBook']);
  });

  it('has NO action anywhere and NO maxLines (D-K: no dead button, no silent clamp)', () => {
    const json = JSON.stringify(card);
    expect(json).not.toContain('"action"');
    expect(json).not.toContain('"maxLines"');
    expect(json).not.toContain('"button"');
  });

  it('uses only 6-digit #rrggbb colours', () => {
    const colours = JSON.stringify(card).match(/#[0-9a-fA-F]+/g) ?? [];
    expect(colours.length).toBeGreaterThan(0);
    for (const c of colours) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('altText is "ประกาศ: {title}" on one line', () => {
    expect(card.altText).toBe(
      `${ANNOUNCEMENT_ALT_PREFIX}ปิดปรับปรุงห้องประชุม`,
    );
    expect(card.altText.startsWith('ประกาศ: ')).toBe(true);
  });

  it('D-F — at the DTO maxima, altText ≤ 400 and the bubble stays far under 30 KB', () => {
    const max = buildAnnouncementCard({
      title: 'ก'.repeat(ANNOUNCEMENT_TITLE_MAX),
      body: 'ข'.repeat(ANNOUNCEMENT_BODY_MAX),
      sentAtText: SENT_AT,
    });
    expect(ANNOUNCEMENT_TITLE_MAX).toBe(100);
    expect(ANNOUNCEMENT_BODY_MAX).toBe(1000);
    expect(ALT_TEXT_MAX_CHARS).toBe(LINE_ALT_TEXT_MAX_CHARS);
    expect(max.altText.length).toBeLessThanOrEqual(LINE_ALT_TEXT_MAX_CHARS);
    expect(max.altText.startsWith(ANNOUNCEMENT_ALT_PREFIX)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(max.contents))).toBeLessThan(
      LINE_FLEX_MAX_BYTES,
    );
  });

  it('a 450-character title (defensive) still yields altText ≤ 400', () => {
    const long = buildAnnouncementCard({
      title: 'x'.repeat(450),
      body: 'b',
      sentAtText: SENT_AT,
    });
    expect(long.altText.length).toBeLessThanOrEqual(LINE_ALT_TEXT_MAX_CHARS);
  });

  it('a multi-line title collapses to one line in altText', () => {
    expect(
      buildAnnouncementCard({ title: 'a\nb', body: 'c', sentAtText: SENT_AT })
        .altText,
    ).toBe('ประกาศ: a b');
  });
});

describe('buildAnnouncementText (AC-3, D-F)', () => {
  it('is exactly one text message: title, blank line, body', () => {
    expect(buildAnnouncementText('T', 'B')).toEqual({
      type: 'text',
      text: 'T\n\nB',
    });
  });

  it('at the DTO maxima stays under LINE’s 5,000-character text limit', () => {
    const msg = buildAnnouncementText(
      'ก'.repeat(ANNOUNCEMENT_TITLE_MAX),
      'ข'.repeat(ANNOUNCEMENT_BODY_MAX),
    );
    expect(msg.text.length).toBe(100 + 2 + 1000);
    expect(msg.text.length).toBeLessThanOrEqual(LINE_TEXT_MAX_CHARS);
  });
});
