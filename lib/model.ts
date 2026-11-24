// Launch Radar's model (radar-2): one sealed DefiLlama snapshot in, one ranked
// board of pre-token protocols out, with every protocol in the snapshot accounted
// for exactly once and both halves of the valuation fitted on the snapshot's own
// record — nothing here is a list of names, and no protocol is special-cased.
//
// The pipeline, in order:
//
//   1. Classify. Each of the snapshot's protocols lands in exactly one group:
//      it already trades (priced, or token recorded with no market cap), it is
//      ranked (the house watchlist, house-style-clean early rows below the
//      floor, or the flagged lineage-unverified tier), or it is set aside by a
//      named house-style rule (derivative category, versioned name, a wrapped /
//      staked / staking word in the name, an exchange's name as a prefix).
//      The groups sum to the snapshot's protocol count, and the exclusions are
//      kept as a ledger so the dashboard can account for all of them.
//
//   2. Value. Implied value = launch value x launch odds.
//      Launch value is a size curve fitted on the protocols whose token already
//      trades with a usable market cap — 16 of the 144 protocols that record a
//      cap record 0 or -1, a placeholder rather than a price, so the fit and
//      its validation use the 128 with a positive cap: log(market cap)
//      regressed on log(TVL), plus a
//      per-category effect shrunk toward the curve (a category's mean residual
//      counted with K pseudo-observations at zero, so a category with one
//      comparable barely moves and one with none does not move at all). The
//      P25-P75 band comes from the fitted residuals' own quantiles.
//      Launch odds are a logistic fit over every protocol in the snapshot —
//      outcome "records a token" — on years listed, the protocol's category
//      token share (leave-self-out, shrunk toward the base rate), log TVL and
//      clamped 7-day growth, fitted by fixed-iteration gradient descent on
//      standardised features with a small L2 pull. Rows in the flagged tier
//      have their odds multiplied by a stated lineage discount, because the
//      snapshot cannot show whether they are products of a tokenised parent.
//
//   3. Validate. Leave-one-out on the priced protocols prices each of them
//      from a fit that never saw it; the same protocols are priced by the flat
//      0.25 x TVL rule and by the starter's radar-1 formula, so the board's
//      claim to follow from the record is a measured number, not a slogan.
//      The odds fit is scored by Brier score, in-sample, ten-fold, and against
//      the base rate.
//
// Everything is deterministic: fixed iteration counts, sorted iteration, no
// clock beyond the snapshot's own as_of date, no randomness.

// ---------------------------------------------------------------------------
// Snapshot shape and parsing
// ---------------------------------------------------------------------------

/** One protocol in the sealed snapshot: exactly the ten fields the file carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why a snapshot is not one this model can read. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** Whole days from the day a protocol was listed to the snapshot's as_of day; null when unlisted or unreadable. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** The snapshot out of a file's text, refused unless it carries the fields the model reads. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (!isRecord(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  if (typeof raw.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof raw.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof raw.floor_usd !== 'number' || !Number.isSafeInteger(raw.floor_usd) || raw.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(raw.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(raw.watchlist) || raw.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols: SnapshotProtocol[] = raw.protocols.map((v, i) => {
    if (!isRecord(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    if (typeof v.slug !== 'string' || typeof v.name !== 'string' || typeof v.tvl_usd !== 'number' || !Number.isFinite(v.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: v.slug,
      name: v.name,
      category: strOrNull(v.category),
      chains: Array.isArray(v.chains) ? v.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: v.tvl_usd,
      change_7d: numOrNull(v.change_7d),
      mcap_usd: numOrNull(v.mcap_usd),
      listed_at: strOrNull(v.listed_at),
      gecko_id: strOrNull(v.gecko_id),
      symbol: strOrNull(v.symbol),
    };
  });
  return {
    as_of: raw.as_of,
    source: raw.source,
    floor_usd: raw.floor_usd,
    protocols,
    watchlist: raw.watchlist as string[],
  };
}

// ---------------------------------------------------------------------------
// Small deterministic statistics helpers
// ---------------------------------------------------------------------------

/** The middle of a sorted copy of the values (mean of the two middles when even). */
export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** A quantile of the values by linear interpolation between closest ranks. */
export function quantile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const at = (s.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return lo === hi ? s[lo]! : s[lo]! + (s[hi]! - s[lo]!) * (at - lo);
}

/** Spearman's rank correlation between two equal-length series, ties by average rank. */
export function spearman(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return 0;
  const ranks = (vs: number[]): number[] => {
    const order = vs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || a.i - b.i);
    const out = new Array<number>(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && order[j + 1]!.v === order[i]!.v) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) out[order[k]!.i] = avg;
      i = j + 1;
    }
    return out;
  };
  const rx = ranks(xs);
  const ry = ranks(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    cov += (rx[i]! - mx) * (ry[i]! - my);
    vx += (rx[i]! - mx) ** 2;
    vy += (ry[i]! - my) ** 2;
  }
  return vx === 0 || vy === 0 ? 0 : cov / Math.sqrt(vx * vy);
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

// ---------------------------------------------------------------------------
// Classification: every protocol in exactly one group
// ---------------------------------------------------------------------------

/** The accounting groups. The three `ranked_*` groups form the board. */
export type Group =
  | 'trades_priced'
  | 'trades_unpriced'
  | 'ranked_watchlist'
  | 'ranked_flagged'
  | 'ranked_early'
  | 'excluded_category'
  | 'excluded_versioned'
  | 'excluded_wrapped_name'
  | 'excluded_exchange';

