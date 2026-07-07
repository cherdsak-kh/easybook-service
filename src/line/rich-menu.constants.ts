import type { RichMenuType } from '@prisma/client';

export interface RichMenuSpec {
  name: string;
  width: number;
  height: number;
}

/**
 * Identifies the live rich menu for each RichMenuType by name + size (as created
 * by `scripts/setup-rich-menu.ts`). Matching on size too keeps resolution
 * deterministic even if duplicate names exist on the LINE account.
 */
export const RICH_MENU_SPECS: Record<RichMenuType, RichMenuSpec> = {
  TYPE_1: { name: 'easy-book-liff', width: 2500, height: 843 },
  TYPE_2: { name: 'easy-book-main', width: 2500, height: 1686 },
};
