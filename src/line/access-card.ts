import { AppAccess } from '@prisma/client';
import type { messagingApi } from '@line/bot-sdk';

/**
 * The four status cards EasyBook pushes to a LINE user — Flex Messages, replacing the plain text
 * lines that used to carry the same news (PO, 22 ส.ค. 2569).
 *
 * ── What a card is for ──
 * A status change is the ONLY thing this product ever says to an end user unprompted, and it
 * arrives in a chat thread beside their friends. As a bare sentence it reads like any other
 * message and carries no hierarchy: the outcome, the explanation and what to do next all have the
 * same weight. A card gives the outcome a coloured band and a headline, the explanation a
 * paragraph, and the next step a button — which is the difference between reading a message and
 * seeing an answer.
 *
 * ── ⚠️ THE COLOURS ARE THE BACK-OFFICE'S OWN TOKENS, NOT NEW ONES ──
 * Each hue is the exact value behind the status badge an operator sees on the การลงทะเบียน row:
 * `--color-success` / `--color-warning` / `--color-info` / `--color-error` from the prototype's
 * `@theme` block, mapped by the same table its CSS comment states (ALLOWED→success,
 * PENDING→warning, REJECTED→info, BLOCKED→error). The person who pressed the button and the
 * person who receives the result are looking at the same colour, which is worth more than any
 * palette chosen for the chat window alone.
 *
 * ⚠️ LIGHT VALUES ONLY, deliberately. Flex Messages do not follow the recipient's LINE dark mode —
 * a bubble renders the colours it declares, on a chat background we do not control. Every
 * foreground here is therefore fixed white or a fixed dark slate against a fixed surface, never a
 * token that assumes a theme.
 *
 * ── ⚠️ `altText` IS THE OLD COPY, WORD FOR WORD ──
 * It is what appears in the phone's notification banner, in the chat list preview, and on any
 * client that cannot render Flex. Reusing the sentences the plain-text pushes used means the
 * redesign adds a card and subtracts nothing: a user who only ever reads the notification gets
 * exactly what they got before. `ACCESS_NOTIFICATION_MESSAGES` in `line-user.service.ts` remains
 * the single source of those strings.
 *
 * ── ⚠️ THE BUTTON IS OPTIONAL AND THE CARD MUST SURVIVE WITHOUT IT ──
 * It needs `LINE_LIFF_URL`, which is not required in any environment (see `env.validation.ts`).
 * Unset — dev boxes, CI, any deploy that has not filled it in — and the footer is simply absent:
 * a card with a dead button would be worse than a card with none, and failing the boot over a
 * convenience link would be worse than both.
 */

/**
 * The band behind each headline, and the ink that goes on it.
 *
 * ── ⚠️ THREE ARE THE PROTOTYPE'S `@theme` TOKEN. THE FOURTH CANNOT BE, AND IT TOOK TWO TRIES TO
 * ACCEPT THAT (PO, 22 ส.ค. 2569 — reported twice, from photographs of a real phone) ──
 *
 * Those tokens are FOREGROUND colours. `.badge-amber` is `bg-warning/10 text-warning`, so
 * `--color-warning` has to be dark enough to read as TEXT on a pale wash — which is why amber-800
 * is as deep as it is. Painted instead as a SOLID FILL it stops being amber: `#92400e` is hue 23°
 * at 31% lightness, which is brown, and the รออนุมัติ card arrived the colour of mud between a
 * crimson one and a green one.
 *
 * The first fix moved one step up the same ramp to amber-700 and **was still brown** — hue 26° at
 * 37%. That was the lesson: the problem was never the exact step, it was the CONSTRAINT. Insisting
 * on white text forces the fill dark, and orange is the one hue that becomes a different colour
 * when you darken it. Every candidate that satisfied white-on-fill was rust, and the second
 * photograph said so.
 *
 * So PENDING inverts instead: **amber-500 `#f59e0b` with slate-900 ink**. Hue 38° — actual amber —
 * and the contrast goes UP rather than down: 8.31:1 for the headline and 5.17:1 for the eyebrow at
 * 75%, against 5.02 and (blended) far less on the white-on-rust version.
 *
 * ⚠️ THE ODD ONE OUT IS THE CORRECT ONE. Dark text on amber is not an inconsistency to apologise
 * for beside three white-on-dark cards — it is what every road sign, hazard tape and design-system
 * warning token does, because amber only exists at a lightness where white does not survive.
 *
 * The other three keep their token and their white ink: emerald at 24%, sky at 32% and rose at 41%
 * lightness still read green, blue and red. They survived because of their hue, not because the
 * original reasoning held.
 */