/** One protocol's placement: its group and, for set-asides, the rule that named it. */
export interface Classified {
  protocol: SnapshotProtocol;
  group: Group;
  rule: string | null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories that are derivative products of another protocol's token by construction. */
const DERIVATIVE_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** A whole word in the name that marks a wrapped or staked product. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Names that begin with an exchange's name are that exchange's own products. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Whether the snapshot records no token at all for a protocol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether the snapshot records a token for a protocol, priced or not. */
export function recordsToken(p: SnapshotProtocol): boolean {
  return !isPreToken(p);
}

/**
 * The visible house-style rule that sets a pre-token protocol aside, or null
 * when no visible rule does. Precedence is fixed so each protocol names one
 * rule: derivative category, then versioned name, then a wrapped/staked word,
 * then an exchange prefix. The one house rule the snapshot cannot show — a
 * recorded parent protocol — is deliberately not guessed at here; protocols
 * at or above the floor that no visible rule explains and the house still
 * left off its watchlist are ranked in the flagged tier instead.
 */
export function visibleExclusion(p: SnapshotProtocol): { group: Group; rule: string } | null {
  if (p.category !== null && DERIVATIVE_CATEGORIES.has(p.category)) {
    return { group: 'excluded_category', rule: `category ${p.category}: a derivative or exchange product by construction` };
  }
  if (VERSIONED.test(p.name)) {
    return { group: 'excluded_versioned', rule: 'name ends in a version marker: a pool of another protocol' };
  }
  if (WRAPPED_WORD.test(p.name)) {
    return { group: 'excluded_wrapped_name', rule: 'name carries a wrapped/staked word: a product of a token that already trades' };
  }
  const exchange = EXCHANGE_PREFIXES.find((e) => p.name.startsWith(e));
  if (exchange !== undefined) {
    return { group: 'excluded_exchange', rule: `name begins with ${exchange}: an exchange's own product` };
  }
  return null;
}

/** Every protocol in the snapshot, placed in exactly one group, in snapshot order. */
export function classifyAll(snapshot: Snapshot): Classified[] {
  const watchlist = new Set(snapshot.watchlist);
  return snapshot.protocols.map((p) => {
    if (p.mcap_usd !== null) return { protocol: p, group: 'trades_priced' as Group, rule: null };
    if (recordsToken(p)) return { protocol: p, group: 'trades_unpriced' as Group, rule: null };
    if (watchlist.has(p.slug)) return { protocol: p, group: 'ranked_watchlist' as Group, rule: null };
    const exclusion = visibleExclusion(p);
    if (exclusion !== null) return { protocol: p, group: exclusion.group, rule: exclusion.rule };
    if (p.tvl_usd >= snapshot.floor_usd) {
      return {
        protocol: p,
        group: 'ranked_flagged' as Group,
        rule: 'no visible rule explains the house leaving it off the watchlist: lineage unverified, odds discounted',
      };
    }
    return { protocol: p, group: 'ranked_early' as Group, rule: null };
  });
}

/** One ledger line: a group, how many protocols it holds, and the rule or reason behind it. */
export interface LedgerLine {
  group: Group;
  count: number;
  rule: string;
}

/** The accounting ledger: every group with its count; the counts sum to the snapshot's protocol count. */
export function ledgerOf(classified: Classified[]): LedgerLine[] {
  const order: { group: Group; rule: string }[] = [
    { group: 'ranked_watchlist', rule: 'on the snapshot watchlist: pre-token at or above the floor, house-certified' },
    { group: 'ranked_early', rule: 'pre-token below the floor, passing every visible house-style filter' },
    { group: 'ranked_flagged', rule: 'pre-token at or above the floor, off the watchlist for a reason the snapshot cannot show (a recorded parent protocol): ranked with an odds discount and the flag printed' },
    { group: 'trades_priced', rule: "records a token with a market cap: already trades, and the value model's comparables" },
    { group: 'trades_unpriced', rule: 'records a token id or symbol but no market cap: a token exists, usually another deployment of a priced one' },
    { group: 'excluded_category', rule: 'category is Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC or CEX: a derivative or exchange product' },
    { group: 'excluded_versioned', rule: 'name ends in a version marker: a pool of another protocol' },
    { group: 'excluded_wrapped_name', rule: 'name carries a whole word wrapped, staked or staking' },
    { group: 'excluded_exchange', rule: "name begins with an exchange's name (Binance, Coinbase, Bybit, Kraken, Bitget, OKX, Bitfinex, Gemini)" },
  ];
  return order.map(({ group, rule }) => ({
    group,
    rule,
    count: classified.filter((c) => c.group === group).length,
  }));
}

// ---------------------------------------------------------------------------
// Launch value: a fitted size curve plus shrunk category effects
// ---------------------------------------------------------------------------

/** Prior strength of the category shrinkage, in pseudo-observations at a zero effect. */
export const CATEGORY_SHRINK_K = 8;

/** A fitted launch-value model: the size curve, per-category effects, and the residual band. */
export interface ValueFit {
  /** Intercept of log(market cap) on log(TVL). */
  intercept: number;
  /** Slope of log(market cap) on log(TVL). */
  slope: number;
  /** Coefficient on log(chain count) when the chain term is fitted, else 0. */
  chainCoef: number;
  /** Whether the chain-count term is part of this fit (it is admitted only by the two-test rule). */
  useChains: boolean;
  /** Category effects in log space, shrunk toward zero; a category absent here has effect 0. */
  categoryEffects: Map<string, number>;
  /** How many priced protocols each category effect was fitted from. */
  categoryCounts: Map<string, number>;
  /** Residual quantiles of the full fit on the priced set, for the P25-P75 band. */
  residQ25: number;
  residQ75: number;
  /** How many priced protocols the fit used. */
  n: number;
}

/** The map key a protocol's category is fitted under. */
export function categoryKey(p: SnapshotProtocol): string {
  return p.category ?? '(uncategorised)';
}

/** Ordinary least squares of y on x: returns [intercept, slope]. */
function ols(xs: number[], ys: number[]): [number, number] {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  return [my - slope * mx, slope];
}

/** Solve a small dense linear system by Gaussian elimination with partial pivoting; null when singular. */
function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    if (Math.abs(m[pivot]![col]!) < 1e-12) return null;
    if (pivot !== col) [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / m[col]![col]!;
      for (let c = col; c <= n; c++) m[r]![c] = m[r]![c]! - f * m[col]![c]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/** Multiple regression by the normal equations: coefficients of y on the feature rows (first column 1). */
function regress(features: number[][], ys: number[]): number[] | null {
  const k = features[0]!.length;
  const xtx = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty = new Array<number>(k).fill(0);
  for (let i = 0; i < features.length; i++) {
    for (let a = 0; a < k; a++) {
      xty[a] += features[i]![a]! * ys[i]!;
      for (let b = 0; b < k; b++) xtx[a]![b] += features[i]![a]! * features[i]![b]!;
    }
  }
  return solveLinear(xtx, xty);
}

/** The chain-count feature: log of how many chains the snapshot lists for a protocol, at least one. */
export function logChains(p: SnapshotProtocol): number {
  return Math.log(Math.max(1, p.chains.length));
}

/** Category effects from base-fit residuals: each category's residual sum over (its count + K). */
function categoryEffects(rows: { key: string; resid: number }[]): { effects: Map<string, number>; counts: Map<string, number> } {
  const sums = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const r of rows) {
    sums.set(r.key, (sums.get(r.key) ?? 0) + r.resid);
    counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
  }
  const effects = new Map<string, number>();
  for (const [key, sum] of sums) effects.set(key, sum / (counts.get(key)! + CATEGORY_SHRINK_K));
  return { effects, counts };
}

/**
 * Fit the launch-value model on the priced protocols with a positive cap (a
 * recorded 0 or -1 is a placeholder, not a price). With `useChains`, a third
 * term — log chain count — joins the size curve; the term is only ever shipped
 * when it lowers the held-out miss in both validation tests (see validateModels).
 */
export function fitValueModel(priced: SnapshotProtocol[], useChains = false): ValueFit {
  const ys = priced.map((p) => Math.log(p.mcap_usd!));
  const feats = priced.map((p) => (useChains ? [1, Math.log(p.tvl_usd), logChains(p)] : [1, Math.log(p.tvl_usd)]));
  let coef = regress(feats, ys);
  let chains = useChains;
  if (coef === null && useChains) {
    chains = false;
    coef = regress(priced.map((p) => [1, Math.log(p.tvl_usd)]), ys);
  }
  if (coef === null) {
    const [intercept, slope] = ols(priced.map((p) => Math.log(p.tvl_usd)), ys);
    coef = [intercept, slope];
    chains = false;
  }
  const base = priced.map((p, i) => coef!.reduce((acc, c, k) => acc + c * feats[i]![k]!, 0));
  const rows = priced.map((p, i) => ({ key: categoryKey(p), resid: ys[i]! - base[i]! }));
  const { effects, counts } = categoryEffects(rows);
  const residuals = priced.map((p, i) => rows[i]!.resid - (effects.get(rows[i]!.key) ?? 0));
  return {
    intercept: coef[0]!,
    slope: coef[1]!,
    chainCoef: chains ? coef[2]! : 0,
    useChains: chains,
    categoryEffects: effects,
    categoryCounts: counts,
    residQ25: quantile(residuals, 0.25),
    residQ75: quantile(residuals, 0.75),
    n: priced.length,
  };
}

/** The fitted log launch value of one protocol: size curve at its TVL, the chain term when fitted, plus its category effect. */
export function predictLogValue(fit: ValueFit, p: SnapshotProtocol): number {
  return (
    fit.intercept +
    fit.slope * Math.log(p.tvl_usd) +
    (fit.useChains ? fit.chainCoef * logChains(p) : 0) +
    (fit.categoryEffects.get(categoryKey(p)) ?? 0)
  );
}

// ---------------------------------------------------------------------------
// Launch odds: a logistic fit over every protocol in the snapshot
// ---------------------------------------------------------------------------

/** Prior strength of the category token-share shrinkage, in pseudo-observations at the base rate. */
export const SHARE_PRIOR = 4;
/** The lineage discount applied to the odds of flagged-tier rows. */
export const LINEAGE_ODDS_DISCOUNT = 0.5;

const ODDS_ITERATIONS = 3000;
const ODDS_LEARNING_RATE = 0.1;
const ODDS_L2 = 0.02;
const GROWTH_CLAMP = 50;

/** Population statistics the odds features are built from. */
export interface OddsContext {
  baseRate: number;
  medianAgeDays: number;
  medianChange: number;
  /** Per-category [tokenised count, total count]. */
  categoryTotals: Map<string, [number, number]>;
}

/** The context a set of protocols implies: base rate, imputation medians, category totals. */
export function oddsContext(protocols: SnapshotProtocol[], asOf: string): OddsContext {
  const ages = protocols.map((p) => ageDays(asOf, p.listed_at)).filter((a): a is number => a !== null);
  const changes = protocols.map((p) => p.change_7d).filter((c): c is number => c !== null);
  const categoryTotals = new Map<string, [number, number]>();
  let tokenised = 0;
  for (const p of protocols) {
    if (recordsToken(p)) tokenised++;
    const key = categoryKey(p);
    const cell = categoryTotals.get(key) ?? [0, 0];
    cell[1]++;
    if (recordsToken(p)) cell[0]++;
    categoryTotals.set(key, cell);
  }
  return {
    baseRate: protocols.length === 0 ? 0 : tokenised / protocols.length,
    medianAgeDays: ages.length === 0 ? 0 : median(ages),
    medianChange: changes.length === 0 ? 0 : median(changes),
    categoryTotals,
  };
}

/**
 * The four odds features of one protocol, unstandardised:
 * years listed, category token share, log TVL, clamped 7-day growth.
 * The share is leave-self-out when `selfOutcome` is given (the protocol is
 * part of the context's population), and shrunk toward the base rate either way.
 */
export function oddsFeatures(ctx: OddsContext, asOf: string, p: SnapshotProtocol, selfOutcome?: number): number[] {
  const age = ageDays(asOf, p.listed_at) ?? ctx.medianAgeDays;
  const cell = ctx.categoryTotals.get(categoryKey(p)) ?? [0, 0];
  let tok = cell[0];
  let tot = cell[1];
  if (selfOutcome !== undefined) {
    tok -= selfOutcome;
    tot -= 1;
  }
  const share = (tok + SHARE_PRIOR * ctx.baseRate) / (tot + SHARE_PRIOR);
  const growth = Math.min(GROWTH_CLAMP, Math.max(-GROWTH_CLAMP, p.change_7d ?? ctx.medianChange));
  return [age / 365.25, share, Math.log(p.tvl_usd), growth];
}

/** A fitted odds model: logistic weights over standardised features. */
export interface OddsFit {
  weights: number[];
  means: number[];
  sds: number[];
  context: OddsContext;
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/**
 * Fit the odds model on a population by gradient descent: fixed iterations,
 * zero start, mean log-loss gradient plus an L2 pull on the non-intercept
 * weights. Deterministic by construction.
 */
export function fitOddsModel(protocols: SnapshotProtocol[], asOf: string): OddsFit {
  const ctx = oddsContext(protocols, asOf);
  const raw = protocols.map((p) => oddsFeatures(ctx, asOf, p, recordsToken(p) ? 1 : 0));
  const outcomes = protocols.map((p) => (recordsToken(p) ? 1 : 0));
  const dims = 4;
  const means = new Array<number>(dims).fill(0);
  const sds = new Array<number>(dims).fill(1);
  for (let d = 0; d < dims; d++) {
    const col = raw.map((r) => r[d]!);
    means[d] = col.reduce((a, b) => a + b, 0) / col.length;
    const variance = col.reduce((a, b) => a + (b - means[d]!) ** 2, 0) / col.length;
    sds[d] = Math.sqrt(variance) || 1;
  }
  const z = raw.map((r) => r.map((v, d) => (v - means[d]!) / sds[d]!));
  const w = new Array<number>(dims + 1).fill(0);
  const n = protocols.length;
  for (let iter = 0; iter < ODDS_ITERATIONS; iter++) {
    const grad = new Array<number>(dims + 1).fill(0);
    for (let i = 0; i < n; i++) {
      let score = w[0]!;
      for (let d = 0; d < dims; d++) score += w[d + 1]! * z[i]![d]!;
      const err = sigmoid(score) - outcomes[i]!;
      grad[0] += err;
      for (let d = 0; d < dims; d++) grad[d + 1] += err * z[i]![d]!;
    }
    for (let d = 0; d <= dims; d++) {
      let g = grad[d]! / n;
      if (d > 0) g += ODDS_L2 * w[d]!;
      w[d] = w[d]! - ODDS_LEARNING_RATE * g;
    }
  }
  return { weights: w, means, sds, context: ctx };
}

/** The fitted probability that a protocol records a token, from a fitted odds model. */
export function predictOdds(fit: OddsFit, asOf: string, p: SnapshotProtocol, selfOutcome?: number): number {
  const raw = oddsFeatures(fit.context, asOf, p, selfOutcome);
  let score = fit.weights[0]!;
  for (let d = 0; d < 4; d++) score += fit.weights[d + 1]! * ((raw[d]! - fit.means[d]!) / fit.sds[d]!);
  return sigmoid(score);
}

// ---------------------------------------------------------------------------
// Validation: leave-one-out and walk-forward on the priced protocols, Brier
// for the odds. A candidate term (here: log chain count) joins the shipped
// model only if it lowers the held-out miss in both tests.
// ---------------------------------------------------------------------------

/** One model's leave-one-out record on the priced protocols. */
export interface LooScore {
  /** Median absolute log10 error: half the protocols are priced within this many orders of magnitude. */
  medianAbsLog10Error: number;
  /** The same miss as a multiple: 10 to the median absolute log10 error. */
  missMultiple: number;
  /** Spearman rank correlation between predicted and actual market caps. */
  spearman: number;
  /** How many priced protocols were left out and priced in turn. */
  n: number;
}

function looScore(preds: number[], actuals: number[]): LooScore {
  const errs = preds.map((pred, i) => Math.abs(Math.log10(Math.max(1, pred)) - Math.log10(actuals[i]!)));
  return {
    medianAbsLog10Error: round4(median(errs)),
    missMultiple: round4(10 ** median(errs)),
    spearman: round4(spearman(preds, actuals)),
    n: preds.length,
  };
}

/** The starter radar-1 formula, kept as a baseline: flat multiple with growth and maturity tilts. */
export function starterImplied(p: SnapshotProtocol, asOf: string): number {
  const growth = Math.min(120, Math.max(-60, p.change_7d ?? 0));
  const growthMult = 1 + (growth / 100) * 0.5;
  const age = ageDays(asOf, p.listed_at) ?? 365;
  const maturityMult = 0.6 + (Math.min(age, 1095) / 1095) * 0.4;
  return Math.max(1, Math.round(p.tvl_usd * 0.25 * growthMult * maturityMult));
}

/** One walk-forward record: fit on the earlier-listed priced protocols, price the later-listed ones. */
export interface WalkForward {
  /** The listing date the split turns on: train listed on or before it, test after it. */
  cutoff: string;
  trainN: number;
  testN: number;
  /** Our value model (size curve + shrunk category effects), fitted on the train half only. */
  fitted: LooScore;
  /** The same model with the log chain-count term added, fitted on the train half only. */
  chains: LooScore;
  /** The starter radar-1 formula on the test half (it fits nothing). */
  starter: LooScore;
  /** A flat 0.25 x TVL on the test half. */
  flat: LooScore;
}

/** Everything the validation run measures, printed on the dashboard and reported with the build. */
export interface Validation {
  /** Our full value model (size curve + shrunk category effects), leave-one-out. */
  fittedLoo: LooScore;
  /** Our value model with the log chain-count term added, leave-one-out. */
  chainsLoo: LooScore;
  /** The starter radar-1 formula on the same protocols (it fits nothing, so no refitting). */
  starterLoo: LooScore;
  /** A flat 0.25 x TVL for every protocol. */
  flatLoo: LooScore;
  /** Walk-forward: fit on earlier-listed, price later-listed — the test the field's leaders print. */
  walkForward: WalkForward;
  /**
   * Whether the chain-count term ships. The admission rule is mechanical: a term
   * joins the model only if it lowers the held-out miss in BOTH leave-one-out and
   * walk-forward. Either way the ablation is printed on the dashboard.
   */
  chainsAdmitted: boolean;
  /** Brier score of the odds fit on its own population (lower is better). */
  oddsBrierInSample: number;
  /** Brier score of always predicting the base rate. */
  oddsBrierBaseRate: number;
  /** Brier score of the odds fit, ten-fold over slug order. */
  oddsBrierTenFold: number;
  /** Share of priced protocols whose actual cap falls inside the model's stated P25-P75 band, leave-one-out. */
  bandCoverageLoo: number;
}

/** Price every priced protocol from a value fit that never saw it. */
function looValuePredictions(priced: SnapshotProtocol[], useChains = false): { preds: number[]; inBand: boolean[] } {
  const preds: number[] = [];
  const inBand: boolean[] = [];
  for (let i = 0; i < priced.length; i++) {
    const rest = priced.filter((_, j) => j !== i);
    const fit = fitValueModel(rest, useChains);
    const target = priced[i]!;
    const logPred = predictLogValue(fit, target);
    preds.push(Math.exp(logPred));
    const lo = Math.exp(logPred + fit.residQ25);
    const hi = Math.exp(logPred + fit.residQ75);
    inBand.push(target.mcap_usd! >= lo && target.mcap_usd! <= hi);
  }
  return { preds, inBand };
}

/**
 * Walk-forward validation, the scheme the field's leaders print: order the
 * priced protocols by the day DefiLlama listed them, fit on those listed on or
 * before the median listing date, and price those listed after it — the model
 * only ever prices protocols from its own future. Protocols with no listing
 * date cannot be ordered and sit this test out; their count is the difference
 * between the priced set and train + test.
 */
function walkForwardScores(priced: SnapshotProtocol[], asOf: string): WalkForward {
  const dated = priced
    .filter((p) => p.listed_at !== null)
    .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : 1));
  const mid = Math.max(1, Math.floor(dated.length / 2));
  let cutoff = dated[mid - 1]!.listed_at!;
  let train = dated.filter((p) => p.listed_at! <= cutoff);
  let test = dated.filter((p) => p.listed_at! > cutoff);
  if (test.length < 10 || train.length < 10) {
    train = dated.slice(0, mid);
    test = dated.slice(mid);
    cutoff = dated[mid]!.listed_at!;
  }
  const actuals = test.map((p) => p.mcap_usd!);
  const fitPlain = fitValueModel(train, false);
  const fitChains = fitValueModel(train, true);
  return {
    cutoff,
    trainN: train.length,
    testN: test.length,
    fitted: looScore(test.map((p) => Math.exp(predictLogValue(fitPlain, p))), actuals),
    chains: looScore(test.map((p) => Math.exp(predictLogValue(fitChains, p))), actuals),
    starter: looScore(test.map((p) => starterImplied(p, asOf)), actuals),
    flat: looScore(test.map((p) => Math.max(1, Math.round(p.tvl_usd * 0.25))), actuals),
  };
}

