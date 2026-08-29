/**
 * Rich-menu setup — run: `npm run line:setup-richmenu`
 *
 * Creates the two rich menus that match the images in ./assets/richmenu, uploads
 * each image, and sets one as the default. Adjust the actions/default as needed.
 *
 * Requires in .env: LINE_CHANNEL_ACCESS_TOKEN.
 * Rich-menu images must be PNG/JPEG, 2500x1686 or 2500x843, <= 1MB.
 *
 * DEFAULT_RICH_MENU env: "type1" | "type2" (default "type1").
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { messagingApi } from '@line/bot-sdk';
import type { RichMenuType } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { LineService } from '../src/line/line.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  RICH_MENU_LINK_BATCH_SIZE,
  RICH_MENU_SHORTCUTS,
  RICH_MENU_SPECS,
} from '../src/line/rich-menu.constants';

const LIFF_URI = 'https://liff.line.me/2010582836-zgUc8zRb';
const ASSET_DIR = resolve(__dirname, '..', 'assets', 'richmenu');

// `name` and `size` are taken from RICH_MENU_SPECS rather than restated here.
// They were duplicated before, and the copies drifted the moment the TYPE_1
// artwork changed height: this script would have created a 2500x843 menu, the
// upload of a 2500x1686 image would have been rejected, and even had it
// succeeded LineService.findRichMenuId would never have matched the result. One
// source means swapping artwork is a single edit in rich-menu.constants.ts.
const TYPE_1 = RICH_MENU_SPECS.TYPE_1;
const TYPE_2 = RICH_MENU_SPECS.TYPE_2;

interface MenuDef {
  key: 'type1' | 'type2';
  /** The DB-side `LineUser.richMenuType` this menu serves — the join key for re-linking. */
  richMenuType: RichMenuType;
  image: string;
  menu: messagingApi.RichMenuRequest;
}

// menu_type_1.jpg — 2500x843 ("EasyBook Application"), one full-bleed area that
// opens the LIFF app. The artwork is a single edge-to-edge panel with no card
// gutters, so the one area below deliberately covers the whole canvas.
//
// This height has changed twice (2500x843 → 2500x1686 on 2026-07-31, back to
// 2500x843 with the current artwork). The area takes its size from TYPE_1 rather
// than hardcoding numbers precisely so the next swap cannot leave it overflowing:
// LINE rejects an image whose dimensions differ from the declared size, and it
// rejects an area that extends past the canvas.
const menuType1: MenuDef = {
  key: 'type1',
  richMenuType: 'TYPE_1',
  image: resolve(ASSET_DIR, 'menu_type_1.jpg'),
  menu: {
    size: { width: TYPE_1.width, height: TYPE_1.height },
    selected: true,
    name: TYPE_1.name,
    /*
     * ⚠️ THE SAME WORDS AS TYPE_2, and that is the point (PO, 22 ส.ค. 2569). `chatBarText` is the
     * label on the bar that opens the rich menu — the one piece of this UI that is always on
     * screen. It used to read `EasyBook App` here and `เริ่มต้นใช้งาน` on TYPE_2, so the bar
     * silently renamed itself the moment an operator approved somebody: a control the user had
     * learned changed its name, in a different language, to mark a change that had nothing to do
     * with it. The menu BEHIND it is what differs between the two types; the handle is not.
     *
     * ⚠️ CHANGING THIS STRING DOES NOTHING UNTIL `npm run line:setup-richmenu` IS RE-RUN. Rich
     * menus live on LINE's side, not in this repo — the script recreates them by name.
     */
    chatBarText: 'เมนู',
    areas: [
      {
        bounds: { x: 0, y: 0, width: TYPE_1.width, height: TYPE_1.height },
        action: { type: 'uri', label: 'EasyBook Application', uri: LIFF_URI },
      },
    ],
  },
};

