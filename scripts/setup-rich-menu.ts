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
import { AppModule } from '../src/app.module';
import { LineService } from '../src/line/line.service';

const LIFF_URI = 'https://liff.line.me/2010582836-zgUc8zRb';
const ASSET_DIR = resolve(__dirname, '..', 'assets', 'richmenu');

interface MenuDef {
  key: 'type1' | 'type2';
  image: string;
  menu: messagingApi.RichMenuRequest;
}

// menu_type_1.jpg — 2500x843, a single full-width area that opens the LIFF app.
const menuType1: MenuDef = {
  key: 'type1',
  image: resolve(ASSET_DIR, 'menu_type_1.jpg'),
  menu: {
    size: { width: 2500, height: 843 },
    selected: true,
    name: 'easy-book-liff',
    chatBarText: 'Welcome to EasyBook',
    areas: [
      {
        bounds: { x: 0, y: 0, width: 2500, height: 843 },
        action: { type: 'uri', label: 'Open app', uri: LIFF_URI },
      },
    ],
  },
};

// menu_type_2.jpg — 2500x1686: top full-width banner + 3 columns on the bottom.
const menuType2: MenuDef = {
  key: 'type2',
  image: resolve(ASSET_DIR, 'menu_type_2.jpg'),
  menu: {
    size: { width: 2500, height: 1686 },
    selected: false,
    name: 'easy-book-main',
    chatBarText: 'เริ่มต้นใช้งาน',
    areas: [
      {
        // Top banner → opens the LIFF app.
        bounds: { x: 0, y: 0, width: 2500, height: 843 },
        action: { type: 'uri', label: 'Open app', uri: LIFF_URI },
      },
      {
        // Bottom-left (green) → postback handled by the webhook.
        bounds: { x: 0, y: 843, width: 833, height: 843 },
        action: { type: 'postback', label: 'Browse', data: 'action=browse' },
      },
      {
        // Bottom-middle (pink).
        bounds: { x: 833, y: 843, width: 834, height: 843 },
        action: {
          type: 'postback',
          label: 'My bookings',
          data: 'action=my-bookings',
        },
      },
      {
        // Bottom-right (orange).
        bounds: { x: 1667, y: 843, width: 833, height: 843 },
        action: { type: 'postback', label: 'Help', data: 'action=help' },
      },
    ],
  },
};

const MENUS: MenuDef[] = [menuType1, menuType2];

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const line = app.get(LineService);
    const defaultKey = process.env.DEFAULT_RICH_MENU ?? 'type1';

    // Delete any pre-existing menus this script owns (matched by name), so a
    // rerun replaces them instead of accumulating duplicates.
    const managedNames = new Set(MENUS.map(({ menu }) => menu.name));
    const existing = await line.listRichMenus();
    for (const menu of existing) {
      if (managedNames.has(menu.name)) {
        await line.deleteRichMenu(menu.richMenuId);
        console.log(
          `Deleted existing rich menu '${menu.name}':`,
          menu.richMenuId,
        );
      }
    }

    for (const { key, image, menu } of MENUS) {
      const richMenuId = await line.createRichMenu(menu);
      console.log(`Created rich menu '${key}':`, richMenuId);

      await line.setRichMenuImage(richMenuId, readFileSync(image), 'image/jpeg');
      console.log(`  uploaded ${image}`);

      if (key === defaultKey) {
        await line.setDefaultRichMenu(richMenuId);
        console.log(`  set as DEFAULT rich menu ✓`);
      }
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('Rich-menu setup failed:', error);
  process.exit(1);
});