/** Run the whole validation suite on a snapshot. Deterministic; called at build time and printed. */
export function validateModels(snapshot: Snapshot): Validation {
  const priced = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0);
  const actuals = priced.map((p) => p.mcap_usd!);
  const { preds, inBand } = looValuePredictions(priced, false);
  const fittedLoo = looScore(preds, actuals);
  const chainsLoo = looScore(looValuePredictions(priced, true).preds, actuals);
  const starterLoo = looScore(priced.map((p) => starterImplied(p, snapshot.as_of)), actuals);
  const flatLoo = looScore(priced.map((p) => Math.max(1, Math.round(p.tvl_usd * 0.25))), actuals);
  const walkForward = walkForwardScores(priced, snapshot.as_of);
  const chainsAdmitted =
    chainsLoo.medianAbsLog10Error < fittedLoo.medianAbsLog10Error &&
    walkForward.chains.medianAbsLog10Error < walkForward.fitted.medianAbsLog10Error;

  const all = snapshot.protocols;
  const fit = fitOddsModel(all, snapshot.as_of);
  let brierIn = 0;
  let brierBase = 0;
  for (const p of all) {
    const y = recordsToken(p) ? 1 : 0;
    const prob = predictOdds(fit, snapshot.as_of, p, y);
    brierIn += (prob - y) ** 2;
    brierBase += (fit.context.baseRate - y) ** 2;
  }
  // Ten-fold over slug order: the snapshot is slug-sorted, so fold = index mod 10 is a fixed split.
  const sorted = [...all].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  let brierFold = 0;
  for (let fold = 0; fold < 10; fold++) {
    const train = sorted.filter((_, i) => i % 10 !== fold);
    const held = sorted.filter((_, i) => i % 10 === fold);
    const foldFit = fitOddsModel(train, snapshot.as_of);
    for (const p of held) {
      const y = recordsToken(p) ? 1 : 0;
      brierFold += (predictOdds(foldFit, snapshot.as_of, p) - y) ** 2;
    }
  }
  return {
    fittedLoo,
    chainsLoo,
    starterLoo,
    flatLoo,
    walkForward,
    chainsAdmitted,
    oddsBrierInSample: round4(brierIn / all.length),
    oddsBrierBaseRate: round4(brierBase / all.length),
    oddsBrierTenFold: round4(brierFold / all.length),
    bandCoverageLoo: round4(inBand.filter(Boolean).length / inBand.length),
  };
}