// menu_type_2.jpg — 2500x1686: one wide "เข้าสู่หน้าหลัก" card on top, three cards
// below (การจองของฉัน / แจ้งปัญหา / ตั้งค่า).
//
// The bounds below are MEASURED from the artwork, not assumed (re-verified
// 2026-08-29 by decoding the JPEG and locating the card edges against the light
// background). The cards sit on a ~41px margin with gutters between them:
//
//   top card      x 41..2458   y 40..904
//   gutter                     y 905..955
//   bottom row                 y 956..1628
//   bottom cards  x 41..837 | 885..1639 | 1687..2458  (gutters x 838..884, 1640..1686)
//
// Each area hugs its own card to within ~5px, so no area clips a neighbouring card
// and none extends past the canvas. UNLIKE THE PREVIOUS LAYOUT, these areas do not
// tile the full 2500x1686 — the margins and gutters (~13% of the canvas) are
// deliberately dead. That is the trade: a tap on the visible gap between two cards
// does nothing rather than firing whichever neighbour happened to own the gutter.
//
// Re-measure this block whenever the artwork is replaced; the numbers are specific
// to this image, not to the 2500x1686 format.
//
// Only the top card has a destination today. The other three are shortcuts to
// pages that do not exist yet, so they postback and the webhook answers with
// RICH_MENU_SHORTCUTS[...].pendingMessage. Swap a button to a `uri` action once
// its page ships — see rich-menu.constants.ts.
const menuType2: MenuDef = {
  key: 'type2',
  richMenuType: 'TYPE_2',
  image: resolve(ASSET_DIR, 'menu_type_2.jpg'),
  menu: {
    size: { width: TYPE_2.width, height: TYPE_2.height },
    selected: true,
    name: TYPE_2.name,
    chatBarText: 'เมนู',
    areas: [
      {
        // Top card "เข้าสู่หน้าหลัก" → opens the LIFF app.
        bounds: { x: 41, y: 41, width: 2418, height: 866 },
        action: { type: 'uri', label: 'เข้าสู่หน้าหลัก', uri: LIFF_URI },
      },
      {
        // Bottom-left "การจองของฉัน" (blue).
        bounds: { x: 41, y: 951, width: 797, height: 680 },
        action: {
          type: 'postback',
          label: RICH_MENU_SHORTCUTS.myBookings.label,
          data: RICH_MENU_SHORTCUTS.myBookings.data,
        },
      },
      {
        // Bottom-middle "แจ้งปัญหา" (orange).
        bounds: { x: 887, y: 953, width: 756, height: 675 },
        action: {
          type: 'postback',
          label: RICH_MENU_SHORTCUTS.reportIssue.label,
          data: RICH_MENU_SHORTCUTS.reportIssue.data,
        },
      },
      {
        // Bottom-right "ตั้งค่า" (green).
        bounds: { x: 1686, y: 955, width: 774, height: 676 },
        action: {
          type: 'postback',
          label: RICH_MENU_SHORTCUTS.settings.label,
          data: RICH_MENU_SHORTCUTS.settings.data,
        },
      },
    ],
  },
};

const MENUS: MenuDef[] = [menuType1, menuType2];

interface ActiveUser {
  lineUserId: string;
  richMenuType: RichMenuType;
}

/**
 * Read every active user's stored `richMenuType`.
 *
 * Called BEFORE anything on LINE is touched, on purpose. This read is the only
 * part of the run that depends on the database, and it is read-only — doing it
 * first means an unreachable DB aborts with zero side effects. The first version
 * of this script read it in the middle, after the new menus had been created and
 * the account default repointed, so a DB outage left LINE half-migrated (observed
 * on 2026-07-31: `.env` pointed at a local Postgres that was not running, and the
 * run died with ECONNREFUSED holding two fresh menus and a changed default).
 */
async function loadActiveUsers(prisma: PrismaService): Promise<ActiveUser[]> {
  return prisma.lineUser.findMany({
    where: { deletedAt: null },
    select: { lineUserId: true, richMenuType: true },
  });
}

/**
 * Re-link every active LineUser to the freshly created menu for their stored
 * `richMenuType`.
 *
 * This step is NOT optional. Deleting a rich menu on LINE destroys every per-user
 * link pointing at it, and nothing else in the app ever re-links: the only caller
 * of `LineUserService.applyRichMenu` is `updateAccess` (approve/block/reinstate),
 * and `upsertOnFollow` deliberately does not link. So before this pass existed, a
 * menu refresh silently dropped every ALLOWED user onto the account default —
 * which this script sets to type1, the restricted "EasyBook Application" menu —
 * while the DB still read `richMenuType: TYPE_2`. Nothing detected the drift, and
 * the only recovery was an admin re-approving each user by hand.
 *
 * Returns the number of users it failed to re-link, so the caller can decide
 * whether it is safe to delete the old menus.
 */
