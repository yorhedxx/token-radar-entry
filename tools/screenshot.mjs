// Capture the dashboard's three screenshots from a main.ts output directory
// with a headless Chromium (Puppeteer) at 1440x900: the board, the top row's
// detail view, and a filtered board (verdict FARM). Raw PNGs land in the
// staging directory named by argv[3]; compression to the shipped files is a
// separate step so sizes can be tuned. Usage:
//   node tools/screenshot.mjs <output-dir> <board.json> <staging-dir>
// Puppeteer is a local tooling dependency only (never part of the entry): it
// is resolved from ~/.cache/shot-tools, installed there for this build machine.

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [outDir, boardFile, staging] = process.argv.slice(2);
if (!outDir || !boardFile || !staging) {
  process.stderr.write('usage: node tools/screenshot.mjs <output-dir> <board.json> <staging-dir>\n');
  process.exit(2);
}
import { homedir } from 'node:os';
const require = createRequire(join(homedir(), '.cache', 'shot-tools', 'tooling.js'));
const puppeteer = require('puppeteer');

const board = JSON.parse(readFileSync(boardFile, 'utf8'));
const top = (Array.isArray(board) ? board : board.rows)[0];
mkdirSync(staging, { recursive: true });

const base = 'file://' + resolve(outDir) + '/dashboard/index.html';
const shots = [
  ['1-board.png', base + '#/'],
  ['2-detail.png', base + '#/p/' + top.slug],
  ['3-filtered.png', base + '#/?v=farm'],
];

const browser = await puppeteer.launch({ args: ['--no-sandbox', '--force-color-profile=srgb'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  for (const [name, url] of shots) {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('table tbody tr', { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 350));
    await page.screenshot({ path: join(staging, name) });
    process.stdout.write(`captured ${name} from ${url}\n`);
  }
} finally {
  await browser.close();
}