// ---------------------------------------------------------------------------
// Farm plans and farm economics: generated per protocol from its own record
// ---------------------------------------------------------------------------

/**
 * The farm-economics assumptions, stated on the dashboard's evidence view —
 * nothing about a verdict is hidden. Every row is priced at the same reference
 * deposit so verdicts compare like with like: a launch is assumed to set aside
 * `poolShare` of the implied value for early users, split evenly across an
 * estimated crowd of qualifying farmers (one per `farmerTvlUsd` of TVL,
 * clamped), because the snapshot records no per-protocol farmer counts. Costs
 * are the plan's own gas (priced by chain class, below) plus a capital charge
 * at `capitalApr` over the hold window. A verdict is Farm when the expected
 * net pays at least `farmPerHour` per hour of work, Marginal down to
 * `marginalPerHour`, and Skip below that or whenever the net is negative.
 */
export const FARM_ASSUMPTIONS = {
  depositUsd: 1000,
  poolShare: 0.04,
  farmerTvlUsd: 25_000,
  minFarmers: 200,
  maxFarmers: 20_000,
  capitalApr: 0.08,
  farmPerHour: 10,
  marginalPerHour: 2,
} as const;

/** A row's farm verdict, in the terms the board prints. */
export type FarmVerdict = 'farm' | 'marginal' | 'skip';

