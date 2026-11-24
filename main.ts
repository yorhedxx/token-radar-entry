// Launch Radar's entry program (Node 22, standard library only).
//
// Reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>),
// runs the model in lib/model.ts — classify all 758 protocols, fit the launch
// value and launch odds on the snapshot's own record, validate leave-one-out,
// rank the board — then writes /output/board.json and /output/data.js, copies
// this repository's dashboard/ and screenshots/ beside them, and writes
// /output/dossier.json last with the vendored make.fun library, byte for byte
// as the scorer will rebuild it.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../kit/token-radar-01-kit/input/snapshot.json
//
// The run is deterministic: two runs on the same snapshot write identical bytes.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildEntry, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The caps the scorer holds the dossier to; the text cap shapes the bytes, the rest refuse. */
const DOSSIER_CAPS = {
  text_max_bytes: 65_536,
  screenshots: { max: 4, max_bytes: 524_288 },
  dashboard: { max_files: 400, max_bytes: 4_194_304 },
};
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The value of `--name <value>` or `--name=<value>` among the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const at = args.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < args.length) return args[at + 1]!;
  const withEquals = args.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

function fail(message: string): never {
  process.stderr.write(`launch radar: ${message}\n`);
  process.exit(1);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`launch radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const entry = buildEntry(snapshot);
const issue = boardIssue(entry.board, snapshot);
if (issue !== null) fail(`the model wrote a board the gate refuses: ${issue}`);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: entry.board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(entry.data));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dashboardFiles = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) fail(`screenshots/ holds ${shots.length} images: hand in 3, the board, a detail view and a filtered view`);
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);
}

// The dossier goes last: the scorer rebuilds it from this output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, DOSSIER_CAPS));

const v = entry.validation;
const ledgerLine = entry.data.ledger.map((l) => `${l.group}=${l.count}`).join(' ');
process.stdout.write(
  `launch radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${entry.board.length} rows ranked\n` +
    `launch radar: ledger ${ledgerLine}\n` +
    `launch radar: value fit on ${entry.valueFit.n} priced protocols: log-log intercept ${entry.valueFit.intercept.toFixed(4)}, slope ${entry.valueFit.slope.toFixed(4)}\n` +
    `launch radar: leave-one-out miss (x-median): fitted ${v.fittedLoo.missMultiple} (spearman ${v.fittedLoo.spearman}), fitted+chains ${v.chainsLoo.missMultiple} (spearman ${v.chainsLoo.spearman}), starter radar-1 ${v.starterLoo.missMultiple} (spearman ${v.starterLoo.spearman}), flat 0.25xTVL ${v.flatLoo.missMultiple} (spearman ${v.flatLoo.spearman})\n` +
    `launch radar: walk-forward (fit listed <= ${v.walkForward.cutoff}, n=${v.walkForward.trainN}; price later-listed, n=${v.walkForward.testN}): fitted ${v.walkForward.fitted.missMultiple} (spearman ${v.walkForward.fitted.spearman}), fitted+chains ${v.walkForward.chains.missMultiple} (spearman ${v.walkForward.chains.spearman}), starter ${v.walkForward.starter.missMultiple}, flat ${v.walkForward.flat.missMultiple}\n` +
    `launch radar: chain-count term ${v.chainsAdmitted ? 'ADMITTED (wins both tests): shipping radar-3' : 'not admitted (must win both tests): shipping radar-2, ablation printed'}; shipped fit uses chains=${entry.valueFit.useChains}, chain coef ${entry.valueFit.chainCoef.toFixed(4)}\n` +
    `launch radar: odds Brier: in-sample ${v.oddsBrierInSample}, ten-fold ${v.oddsBrierTenFold}, base rate ${v.oddsBrierBaseRate}; P25-P75 band coverage (LOO) ${v.bandCoverageLoo}\n` +
    `launch radar: wrote board.json, data.js, dashboard (${dashboardFiles.length} files), screenshots (${shots.length} images) and dossier.json under ${out}\n`,
);