const TONE: Record<CardAccess, { fill: string; ink: string }> = {
  // ⚠️ NOT `--color-warning`, and not white ink. See above before "fixing" this back.
  [AppAccess.PENDING]: { fill: '#f59e0b', ink: '#0f172a' }, // amber-500 + slate-900
  [AppAccess.ALLOWED]: { fill: '#047857', ink: '#ffffff' }, // emerald-700 — `--color-success`
  [AppAccess.REJECTED]: { fill: '#0369a1', ink: '#ffffff' }, // sky-700    — `--color-info`
  [AppAccess.BLOCKED]: { fill: '#be123c', ink: '#ffffff' }, // rose-700    — `--color-error`
};

/**
 * The eyebrow sits at 75% of the headline's ink.
 *
 * Written as an 8-digit hex rather than an opacity property because Flex has no such property on
 * a text node — `#0f172abf` is the alpha channel, and `bf` is 75% of 255. Both inks were measured
 * at this alpha over their own fill (5.17:1 on amber, and white on the three dark bands is never
 * in question), so the small line clears 4.5:1 on all four.
 */
const EYEBROW_ALPHA = 'bf';

/**
 * Body text and the reason box, from the prototype's own surface tokens.
 *
 * ⚠️ SLATE, NOT TAILWIND'S DEFAULT GREY, and the first version got that wrong too — `#1f2937` /
 * `#4b5563` / `#f3f4f6` are gray-800/600/100, a different family from every surface in this
 * product. The portal is slate throughout (`--color-base-content` `#0f172a`, `--color-base-200`
 * `#f1f5f9`, `--color-base-300` `#e2e8f0`), and grey beside slate reads as slightly dirty rather
 * than as a deliberate second neutral.
 */
const INK = '#0f172a'; // slate-900 — `--color-base-content`
const INK_SOFT = '#475569'; // slate-600 — the portal's secondary text weight
const SURFACE_SOFT = '#f1f5f9'; // slate-100 — `--color-base-200`, the sunken fill
const LINE_SOFT = '#e2e8f0'; // slate-200 — `--color-base-300`, the portal's divider

/**
 * The states worth a card.
 *
 * `UNREGISTERED` is absent for the same reason it maps to `null` in
 * `ACCESS_NOTIFICATION_MESSAGES`: nobody is told they have not done something yet.
 */
export type CardAccess =
  | typeof AppAccess.PENDING
  | typeof AppAccess.ALLOWED
  | typeof AppAccess.REJECTED
  | typeof AppAccess.BLOCKED;

/**
 * The headline is the SAME WORD the operator's badge shows, from `ACCESS_LABEL` in the portal's
 * `labels.ts` — spelled again here because the two repositories cannot import from each other.
 * If one is ever reworded, reword both: an approval email that calls the state something the
 * back-office does not is how two teams end up describing one row in two vocabularies.
 */
const HEADLINE: Record<CardAccess, string> = {
  [AppAccess.PENDING]: 'รออนุมัติ',
  [AppAccess.ALLOWED]: 'อนุมัติแล้ว',
  [AppAccess.REJECTED]: 'ส่งคืนให้แก้ไข',
  [AppAccess.BLOCKED]: 'ถูกระงับการใช้งาน',
};

/** The paragraph under the headline. The `altText` keeps the original one-line phrasing. */
const BODY: Record<CardAccess, string> = {
  [AppAccess.PENDING]:
    'ระบบได้รับข้อมูลการลงทะเบียนของคุณแล้ว เจ้าหน้าที่กำลังตรวจสอบข้อมูล กรุณารอสักครู่',
  [AppAccess.ALLOWED]:
    'บัญชีของคุณใช้งานระบบจองสถานที่ได้แล้ว กดเมนูด้านล่างของหน้าแชทเพื่อเริ่มใช้งานได้ทันที',
  [AppAccess.REJECTED]:
    'ข้อมูลการลงทะเบียนของคุณยังไม่ผ่านการตรวจสอบ กรุณาแก้ไขตามเหตุผลด้านล่าง แล้วส่งกลับมาให้พิจารณาอีกครั้ง',
  [AppAccess.BLOCKED]:
    'บัญชีของคุณถูกระงับสิทธิ์การใช้งานชั่วคราว หากมีข้อสงสัยกรุณาติดต่อเจ้าหน้าที่',
};