/** One row's costed farm economics at the reference deposit. */
export interface FarmEconomics {
  verdict: FarmVerdict;
  deposit_usd: number;
  /** The expected drop's value: pool share of the implied value over the estimated farmer crowd. */
  gross_usd: number;
  /** Gas for every action in the plan plus the capital charge over the hold. */
  cost_usd: number;
  net_usd: number;
  /** Hours of actual work the plan takes (setup, weekly actions, checks, claim and exit). */
  hours: number;
  per_hour_usd: number;
  /** The estimated crowd of qualifying farmers the pool is split across. */
  farmers: number;
  hold_days: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The costed economics of farming one protocol at the reference deposit, from its own record. */
export function farmEconomics(p: SnapshotProtocol, age: number | null, impliedValueUsd: number): FarmEconomics {
  const a = FARM_ASSUMPTIONS;
  const hold = holdDaysFor(age);
  const weeks = Math.ceil(hold / 7);
  const gas = gasFor(p.chains.length > 0 ? p.chains[0]! : '').usd;
  const actions = 2 + weeks + (p.chains.length > 1 ? 1 : 0); // open, core action, weekly repeats, second-chain move, claim/exit share
  const cost = gas * actions + (a.depositUsd * a.capitalApr * hold) / 365;
  const farmers = Math.min(a.maxFarmers, Math.max(a.minFarmers, Math.round(p.tvl_usd / a.farmerTvlUsd)));
  const gross = (a.poolShare * impliedValueUsd) / farmers;
  const net = gross - cost;
  const hours = 0.75 + weeks * (10 / 60) + 10 / 60;
  const perHour = net / hours;
  const verdict: FarmVerdict = net <= 0 || perHour < a.marginalPerHour ? 'skip' : perHour >= a.farmPerHour ? 'farm' : 'marginal';
  return {
    verdict,
    deposit_usd: a.depositUsd,
    gross_usd: round2(gross),
    cost_usd: round2(cost),
    net_usd: round2(net),
    hours: round2(hours),
    per_hour_usd: round2(perHour),
    farmers,
    hold_days: hold,
  };
}

/** A rough per-action network cost on a chain, by the chain's class. */
function gasFor(chain: string): { label: string; usd: number } {
  if (chain === 'Ethereum') return { label: 'Ethereum mainnet gas', usd: 12 };
  if (chain === 'Solana') return { label: 'Solana fees', usd: 1 };
  const l2 = ['Arbitrum', 'Base', 'Optimism', 'Polygon', 'zkSync Era', 'Linea', 'Scroll', 'Mantle', 'Blast', 'Mode', 'Taiko', 'Starknet', 'Binance'];
  if (l2.includes(chain)) return { label: `${chain} fees`, usd: 1 };
  return { label: `${chain} fees`, usd: 2 };
}

/** The category's core farm action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('uncollateralized')) return `Lend $${capital} of USDC into an ${n} pool on ${chain} and leave the loan to mature.`;
  if (c.includes('lend')) return `Supply $${capital} of USDC to ${n} on ${chain}; borrow no more than a third of it back so the position reads as real use, not a loop.`;
  if (c.includes('cdp')) return `Deposit $${capital} of collateral into ${n} on ${chain} and mint a modest amount of its stablecoin against it.`;
  if (c.includes('dex')) return `Provide $${capital} split between the two sides of ${n}'s busiest pool on ${chain} and keep the LP position open.`;
  if (c.includes('derivative') || c.includes('perps') || c.includes('perp')) return `Deposit $${capital} of USDC as margin on ${n} and run one small hedged position a week so the account shows genuine trading.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('liquidity manager')) return `Deposit $${capital} into a ${n} curated vault on ${chain} and keep the vault shares untouched.`;
  if (c.includes('yield') || c.includes('farm') || c.includes('basis')) return `Deposit $${capital} into ${n}'s main strategy on ${chain} and let the position compound in place.`;
  if (c.includes('rwa')) return `Subscribe $${capital} to ${n}'s tokenised asset on ${chain} and hold it through a full distribution cycle.`;
  if (c.includes('insurance')) return `Commit $${capital} to ${n}'s cover pool on ${chain}, or buy one policy, and keep it active.`;
  if (c.includes('prediction')) return `Fund $${capital} on ${n} and take positions in a few of its listed markets rather than one large bet.`;
  if (c.includes('payment')) return `Hold a working balance of $${capital} in ${n} on ${chain} and route a few real payments through it each month.`;
  if (c.includes('staking') || c.includes('restaking')) return `Stake $${capital} of the underlying asset through ${n} on ${chain} and keep the staking receipt in the wallet.`;
  if (c.includes('chain')) return `Bridge $${capital} to ${chain === p.name ? 'the chain' : chain} and use two or three of its native apps through ${n}'s ecosystem.`;
  if (c.includes('stable') || c.includes('collateral') || c.includes('btc')) return `Deposit $${capital} of the collateral asset into ${n} on ${chain} and hold the issued position.`;
  return `Deposit $${capital} of USDC into ${n} on ${chain} and keep the position open and active.`;
}

/** How long a position should be held, from the protocol's age: younger protocols get the longer window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  if (age < 730) return 30;
  return 21;
}

const VERDICT_WORD: Record<FarmVerdict, string> = { farm: 'FARM', marginal: 'MARGINAL', skip: 'SKIP' };

/**
 * One protocol's farm plan: six steps, each an action with what it costs and
 * how long it takes, derived from the protocol's own category, chains, TVL and
 * age — never from a hand-written list of names. The last step carries the
 * row's costed verdict, computed by farmEconomics from the assumptions printed
 * on the dashboard, so the plan in board.json and the verdict on the page are
 * the same numbers. Every step lands inside the gate's 20..600 trimmed
 * characters by construction and is checked in boardIssue.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, econ: FarmEconomics): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const gas = gasFor(chain);
  const capital = econ.deposit_usd;
  const hold = econ.hold_days;
  const weeks = Math.ceil(hold / 7);
  const multi = p.chains.length > 1 ? ` It runs on ${p.chains.length} chains; start on ${chain} and add ${p.chains[1]} only if the first position goes smoothly.` : '';
  const spread =
    p.chains.length > 1
      ? `In week two, bridge about $200 of the position to ${p.chains[1]} and repeat the core action there, so the wallet qualifies on two of ${p.name}'s ${p.chains.length} chains instead of one. Cost: about $${gasFor(p.chains[1]!).usd} of ${gasFor(p.chains[1]!).label} plus any bridge fee. Time: 15 minutes, once.`
      : `In week two, add one different kind of interaction — a second product surface, a governance vote if ${p.name} runs one, or a small swap alongside the main position — so the wallet reads as a user, not a single deposit. Cost: about $${gas.usd} of ${gas.label}. Time: 15 minutes, once.`;
  const verdictWhy =
    econ.verdict === 'skip'
      ? `the expected drop does not cover the plan's costs — skip it unless you would use ${p.name} anyway`
      : econ.verdict === 'farm'
        ? `the expected drop clears the plan's full cost with room to spare`
        : `the drop clears the cost, but thinly — keep the weekly actions cheap`;
  const farmers = String(econ.farmers).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const steps = [
    `Set up a fresh wallet for ${p.name} alone, fund it on ${chain} with the $${capital} reference position plus a little extra for fees, and keep its seed phrase offline.${multi} Cost: about $${gas.usd} of ${gas.label} to make the first move. Time: 10 minutes.`,
    `${actionFor(p, capital, chain)} Cost: $${capital} of capital and about $${gas.usd} of ${gas.label}. Time: 15 minutes to set up.`,
    spread,
    `Repeat one small qualifying action every week for the ${weeks} weeks of the hold — a top-up, a second deposit, or a vote if ${p.name} runs one — so the wallet's activity spans many snapshots instead of a single day. Cost: about $${gas.usd} of ${gas.label} a week. Time: 10 minutes a week.`,
    `Hold the position for at least ${hold} days. ${p.name} has run ${age === null ? 'for an unrecorded span' : `for ${age} days`} with no token, so a qualifying window measured in weeks, not days, is what its record rewards. Cost: the $${capital} stays in the position and carries the capital charge priced into the verdict below. Time: ${hold} days.`,
    `The arithmetic, on the assumptions printed with this radar: a 4% launch pool split across about ${farmers} qualifying farmers puts the expected drop near $${Math.round(econ.gross_usd)}; gas plus the capital charge come to about $${Math.round(econ.cost_usd)} over ~${econ.hours} hours of work — net $${Math.round(econ.net_usd)} ($${econ.per_hour_usd}/hour), verdict ${VERDICT_WORD[econ.verdict]}: ${verdictWhy}. Claim only from a link ${p.name} itself publishes; exit when the claim window closes, or sooner if its TVL halves. Cost: about $${gas.usd} to claim and withdraw. Time: 20 minutes.`,
  ];
  return steps;
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

/** The board tiers: where a ranked row came from. */
export type Tier = 'watchlist' | 'early' | 'flagged';

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  tier: Tier;
  implied_value_usd: number;
  model: {
    /** The fitted launch value before odds, in whole dollars. */
    launch_value_usd: number;
    /** The size curve alone at this TVL (before the category effect), in whole dollars. */
    size_curve_usd: number;
    /** The category effect applied, in log space. */
    category_effect: number;
    /** The chain-count term's contribution, in log space (0 when the term was not admitted). */
    chain_effect: number;
    /** The fitted probability the protocol records a token, before any tier discount. */
    launch_odds: number;
    /** The multiplier applied to the odds for this row's tier (1, or the lineage discount). */
    odds_discount: number;
    /** The P25 and P75 of the implied value, from the value fit's residual band. */
    implied_p25_usd: number;
    implied_p75_usd: number;
    age_days: number | null;
  };
  /** The costed farm economics at the reference deposit, from FARM_ASSUMPTIONS. */
  farm: FarmEconomics;
  farm_steps: string[];
}