async function relinkUsers(
  line: LineService,
  users: ActiveUser[],
  idByType: Map<RichMenuType, string>,
): Promise<number> {
  if (users.length === 0) {
    console.log('No active users to re-link.');
    return 0;
  }

  let failed = 0;
  for (const [richMenuType, richMenuId] of idByType) {
    const userIds = users
      .filter((user) => user.richMenuType === richMenuType)
      .map((user) => user.lineUserId);
    if (userIds.length === 0) continue;

    for (let i = 0; i < userIds.length; i += RICH_MENU_LINK_BATCH_SIZE) {
      const batch = userIds.slice(i, i + RICH_MENU_LINK_BATCH_SIZE);
      try {
        await line.linkRichMenuToUsers(richMenuId, batch);
        console.log(`  re-linked ${batch.length} user(s) to ${richMenuType}`);
      } catch (error) {
        failed += batch.length;
        console.error(
          `  FAILED to re-link ${batch.length} user(s) to ${richMenuType}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
  return failed;
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const line = app.get(LineService);
    const prisma = app.get(PrismaService);
    const defaultKey = process.env.DEFAULT_RICH_MENU ?? 'type1';

    // Order matters: read-DB, then create-relink-delete — NOT delete-then-create,
    // and never a LINE mutation before the DB read. The original order left a
    // window with no menus on the account at all and destroyed every user link
    // before there was anything to re-link them to; reading the DB last also meant
    // a DB outage could strand LINE half-migrated.
    //
    // Step 0 is therefore the read-only DB query. Nothing on LINE has been touched
    // yet, so a failure here costs nothing.
    const users = await loadActiveUsers(prisma);
    const countByType = new Map<RichMenuType, number>();
    for (const user of users) {
      countByType.set(
        user.richMenuType,
        (countByType.get(user.richMenuType) ?? 0) + 1,
      );
    }
    console.log(
      `== ${users.length} active user(s) to re-link: ` +
        `${[...countByType].map(([type, n]) => `${type}=${n}`).join(', ') || 'none'} ==`,
    );
    console.log('   (sanity-check these counts before the menus are replaced)');

    // The stale menus are captured BY ID here, before the replacements exist,
    // because from the create step onward two menus share each managed name and a
    // delete-by-name pass could not tell them apart.
    const managedNames = new Set(MENUS.map(({ menu }) => menu.name));
    const stale = (await line.listRichMenus()).filter((menu) =>
      managedNames.has(menu.name),
    );
    console.log(`== Found ${stale.length} existing menu(s) to replace ==`);

    // 1. Create the replacements and upload their images.
    const idByType = new Map<RichMenuType, string>();
    for (const { key, richMenuType, image, menu } of MENUS) {
      const richMenuId = await line.createRichMenu(menu);
      await line.setRichMenuImage(
        richMenuId,
        readFileSync(image),
        'image/jpeg',
      );
      idByType.set(richMenuType, richMenuId);
      console.log(`Created rich menu '${key}' (${richMenuType}):`, richMenuId);
      console.log(`  uploaded ${image}`);
    }

    // 2. Point the account default at the new menu before anyone can land on the
    //    old one.
    const defaultMenu = MENUS.find(({ key }) => key === defaultKey);
    const defaultId = defaultMenu && idByType.get(defaultMenu.richMenuType);
    if (defaultId) {
      await line.setDefaultRichMenu(defaultId);
      console.log(`Set DEFAULT rich menu to '${defaultKey}' ✓`);
    } else {
      console.warn(
        `DEFAULT_RICH_MENU='${defaultKey}' matches no menu — no default was set.`,
      );
    }

    // 3. Restore every existing user's own menu.
    console.log('== Re-linking existing users ==');
    const failed = await relinkUsers(line, users, idByType);

    // 4. Only now retire the old menus — and only if every user made it across.
    //    A user we failed to re-link is still pointing at their OLD menu, so
    //    deleting it would drop them to the default. Leaving the old menus in
    //    place keeps them working; re-running this script converges (the next run
    //    treats both generations as stale and replaces them).
    if (failed > 0) {
      console.error(
        `\n${failed} user(s) could not be re-linked. NOT deleting the old menus — ` +
          `they are what those users are still using. Fix the cause and re-run ` +
          `this script; a re-run replaces every generation it finds.\n` +
          `Note: until then two menus share each name, so LineService.findRichMenuId ` +
          `may resolve either generation.`,
      );
      process.exitCode = 1;
      return;
    }

    for (const menu of stale) {
      await line.deleteRichMenu(menu.richMenuId);
      console.log(`Deleted old rich menu '${menu.name}':`, menu.richMenuId);
    }
    console.log('\nRich-menu setup complete ✓');
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('Rich-menu setup failed:', error);
  process.exit(1);
});