/**
 * The footer button, where one has anything to do.
 *
 * ⚠️ ABSENT FOR PENDING AND BLOCKED ON PURPOSE. Both are states in which the user's only correct
 * action is to wait, and a button that opens an app which will show them the same waiting screen
 * teaches them the button is decoration. A card whose footer appears only when there is something
 * to press is a card whose footer means something.
 */
const CTA: Partial<Record<CardAccess, string>> = {
  [AppAccess.ALLOWED]: 'เปิดแอปพลิเคชัน',
  [AppAccess.REJECTED]: 'แก้ไขข้อมูล',
};

const text = (
  content: string,
  extra: Partial<messagingApi.FlexText> = {},
): messagingApi.FlexText => ({
  type: 'text',
  text: content,
  wrap: true,
  ...extra,
});

/**
 * Build the bubble for a status change.
 *
 * @param access which of the four states the user has landed in
 * @param altText the notification-banner line — the original plain-text copy
 * @param reason the operator's rejection reason, REJECTED only; shown in its own box
 * @param liffUrl `LINE_LIFF_URL`, or `null`/`undefined` to omit the footer entirely
 */
export function buildAccessCard(
  access: CardAccess,
  altText: string,
  { reason, liffUrl }: { reason?: string; liffUrl?: string | null } = {},
): messagingApi.FlexMessage {
  const { fill, ink } = TONE[access];
  const cta = CTA[access];

  const body: messagingApi.FlexComponent[] = [
    text(BODY[access], { size: 'sm', color: INK, lineSpacing: '6px' }),
  ];

  /*
   * ⚠️ THE REASON IS THE POINT OF THE REJECT CARD, and as a plain sentence it used to be buried
   * mid-paragraph after "เนื่องจาก:". In its own tinted box it is the thing the eye lands on,
   * which is what a user opening this message is looking for.
   *
   * It is operator-typed free text: rendered as a `text` node, never interpolated into anything
   * that parses. Flex has no markup, so there is nothing to escape — but it is also capped at 500
   * by the DTO, which is what keeps the bubble from being rejected for exceeding LINE's size limit.
   */
  if (access === AppAccess.REJECTED && reason) {
    body.push({
      type: 'box',
      layout: 'vertical',
      backgroundColor: SURFACE_SOFT,
      // ⚠️ A BORDER, because the fill alone is a 1.07:1 step off white — visible on the phone the
      // PO photographed, but only just, and it read as a smudge rather than as a block. The
      // portal draws the same distinction the same way: `cm-diff` is `border border-base-300`.
      borderColor: LINE_SOFT,
      borderWidth: '1px',
      cornerRadius: '8px',
      paddingAll: '12px',
      margin: 'lg',
      spacing: 'sm',
      contents: [
        text('เหตุผล', { size: 'xs', color: INK_SOFT, weight: 'bold' }),
        text(reason, { size: 'sm', color: INK, lineSpacing: '6px' }),
      ],
    });
  }

  const bubble: messagingApi.FlexBubble = {
    type: 'bubble',
    // The coloured band. `header` rather than a `hero` image: there is no artwork per status, and
    // a band of the status's own colour says the same thing in bytes instead of kilobytes.
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: fill,
      paddingAll: '16px',
      spacing: 'xs',
      contents: [
        text('สถานะการลงทะเบียน', { size: 'xs', color: ink + EYEBROW_ALPHA }),
        text(HEADLINE[access], {
          size: 'xl',
          weight: 'bold',
          color: ink,
        }),
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      contents: body,
    },
  };

  if (cta && liffUrl) {
    bubble.footer = {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      paddingTop: 'none',
      contents: [
        {
          type: 'button',
          style: 'primary',
          height: 'sm',
          // Safe as the fill even though PENDING's is now light: `CTA` only covers ALLOWED and
          // REJECTED, and both are dark bands whose white label LINE supplies itself. If a button
          // is ever added to PENDING this needs its own contrast decision, not this line.
          color: fill,
          action: { type: 'uri', label: cta, uri: liffUrl },
        },
      ],
    };
  }

  return { type: 'flex', altText, contents: bubble };
}
