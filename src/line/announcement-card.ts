import type { messagingApi } from '@line/bot-sdk';
import {
  INK,
  INK_SOFT,
  LINE_SOFT,
  TONE,
  toAltText,
} from './notification-cards';

/**
 * `ANNOUNCE-API-2` — the two message shapes an announcement is sent as: plain text (`TEXT`) or a
 * Flex bubble (`FLEX`).
 *
 * Pure functions, no I/O and no date logic (the `notification-cards.ts` convention): the caller
 * formats `sentAtText`. The palette and the `altText` choke point are IMPORTED from
 * `notification-cards.ts`, so there is one palette and one set of `altText` rules.
 *
 * The design authority is the admin prototype's "การ์ดประกาศ" preview, with one deliberate departure
 * (D-K): the prototype's "ดูรายละเอียด" button is gone. No LINE-user destination exists for it to open,
 * and a dead button in chat is worse than none. The footer is text only.
 */

export const ANNOUNCEMENT_CARD_HEADER = 'ประกาศจาก EasyBook';
export const ANNOUNCEMENT_ALT_PREFIX = 'ประกาศ: ';

/** `TEXT` — exactly one message: `title`, a blank line, `body`. At most 100 + 2 + 1000 characters. */
export function buildAnnouncementText(
  title: string,
  body: string,
): messagingApi.TextMessage {
  return { type: 'text', text: `${title}\n\n${body}` };
}

/**
 * `FLEX` — one bubble: an emerald header band, the title, the body, and a text-only footer.
 *
 * - **No `action` anywhere** — on no box and no text (D-K).
 * - **No `maxLines`.** A chat bubble has no "read more"; clamping would silently cut the message.
 * - LINE rejects an empty `text` node. The title is non-empty (DTO) and the body is non-empty (the
 *   send-time 400), so both are assumed present.
 *
 * @param o.sentAtText the send time, already formatted (e.g. `"22 ก.ย. 2569 14:05 น."`).
 */
export function buildAnnouncementCard(o: {
  title: string;
  body: string;
  sentAtText: string;
}): messagingApi.FlexMessage {
  return {
    type: 'flex',
    // One line and ≤ 400 characters, via the shared choke point (D-F).
    altText: toAltText(ANNOUNCEMENT_ALT_PREFIX + o.title),
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: TONE.SUCCESS.fill,
        paddingAll: '12px',
        contents: [
          {
            type: 'text',
            text: ANNOUNCEMENT_CARD_HEADER,
            size: 'sm',
            weight: 'bold',
            color: TONE.SUCCESS.ink,
            wrap: true,
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: o.title,
            size: 'lg',
            weight: 'bold',
            color: INK,
            wrap: true,
          },
          {
            type: 'text',
            text: o.body,
            size: 'sm',
            color: INK,
            wrap: true,
            lineSpacing: '6px',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        paddingAll: '12px',
        contents: [
          {
            type: 'text',
            text: o.sentAtText,
            size: 'xs',
            color: INK_SOFT,
            flex: 1,
            wrap: true,
          },
          {
            type: 'text',
            text: 'EasyBook',
            size: 'xs',
            weight: 'bold',
            color: TONE.SUCCESS.fill,
            align: 'end',
            flex: 0,
          },
        ],
      },
      styles: { footer: { separator: true, separatorColor: LINE_SOFT } },
    },
  };
}
