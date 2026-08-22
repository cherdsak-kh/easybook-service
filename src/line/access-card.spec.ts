import { AppAccess } from '@prisma/client';
import type { messagingApi } from '@line/bot-sdk';
import { buildAccessCard, type CardAccess } from './access-card';

/**
 * The bubble's shape is asserted HERE and nowhere else.
 *
 * `line-user.service.spec.ts` matches on `altText` alone, because those tests are about which copy
 * goes out for which transition. Pinning the layout in each of them would turn a padding change
 * into thirty red tests and would test the routing no better.
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

const ALL: CardAccess[] = [
  AppAccess.PENDING,
  AppAccess.ALLOWED,
  AppAccess.REJECTED,
  AppAccess.BLOCKED,
];

describe('buildAccessCard', () => {
  it.each(ALL)(
    '%s is a flex message whose altText is the caller’s copy',
    (access) => {
      // ⚠️ The notification banner, the chat-list preview, and every client that cannot render
      // Flex. Passing the ORIGINAL plain-text sentence through is what makes the redesign additive:
      // a user who only reads the banner gets exactly what they used to get.
      const card = buildAccessCard(access, 'ข้อความเดิมบรรทัดเดียว');

      expect(card.type).toBe('flex');
      expect(card.altText).toBe('ข้อความเดิมบรรทัดเดียว');
      expect(bubbleOf(card).type).toBe('bubble');
    },
  );

  it.each([
    [AppAccess.PENDING, '#92400e'],
    [AppAccess.ALLOWED, '#047857'],
    [AppAccess.REJECTED, '#0369a1'],
    [AppAccess.BLOCKED, '#be123c'],
  ] as [CardAccess, string][])(
    '%s wears the back-office badge colour %s',
    (access, hex) => {
      // The exact `@theme` token behind that status's badge in the prototype. The operator who
      // pressed the button and the user who receives the result see the same hue.
      const header = bubbleOf(buildAccessCard(access, 'x'))
        .header as messagingApi.FlexBox;
      expect(header.backgroundColor).toBe(hex);
    },
  );

  it('puts the rejection reason in its own block, not buried in a sentence', () => {
    const card = buildAccessCard(AppAccess.REJECTED, 'alt', {
      reason: 'เบอร์โทรศัพท์ไม่ตรงกับที่แจ้งไว้',
    });

    const texts = textsOf(bubbleOf(card));
    expect(texts).toContain('เหตุผล');
    expect(texts).toContain('เบอร์โทรศัพท์ไม่ตรงกับที่แจ้งไว้');
  });

  it('omits the reason block when there is no reason', () => {
    // Defensive rather than reachable — `updateAccess` guarantees a non-empty reason on REJECTED —
    // but a card with an empty grey box would look like a rendering bug to the person receiving it.
    const texts = textsOf(bubbleOf(buildAccessCard(AppAccess.REJECTED, 'alt')));
    expect(texts).not.toContain('เหตุผล');
  });

  it.each([AppAccess.ALLOWED, AppAccess.REJECTED] as CardAccess[])(
    '%s carries a button to the LIFF app when the URL is configured',
    (access) => {
      const footer = bubbleOf(buildAccessCard(access, 'alt', { liffUrl: LIFF }))
        .footer as messagingApi.FlexBox;
      const button = footer.contents[0] as messagingApi.FlexButton;

      expect(button.action).toMatchObject({ type: 'uri', uri: LIFF });
    },
  );

  it.each([AppAccess.PENDING, AppAccess.BLOCKED] as CardAccess[])(
    '%s has no button even with the URL set — waiting is the only correct action',
    (access) => {
      // A button that opens an app which shows the same waiting screen teaches the reader that
      // buttons on these cards are decoration.
      expect(
        bubbleOf(buildAccessCard(access, 'alt', { liffUrl: LIFF })).footer,
      ).toBeUndefined();
    },
  );

  it.each(ALL)(
    '%s renders without a footer when LINE_LIFF_URL is unset',
    (access) => {
      // ⚠️ The whole reason the env var is optional. LINE validates a `uri` action and rejects the
      // WHOLE message if it fails — so an unconfigured box must produce a card with no button, never
      // a card with a broken one, or approvals would stop arriving with nothing but a push warning.
      expect(
        bubbleOf(buildAccessCard(access, 'alt', { liffUrl: null })).footer,
      ).toBeUndefined();
    },
  );
});
