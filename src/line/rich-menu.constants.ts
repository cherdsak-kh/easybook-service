import type { RichMenuType } from '@prisma/client';

export interface RichMenuSpec {
  name: string;
  width: number;
  height: number;
}

/**
 * Identifies the live rich menu for each RichMenuType by name + size (as created
 * by `scripts/setup-rich-menu.ts`).
 *
 * NOTE: both menus are now 2500x1686. TYPE_1 used to be the half-height 2500x843
 * format, and while it was, size genuinely disambiguated the two. It no longer
 * does — the NAME is the only discriminator today, so `findRichMenuId` degrades to
 * a name match and duplicate names on the LINE account would make resolution
 * non-deterministic. The setup script deletes menus by name before recreating
 * them, which is what keeps duplicates from existing in the first place. Keep
 * these dimensions in sync with the actual files in `assets/richmenu/` — LINE
 * rejects an upload whose image size differs from the size declared at create
 * time.
 */
export const RICH_MENU_SPECS: Record<RichMenuType, RichMenuSpec> = {
  TYPE_1: { name: 'easy-book-liff', width: 2500, height: 1686 },
  TYPE_2: { name: 'easy-book-main', width: 2500, height: 1686 },
};

/** LINE's documented maximum number of user ids per bulk rich-menu link call. */
export const RICH_MENU_LINK_BATCH_SIZE = 500;

/**
 * The three TYPE_2 shortcut buttons whose destination pages do not exist yet.
 *
 * `data` is a wire contract between two files that must not drift:
 * `scripts/setup-rich-menu.ts` writes it into the rich menu's postback action,
 * and `LineWebhookService` reads it back off the incoming event. A typo in either
 * one is silent — the button would just stop replying — so both import from here
 * rather than repeating the literal.
 *
 * `pendingMessage` is what a tap answers with until the real page ships. When one
 * does, replace that button's `postback` action with a `uri` action pointing at
 * the LIFF route and drop its entry here; nothing else needs to change.
 */
export interface RichMenuShortcut {
  /** postback `data` payload; also the lookup key on the receiving end. */
  data: string;
  /** LINE action label (max 20 chars) — accessibility/fallback, not drawn on screen. */
  label: string;
  /** Reply sent while the destination page is still unbuilt. */
  pendingMessage: string;
}

export const RICH_MENU_SHORTCUTS = {
  myBookings: {
    data: 'action=my-bookings',
    label: 'My Bookings',
    pendingMessage:
      'ฟีเจอร์ "การจองของฉัน" กำลังพัฒนาอยู่ เร็ว ๆ นี้จะเปิดให้ใช้งาน 🙏',
  },
  reportIssue: {
    data: 'action=report-issue',
    label: 'Report Issue',
    pendingMessage:
      'ฟีเจอร์ "แจ้งปัญหา" กำลังพัฒนาอยู่ เร็ว ๆ นี้จะเปิดให้ใช้งาน 🙏',
  },
  settings: {
    data: 'action=settings',
    label: 'Settings',
    pendingMessage:
      'ฟีเจอร์ "ตั้งค่า" กำลังพัฒนาอยู่ เร็ว ๆ นี้จะเปิดให้ใช้งาน 🙏',
  },
} as const satisfies Record<string, RichMenuShortcut>;

/** postback `data` -> reply text, for the webhook's O(1) lookup. */
export const PENDING_MESSAGE_BY_POSTBACK_DATA: ReadonlyMap<string, string> =
  new Map(
    Object.values(RICH_MENU_SHORTCUTS).map((shortcut) => [
      shortcut.data,
      shortcut.pendingMessage,
    ]),
  );
