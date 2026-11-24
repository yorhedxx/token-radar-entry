// A local replica of the scorer's seven gate rows, run against an output
// directory this entry's main.ts wrote (the real scorer stays on the server;
// this checks the same shapes the RULES name, so a red row here is a red row
// there). Usage: node tools/verify-gate.mjs <output-dir> <snapshot.json>

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildDossier } from '../vendor/makefun-board.ts';

const [outDir, snapshotFile] = process.argv.slice(2);
if (!outDir || !snapshotFile) {
  process.stderr.write('usage: node tools/verify-gate.mjs <output-dir> <snapshot.json>\n');
  process.exit(2);
}
const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'));
const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const rows = [];
const report = (name, pass, detail) => rows.push({ name, pass, detail });

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) out.push(...walk(path, base));
    else out.push({ path, rel: path.slice(base.length + 1), size: st.size });
  }
  return out;
}

// ---- dashboard_files -------------------------------------------------------
{
  const dir = join(outDir, 'dashboard');
  const problems = [];
  let files = [];
  if (!existsSync(dir)) problems.push('no dashboard/ directory');
  else {
    files = walk(dir);
    if (!files.some((f) => f.rel === 'index.html')) problems.push('no index.html');
    if (!files.some((f) => f.rel.endsWith('.css'))) problems.push('no .css file');
    if (!files.some((f) => f.rel.endsWith('.js'))) problems.push('no .js file');
    if (files.length > 400) problems.push(`${files.length} files, over 400`);
    const total = files.reduce((a, f) => a + f.size, 0);
    if (total > 4_194_304) problems.push(`${total} bytes, over 4 MiB`);
    for (const f of files) {
      for (const part of f.rel.split('/')) {
        if (part.startsWith('.') || !PLAIN_NAME.test(part)) problems.push(`name ${f.rel} is not plain`);
      }
      const text = readFileSync(f.path, 'utf8');
      if (f.rel.endsWith('.html')) {
        for (const tag of text.match(/<[a-zA-Z][^>]*>/g) ?? []) {
          for (const attr of tag.match(/[a-zA-Z-]+="([^"]*)"/g) ?? []) {
            if (/https?:\/\//.test(attr)) problems.push(`${f.rel}: network address in attribute ${attr.slice(0, 60)}`);
          }
        }
        for (const style of text.match(/<style[^>]*>([\s\S]*?)<\/style>/g) ?? []) {
          if (/https?:\/\//.test(style)) problems.push(`${f.rel}: network address in a <style> body`);
        }
        for (const imp of text.match(/import\s*(?:[^'"]*from\s*)?['"]([^'"]+)['"]/g) ?? []) {
          if (/https?:\/\//.test(imp)) problems.push(`${f.rel}: network address in a script import`);
        }
      }
      if (f.rel.endsWith('.css') && /https?:\/\//.test(text)) problems.push(`${f.rel}: network address in a CSS file`);
      if (f.rel.endsWith('.js')) {
        for (const imp of text.match(/(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]/g) ?? []) {
          if (/https?:\/\//.test(imp)) problems.push(`${f.rel}: network address in a JS import specifier`);
        }
      }
    }
  }
  report('dashboard_files', problems.length === 0, problems.length ? problems.slice(0, 3).join('; ') : `${files.length} files, ${files.reduce((a, f) => a + f.size, 0)} bytes, no network addresses`);
}

// ---- board rows -------------------------------------------------------------
let board = null;
{
  const file = join(outDir, 'board.json');
  const problems = [];
  let bytes = 0;
  if (!existsSync(file)) problems.push('no board.json');
  else {
    bytes = statSync(file).size;
    if (bytes > 8_388_608) problems.push(`${bytes} bytes, over 8 MiB`);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      problems.push('board.json is not JSON');
    }
    if (parsed !== undefined) {
      board = Array.isArray(parsed) ? parsed : parsed.rows;
      if (!Array.isArray(board)) problems.push('board.json has no rows array');
    }
  }
  if (board) {
    if (board.length < 100 || board.length > 4000) problems.push(`${board.length} rows, outside 100..4000`);
    const slugs = new Set(snapshot.protocols.map((p) => p.slug));
    const seen = new Set();
    for (const r of board) {
      if (typeof r.slug !== 'string' || r.slug.length < 1 || r.slug.length > 128 || /\s/.test(r.slug)) problems.push(`bad slug ${r.slug}`);
      else if (!slugs.has(r.slug)) problems.push(`invented slug ${r.slug}`);
      if (seen.has(r.slug)) problems.push(`duplicate slug ${r.slug}`);
      seen.add(r.slug);
      if (typeof r.name !== 'string' || r.name.length === 0) problems.push(`${r.slug}: empty name`);
      if (!Number.isSafeInteger(r.rank) || r.rank <= 0) problems.push(`${r.slug}: bad rank`);
      if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) problems.push(`${r.slug}: bad implied value`);
      if (!Array.isArray(r.farm_steps)) problems.push(`${r.slug}: farm_steps not an array`);
      if (problems.length > 4) break;
    }
    if (board.length >= 2 && board.every((r) => r.implied_value_usd === board[0].implied_value_usd)) problems.push('all rows share one implied value');
  }
  report('board_file', problems.length === 0, problems.length ? problems.slice(0, 3).join('; ') : `${board?.length} rows, ${bytes} bytes`);
}
if (board) {
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  let problem = null;
  for (let i = 0; i < byRank.length && !problem; i++) {
    if (byRank[i].rank !== i + 1) problem = `rank ${i + 1} is ${byRank[i].rank}`;
    else if (i > 0 && byRank[i].implied_value_usd > byRank[i - 1].implied_value_usd) problem = `implied value rises at rank ${i + 1}`;
  }
  report('sorted_by_value', problem === null, problem ?? 'ranks exactly 1..N, implied value never rises');
  const seen = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !seen.has(s));
  report('coverage', missing.length === 0, missing.length ? `missing ${missing.length}: ${missing.slice(0, 5).join(', ')}` : `all ${snapshot.watchlist.length} watchlist slugs ranked`);
  let stepProblem = null;
  for (const r of board) {
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) { stepProblem = `${r.slug}: ${r.farm_steps?.length} steps`; break; }
    for (const s of r.farm_steps) {
      const len = typeof s === 'string' ? s.trim().length : 0;
      if (len < 20 || len > 600) { stepProblem = `${r.slug}: a step of ${len} trimmed chars`; break; }
    }
    if (stepProblem) break;
  }
  report('farm_steps', stepProblem === null, stepProblem ?? 'every row has 3..12 steps of 20..600 trimmed chars');
}

// ---- screenshots ------------------------------------------------------------
function imageSize(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { kind: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      if (marker === 0xc0 || marker === 0xc2) return { kind: 'jpeg', h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}
{
  const dir = join(outDir, 'screenshots');
  const problems = [];
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith('.')).sort() : [];
  if (names.length < 3 || names.length > 4) problems.push(`${names.length} images, outside 3..4`);
  const dims = [];
  for (const name of names) {
    const buf = readFileSync(join(dir, name));
    if (buf.length > 524_288) problems.push(`${name}: ${buf.length} bytes, over 512 KiB`);
    const size = imageSize(buf);
    if (!size) problems.push(`${name}: not a whole PNG or JPEG`);
    else {
      dims.push(`${name} ${size.w}x${size.h}`);
      if (Math.max(size.w, size.h) > 1440) problems.push(`${name}: long side ${Math.max(size.w, size.h)} over 1440`);
      if (Math.min(size.w, size.h) < 800) problems.push(`${name}: short side ${Math.min(size.w, size.h)} under 800`);
    }
  }
  report('screenshots', problems.length === 0, problems.length ? problems.slice(0, 3).join('; ') : dims.join(', '));
}

// ---- dossier_matches ----------------------------------------------------------
{
  const file = join(outDir, 'dossier.json');
  const problems = [];
  let size = 0;
  if (!existsSync(file)) problems.push('no dossier.json');
  else {
    const ours = readFileSync(file);
    size = ours.length;
    if (size > 1_572_864) problems.push(`${size} bytes, over 1.5 MiB`);
    try {
      const rebuilt = buildDossier(outDir, { text_max_bytes: 65_536 });
      if (!ours.equals(Buffer.from(rebuilt))) problems.push('dossier.json differs from a fresh buildDossier of the same output');
    } catch (e) {
      problems.push(`buildDossier refused: ${e.message}`);
    }
  }
  report('dossier_matches', problems.length === 0, problems.length ? problems.join('; ') : `byte-identical to a fresh build, ${size} bytes`);
}

let failed = 0;
for (const r of rows) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(18)} ${r.detail}`);
  if (!r.pass) failed++;
}
console.log(failed === 0 ? 'gate: all seven rows pass' : `gate: ${failed} row(s) fail`);
process.exit(failed === 0 ? 0 : 1);
