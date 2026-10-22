// The page's icons (docs/frontend.md "Icons"): Tabler Icons' outline SVGs (MIT, THIRD_PARTY.md), the ones the page uses,
// copied into web/app/icons.ts as their inner markup (Icon.svelte draws them in a 24×24 stroke-`currentColor` <svg>).
// Regenerate after adding a name to ICONS, from the pinned version's package:
//   npm pack @tabler/icons@3.49.0 && tar -xzf tabler-icons-3.49.0.tgz && node tools/icons.ts package
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const VERSION = '3.49.0';
const ICONS = [
  'arrow-down', 'arrow-left', 'arrow-up', 'aspect-ratio', 'bolt', 'chevron-down', 'copy', 'cpu', 'database',
  'database-import', 'device-desktop', 'device-gamepad-2', 'download', 'file', 'file-export', 'file-import', 'file-plus', 'git-merge', 'history', 'history-toggle',
  'keyboard', 'layout-columns', 'maximize', 'microphone', 'network', 'pencil', 'player-pause', 'player-play', 'player-stop', 'plug', 'plug-connected', 'plus',
  'adjustments-horizontal', 'mouse', 'refresh', 'server-2', 'settings', 'square-dashed', 'terminal-2', 'trash', 'upload', 'usb', 'volume', 'volume-off', 'world-www', 'x', 'zzz',
];

const dir = process.argv[2];
if (!dir) throw new Error('usage: node tools/icons.ts <the extracted @tabler/icons package directory>');
const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string };
if (pkg.version !== VERSION) throw new Error(`the package is ${pkg.version}, not ${VERSION} (bump VERSION and THIRD_PARTY.md together)`);
const license = readFileSync(join(dir, 'LICENSE'), 'utf8').trim().split('\n').map((l) => `// ${l}`.trimEnd()).join('\n');
const lines = ICONS.map((name) => {
  const svg = readFileSync(join(dir, 'icons/outline', `${name}.svg`), 'utf8');
  const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(svg)![1]
    .replace(/<path stroke="none" d="M0 0h24v24H0z" fill="none"\s*\/>/, '') // the transparent bounding box
    .replace(/\s*\n\s*/g, '').trim();
  return `  '${name}': '${inner}',`;
});
writeFileSync(join(import.meta.dirname, '../web/app/icons.ts'), `// Tabler Icons ${VERSION} (https://tabler.io/icons, MIT: Copyright (c) 2020-2026 Paweł Kuna; THIRD_PARTY.md), outline,
// their inner markup. Written by tools/icons.ts: add a name there and run it, don't edit by hand.
//
${license}
export const ICONS = {
${lines.join('\n')}
} as const;
export type IconName = keyof typeof ICONS;
`);