const TIER_OF: Record<string, Tier> = {
  ranked_watchlist: 'watchlist',
  ranked_early: 'early',
  ranked_flagged: 'flagged',
};

/** Rank the classified board groups by fitted implied value, strongest first, ranks 1..N. */
export function buildBoard(
  snapshot: Snapshot,
  classified: Classified[],
  valueFit: ValueFit,
  oddsFit: OddsFit,
): BoardRow[] {
  const scored = classified
    .filter((c) => c.group === 'ranked_watchlist' || c.group === 'ranked_early' || c.group === 'ranked_flagged')
    .map((c) => {
      const p = c.protocol;
      const tier = TIER_OF[c.group]!;
      const age = ageDays(snapshot.as_of, p.listed_at);
      const logValue = predictLogValue(valueFit, p);
      const launchValue = Math.exp(logValue);
      const sizeCurve = Math.exp(valueFit.intercept + valueFit.slope * Math.log(p.tvl_usd));
      const odds = predictOdds(oddsFit, snapshot.as_of, p, 0);
      const discount = tier === 'flagged' ? LINEAGE_ODDS_DISCOUNT : 1;
      const oddsUsed = odds * discount;
      const implied = Math.max(1, Math.round(launchValue * oddsUsed));
      const p25 = Math.min(implied, Math.max(1, Math.round(Math.exp(logValue + valueFit.residQ25) * oddsUsed)));
      const p75 = Math.max(implied, Math.max(1, Math.round(Math.exp(logValue + valueFit.residQ75) * oddsUsed)));
      const econ = farmEconomics(p, age, implied);
      return { p, tier, age, logValue, launchValue, sizeCurve, odds, discount, implied, p25, p75, econ };
    });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    tier: s.tier,
    implied_value_usd: s.implied,
    model: {
      launch_value_usd: Math.max(1, Math.round(s.launchValue)),
      size_curve_usd: Math.max(1, Math.round(s.sizeCurve)),
      category_effect: round4(valueFit.categoryEffects.get(categoryKey(s.p)) ?? 0),
      chain_effect: round4(valueFit.useChains ? valueFit.chainCoef * logChains(s.p) : 0),
      launch_odds: round4(s.odds),
      odds_discount: s.discount,
      implied_p25_usd: s.p25,
      implied_p75_usd: s.p75,
      age_days: s.age,
    },
    farm: s.econ,
    farm_steps: farmSteps(s.p, s.age, s.econ),
  }));
}

