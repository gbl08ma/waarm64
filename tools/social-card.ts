// The pictures web/app/index.html's head names for where a link to the page is shared: `social-card.png` (1200x630,
// og:image), `apple-touch-icon.png` (180x180, the icon for what takes no SVG) and the installed app's icons
// (web/app/public/manifest.webmanifest: `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`), rendered from
// tools/social-card/card.html by headless Chromium into web/app/public/, where they are committed (the build copies
// them as they are). Run it after changing the card: `node tools/social-card.ts`.
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const CARD = new URL('./social-card/card.html', import.meta.url);
const OUT = new URL('../web/app/public/', import.meta.url);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
try {
  for (const [query, file, width, height] of [['', 'social-card.png', 1200, 630], ['?icon', 'apple-touch-icon.png', 180, 180], ['?icon', 'icon-192.png', 192, 192], ['?icon', 'icon-512.png', 512, 512], ['?icon&maskable', 'icon-maskable-512.png', 512, 512]] as const) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.goto(CARD.href + query);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: fileURLToPath(new URL(file, OUT)) });
    await page.close();
  }
} finally {
  await browser.close();
}