/** Why a board is not one the gate will take, or null. Mirrors the gate's board rows. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const snapshotSlugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const r of board) {
    if (!snapshotSlugs.has(r.slug)) return `${r.slug} is not one of the snapshot's protocols`;
    if (seen.has(r.slug)) return `${r.slug} appears twice`;
    seen.add(r.slug);
    if (r.name.length === 0) return `${r.slug} has an empty name`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const len = s.trim().length;
      if (len < 20 || len > 600) return `${r.slug} has a farm step of ${len} trimmed characters`;
    }
  }
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const missing = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < byRank.length; i++) {
    if (byRank[i]!.rank !== i + 1) return `rank ${i + 1} is ${byRank[i]!.rank}`;
    if (i > 0 && byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) {
      return `rank ${i + 1} outranks rank ${i} on implied value`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return 'every row shares one implied value: a board that ranks nothing by value is not a ranking';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Assembly: everything one run computes
// ---------------------------------------------------------------------------

/** The model's base version label; buildEntry states radar-3 instead when the chain-count term is admitted. */
export const MODEL_VERSION = 'radar-2';

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** The dashboard's compact view of one board row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  tier: Tier;
  launch_value_usd: number;
  size_curve_usd: number;
  category_effect: number;
  chain_effect: number;
  launch_odds: number;
  odds_discount: number;
  /** The row's four raw odds features (years listed, category token share, log TVL, clamped growth), so the page can recompute the odds itself. */
  odds_inputs: [number, number, number, number];
  implied_value_usd: number;
  implied_p25_usd: number;
  implied_p75_usd: number;
  /** The best and worst rank this row's own P25-P75 band allows against the board's bands. */
  rank_range: [number, number];
  farm: FarmEconomics;
  farm_steps: string[];
}

/** One priced comparable the value fit learned from, for a detail view's peers strip. */
export interface CompRow {
  name: string;
  tvl_usd: number;
  mcap_usd: number;
}

/** Everything the dashboard renders, computed from the snapshot in one pass. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: {
    value: { intercept: number; slope: number; chain_coef: number; chains_term: boolean; shrink_k: number; priced_n: number; resid_q25: number; resid_q75: number };
    odds: { weights: number[]; means: number[]; sds: number[]; base_rate: number; share_prior: number };
    lineage_odds_discount: number;
  };
  /** The farm-economics assumptions, printed on the evidence view. */
  farm_assumptions: typeof FARM_ASSUMPTIONS;
  validation: Validation;
  ledger: LedgerLine[];
  /** Every group's member slugs, so the page can account for each protocol by name. */
  groups: Record<string, string[]>;
  counts: { protocols: number; watchlist: number; board: number; priced: number };
  /** FNV-1a checksum of the board's rank:slug:implied sequence; the page recomputes it from its own rows. */
  board_checksum: string;
  rows: RadarRow[];
  live: LiveRow[];
  /** The priced comparables per category key, largest first, for detail views. */
  comps: Record<string, CompRow[]>;
}

/**
 * A small checksum of the board (FNV-1a over rank:slug:implied_value joined by
 * bars). The dashboard recomputes the same sum from the rows it renders and
 * prints both, so a reader can see the page and board.json agree.
 */
export function boardChecksum(board: BoardRow[]): string {
  const s = board.map((r) => `${r.rank}:${r.slug}:${r.implied_value_usd}`).join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Everything one run produces: the gate's board and the dashboard's data. */
export interface EntryBuild {
  board: BoardRow[];
  data: RadarData;
  classified: Classified[];
  valueFit: ValueFit;
  oddsFit: OddsFit;
  validation: Validation;
}

/** Run the whole pipeline on a snapshot: classify, fit, validate, rank. */
export function buildEntry(snapshot: Snapshot): EntryBuild {
  const classified = classifyAll(snapshot);
  const priced = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0);
  const validation = validateModels(snapshot);
  // The shipped value fit carries the chain-count term only when validation's
  // two-test admission rule let it in; the model version names the outcome.
  const valueFit = fitValueModel(priced, validation.chainsAdmitted);
  const oddsFit = fitOddsModel(snapshot.protocols, snapshot.as_of);
  const board = buildBoard(snapshot, classified, valueFit, oddsFit);

  const groups: Record<string, string[]> = {};
  for (const c of classified) (groups[c.group] ??= []).push(c.protocol.slug);
  for (const key of Object.keys(groups)) groups[key]!.sort();

  const live: LiveRow[] = snapshot.protocols
    .filter((p) => p.mcap_usd !== null)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || (a.slug < b.slug ? -1 : 1))
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));

  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const rows: RadarRow[] = board.map((r) => {
    let certainlyAbove = 0;
    let possiblyAbove = 0;
    for (const other of board) {
      if (other.slug === r.slug) continue;
      if (other.model.implied_p25_usd > r.model.implied_p75_usd) certainlyAbove++;
      if (other.model.implied_p75_usd > r.model.implied_p25_usd) possiblyAbove++;
    }
    const feats = oddsFeatures(oddsFit.context, snapshot.as_of, bySlug.get(r.slug)!, 0);
    return {
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      listed_at: r.listed_at,
      age_days: r.age_days,
      tier: r.tier,
      launch_value_usd: r.model.launch_value_usd,
      size_curve_usd: r.model.size_curve_usd,
      category_effect: r.model.category_effect,
      chain_effect: r.model.chain_effect,
      launch_odds: r.model.launch_odds,
      odds_discount: r.model.odds_discount,
      odds_inputs: [round4(feats[0]!), round4(feats[1]!), round4(feats[2]!), round4(feats[3]!)],
      implied_value_usd: r.implied_value_usd,
      implied_p25_usd: r.model.implied_p25_usd,
      implied_p75_usd: r.model.implied_p75_usd,
      rank_range: [certainlyAbove + 1, possiblyAbove + 1],
      farm: r.farm,
      farm_steps: r.farm_steps,
    };
  });

  const comps: Record<string, CompRow[]> = {};
  for (const p of priced) {
    const key = categoryKey(p);
    (comps[key] ??= []).push({ name: p.name, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd! });
  }
  for (const key of Object.keys(comps)) {
    comps[key] = comps[key]!.sort((a, b) => b.mcap_usd - a.mcap_usd || (a.name < b.name ? -1 : 1)).slice(0, 4);
  }

  const data: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: validation.chainsAdmitted ? 'radar-3' : 'radar-2',
    model: {
      value: {
        intercept: round4(valueFit.intercept),
        slope: round4(valueFit.slope),
        chain_coef: round4(valueFit.chainCoef),
        chains_term: valueFit.useChains,
        shrink_k: CATEGORY_SHRINK_K,
        priced_n: valueFit.n,
        resid_q25: round4(valueFit.residQ25),
        resid_q75: round4(valueFit.residQ75),
      },
      odds: {
        weights: oddsFit.weights.map(round4),
        means: oddsFit.means.map(round4),
        sds: oddsFit.sds.map(round4),
        base_rate: round4(oddsFit.context.baseRate),
        share_prior: SHARE_PRIOR,
      },
      lineage_odds_discount: LINEAGE_ODDS_DISCOUNT,
    },
    farm_assumptions: FARM_ASSUMPTIONS,
    validation,
    ledger: ledgerOf(classified),
    groups,
    counts: {
      protocols: snapshot.protocols.length,
      watchlist: snapshot.watchlist.length,
      board: board.length,
      priced: snapshot.protocols.filter((p) => p.mcap_usd !== null).length,
    },
    board_checksum: boardChecksum(board),
    rows,
    live,
    comps,
  };
  return { board, data, classified, valueFit, oddsFit, validation };
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(data: RadarData): string {
  return `window.RADAR=${JSON.stringify(data)};\n`;
}
