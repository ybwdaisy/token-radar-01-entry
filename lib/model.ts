// Token Launch Radar — the valuation and farming model.
//
// One sealed DefiLlama snapshot in, one ranked board out. Nothing in this file names a
// protocol: every number is a function of the snapshot's own figures, so the same code
// scores a future snapshot it has never seen.
//
// THE MODEL (version comps-2)
// ---------------------------
// The snapshot carries no fees or revenue series, so the honest anchor for "what would
// this protocol's token be worth" is what the market already pays for comparable
// protocols that DO trade. For every category we take the live-token protocols in the
// snapshot itself, form ratio = market_cap / TVL for each, and use the category median
// as the multiple. Small categories are shrunk toward the global median with a
// pseudo-observation weight that grows as the comparable count falls (x3 at one
// comparable, x2 at two), and the applied multiple is clamped to [MULT_MIN, MULT_MAX]. The
// category 25th/75th percentile ratios give each row a value range, not just a point.
//
//   implied = TVL x categoryMultiple x growthMult x maturityMult x breadthMult
//
//   growthMult    = 1 + clamp(change_7d, -40, +60)/100 x 0.5   (missing change -> 1)
//   maturityMult  = 0.75 + 0.35 x (1 - exp(-age_days/540))     (unknown age -> 365d)
//   breadthMult   = 1 + 0.015 x min(chains - 1, 8)
//
// WHO GETS RANKED
// ---------------
// A protocol is a launch candidate only when it records no token (market cap, CoinGecko
// id and symbol all null) AND it is not a wrapper around someone else's token: the same
// exclusions the house watchlist applies (CEX / bridge / liquid-staking categories,
// versioned names, "wrapped / staked / staking" name words, exchange name prefixes) are
// applied to the whole universe, not just above the $50M floor. WBTC-style products are
// counted and reported as filtered out, never ranked: their token already exists.
// Live-token protocols are likewise set aside and reported with their real market caps,
// so the board never mixes a model's claim with a market fact.

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

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export const MODEL_VERSION = 'comps-2';

export interface ModelConstants {
  shrink_k: number;
  ratio_min: number;
  ratio_max: number;
  mult_min: number;
  mult_max: number;
  growth_floor: number;
  growth_cap: number;
  growth_weight: number;
  maturity_base: number;
  maturity_range: number;
  maturity_tau_days: number;
  unknown_age_days: number;
  breadth_per_chain: number;
  breadth_max_extra: number;
}

export const MODEL: ModelConstants = {
  shrink_k: 8,
  ratio_min: 0.005,
  ratio_max: 20,
  mult_min: 0.04,
  mult_max: 2.5,
  growth_floor: -40,
  growth_cap: 60,
  growth_weight: 0.5,
  maturity_base: 0.75,
  maturity_range: 0.35,
  maturity_tau_days: 540,
  unknown_age_days: 365,
  breadth_per_chain: 0.015,
  breadth_max_extra: 8,
};

/** How many live-token protocols the dashboard's Live view carries, by market cap. */
export const LIVE_ROWS = 30;

const DAY_MS = 86_400_000;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** Whole days from listed_at to the snapshot date, clamped at zero; null when unknown. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether the snapshot records no token for this protocol. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const EXCLUDED_CATEGORIES = new Set([
  'CEX',
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
]);
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPER_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * Why a pre-token protocol is not a launch candidate, or null when it is one.
 * A wrapped, staked or exchange product's token story belongs to its parent, not to it.
 */
export function exclusionReason(p: SnapshotProtocol): string | null {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return 'wrapper-category';
  if (VERSIONED.test(p.name)) return 'versioned-name';
  if (WRAPPER_WORD.test(p.name)) return 'wrapper-name';
  if (EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x))) return 'exchange-name';
  return null;
}

/** One category's comparable set: live-token protocols whose market cap the market set. */
export interface CategoryComps {
  category: string;
  live_n: number;
  median: number;
  p25: number;
  p75: number;
  applied: number;
  applied_p25: number;
  applied_p75: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[at]!;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/**
 * The comparable multiples, derived only from the snapshot: for each category, the
 * distribution of market_cap/TVL over its live-token protocols, shrunk toward the
 * global distribution by SHRINK_K pseudo-observations and clamped to a sane band.
 */
export function categoryComps(snapshot: Snapshot, model: ModelConstants = MODEL): Map<string, CategoryComps> {
  const ratiosByCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (recordsNoToken(p)) continue;
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (ratio < model.ratio_min || ratio > model.ratio_max) continue;
    const key = p.category ?? 'Uncategorised';
    const list = ratiosByCategory.get(key) ?? [];
    list.push(ratio);
    ratiosByCategory.set(key, list);
    all.push(ratio);
  }
  all.sort((a, b) => a - b);
  const globalMedian = quantile(all, 0.5);
  const globalP25 = quantile(all, 0.25);
  const globalP75 = quantile(all, 0.75);
  // Shrinkage weight: the base K, trebled for a one-comparable category and doubled
  // for two, because a single live protocol can be miscategorised by the source and
  // must not price a whole category on its own (the snapshot's one live "Risk
  // Curators" entry carries a 2.98x ratio that is really a data-feed token's).
  const shrinkK = (n: number): number => model.shrink_k * (n >= 3 ? 1 : n === 2 ? 2 : 3);
  const shrink = (value: number, global: number, n: number): number =>
    (n * value + shrinkK(n) * global) / (n + shrinkK(n));
  const out = new Map<string, CategoryComps>();
  for (const [category, ratios] of ratiosByCategory) {
    ratios.sort((a, b) => a - b);
    const n = ratios.length;
    out.set(category, {
      category,
      live_n: n,
      median: round4(quantile(ratios, 0.5)),
      p25: round4(quantile(ratios, 0.25)),
      p75: round4(quantile(ratios, 0.75)),
      applied: round4(clamp(shrink(quantile(ratios, 0.5), globalMedian, n), model.mult_min, model.mult_max)),
      applied_p25: round4(clamp(shrink(quantile(ratios, 0.25), globalP25, n), model.mult_min, model.mult_max)),
      applied_p75: round4(clamp(shrink(quantile(ratios, 0.75), globalP75, n), model.mult_min, model.mult_max)),
    });
  }
  // A category with no live comparable falls back to the global distribution itself.
  const fallback: CategoryComps = {
    category: 'Uncategorised',
    live_n: 0,
    median: round4(globalMedian),
    p25: round4(globalP25),
    p75: round4(globalP75),
    applied: round4(clamp(globalMedian, model.mult_min, model.mult_max)),
    applied_p25: round4(clamp(globalP25, model.mult_min, model.mult_max)),
    applied_p75: round4(clamp(globalP75, model.mult_min, model.mult_max)),
  };
  out.set('__global__', { ...fallback, category: '__global__', live_n: all.length });
  return out;
}

export interface ValueBreakdown {
  implied: number;
  low: number;
  high: number;
  category_multiple: number;
  comps_n: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  age: number | null;
}

/** One protocol's implied value and the full arithmetic behind it. */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  comps: Map<string, CategoryComps>,
  model: ModelConstants = MODEL,
): ValueBreakdown {
  const own = comps.get(p.category ?? 'Uncategorised');
  const cat = own ?? comps.get('__global__')!;
  const usingGlobal = own === undefined;
  const age = ageDays(asOf, p.listed_at);
  const ageForModel = age ?? model.unknown_age_days;
  const growthPct = p.change_7d === null ? 0 : clamp(p.change_7d, model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const maturityMult = model.maturity_base + model.maturity_range * (1 - Math.exp(-Math.max(0, ageForModel) / model.maturity_tau_days));
  const breadthMult = 1 + model.breadth_per_chain * Math.min(Math.max(p.chains.length - 1, 0), model.breadth_max_extra);
  const rest = growthMult * maturityMult * breadthMult;
  return {
    implied: Math.max(1, Math.round(p.tvl_usd * cat.applied * rest)),
    low: Math.max(1, Math.round(p.tvl_usd * Math.min(cat.applied_p25, cat.applied) * rest)),
    high: Math.max(1, Math.round(p.tvl_usd * Math.max(cat.applied_p75, cat.applied) * rest)),
    category_multiple: cat.applied,
    comps_n: usingGlobal ? 0 : cat.live_n,
    growth_multiplier: round4(growthMult),
    maturity_multiplier: round4(maturityMult),
    breadth_multiplier: round4(breadthMult),
    age,
  };
}

// ---------------------------------------------------------------------------
// Farm plans. Every step is built from the protocol's own record: its category
// decides the actions, its first chains decide where and what gas costs, its TVL
// decides a sane position size, and its age decides the qualifying hold. Each
// step states its cost and its time; the plan totals are summed for the detail
// view. No step is a slogan and no protocol name is special-cased.
// ---------------------------------------------------------------------------

interface GasTier {
  setup: string;
  weekly: string;
  note: string;
}

function gasTier(chain: string): GasTier {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return { setup: '$12', weekly: '$6', note: 'mainnet gas' };
  if (c === 'solana') return { setup: '$0.10', weekly: '$0.05', note: 'Solana fees' };
  if (c === 'polygon') return { setup: '$0.05', weekly: '$0.02', note: 'Polygon fees' };
  if (['base', 'arbitrum', 'optimism', 'zksync era', 'linea', 'scroll', 'mantle', 'blast', 'mode', 'taiko'].includes(c))
    return { setup: '$0.60', weekly: '$0.25', note: 'L2 gas' };
  if (c === 'binance' || c === 'bsc') return { setup: '$0.40', weekly: '$0.15', note: 'BSC gas' };
  if (c === 'avalanche') return { setup: '$0.35', weekly: '$0.15', note: 'Avalanche gas' };
  if (c === 'bitcoin') return { setup: '$1.50', weekly: '$0.80', note: 'Bitcoin fees' };
  return { setup: '$1.50', weekly: '$0.60', note: 'network gas' };
}

/** A sane single-wallet position for a first farm, scaled to the protocol's depth. */
function capitalFor(tvl: number): number {
  if (tvl >= 1_000_000_000) return 500;
  if (tvl >= 250_000_000) return 250;
  if (tvl >= 50_000_000) return 150;
  if (tvl >= 10_000_000) return 100;
  return 75;
}

/** Qualifying hold: younger protocols need a longer track record of activity. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 540) return 45;
  return 30;
}

interface Playbook {
  core: (name: string, chain: string, capital: number) => string;
  second: (name: string, chain: string, capital: number) => string;
  weekly: string;
  risk: string;
}

const PLAYBOOKS: Record<string, Playbook> = {
  lending: {
    core: (n, ch, c) => `Supply $${c} of USDC to ${n} on ${ch}, then borrow about $${Math.round(c * 0.3)} against it and re-supply the borrow once, keeping the health factor above 1.6`,
    second: (n, ch, c) => `Repay the borrow and re-open it at the same size so ${n} records both a supply and a borrow history for the wallet on ${ch}`,
    weekly: 'rebalance the collateral ratio and make one small repay-and-reborrow cycle',
    risk: 'liquidation: if the collateral asset falls, the position can be liquidated before any token exists',
  },
  dexs: {
    core: (n, ch, c) => `Add $${c} of liquidity to ${n}'s deepest stable or major pair on ${ch}, split evenly across both assets, and keep the LP position open`,
    second: (n, ch, c) => `Route about $${Math.round(c * 0.4)} of swaps through ${n} on ${ch} across at least three separate days, using the same wallet as the LP position`,
    weekly: 'make two small swaps and check the LP range or pool share once',
    risk: 'impermanent loss: a one-sided price move can leave the LP worth less than holding the assets',
  },
  risk: {
    core: (n, ch, c) => `Deposit $${c} of USDC into a ${n} curated vault on ${ch}, choosing the vault whose strategy page names its collateral and curator, and keep the vault shares`,
    second: (n, ch, c) => `Read the vault's allocation breakdown in ${n}'s app and move the deposit only if the curator changes strategy; otherwise add $${Math.round(c * 0.25)} after two clean weeks`,
    weekly: "open the vault page, confirm the curator's stated strategy still matches the allocations, and screenshot the position for the farm log",
    risk: 'curator risk: the vault follows a third-party strategy, so a bad allocation can lose money the protocol itself did not choose',
  },
  allocator: {
    core: (n, ch, c) => `Deposit $${c} of USDC into a ${n} vault on ${ch} and hold the shares; note the vault's stated strategy and lock terms before confirming`,
    second: (n, ch, c) => `Claim any vault yield shown in ${n} and re-deposit it once, so the wallet shows both a deposit and a compounding history on ${ch}`,
    weekly: 'check the vault share price and claim or compound any accrued yield once',
    risk: 'strategy risk: the allocator can rotate into underlying venues whose losses pass through to the vault shares',
  },
  yield: {
    core: (n, ch, c) => `Deposit $${c} of USDC into ${n}'s base (non-boosted) vault on ${ch} and hold the position; skip any leveraged or points-boosted tier for the first cycle`,
    second: (n, ch, c) => `Harvest the yield ${n} shows for the position and re-deposit it once, keeping the harvest transaction in the same wallet on ${ch}`,
    weekly: 'harvest or compound the accrued yield once and confirm the vault APY has not gone negative',
    risk: 'yield compression: the rate that makes the farm worthwhile can fall to near zero long before any launch',
  },
  rwa: {
    core: (n, ch, c) => `Complete ${n}'s onboarding or KYC if it asks for one, then mint or buy $${c} of its yield-bearing asset on ${ch} and hold it in the farming wallet`,
    second: (n, ch, c) => `Claim the first yield payment ${n} distributes and re-buy about $${Math.round(c * 0.2)} more of the asset with it on ${ch}`,
    weekly: 'check the asset page for yield distributions and any redemption-window notice',
    risk: 'redemption risk: real-world-asset tokens can gate or delay exits, so the capital may not be withdrawable on demand',
  },
  cdp: {
    core: (n, ch, c) => `Open a ${n} vault on ${ch} with about $${Math.round(c * 1.5)} of collateral and mint $${c} of its stablecoin against it, keeping the collateral ratio at least 50 points above the liquidation line`,
    second: (n, ch, c) => `Repay about a third of the minted stablecoin and mint it again a week later, so ${n} records a full borrow-repay cycle for the wallet`,
    weekly: 'check the collateral ratio and top up or repay if it drifts toward the liquidation line',
    risk: 'liquidation: a sharp collateral drop can close the vault at a penalty before any token exists',
  },
  derivatives: {
    core: (n, ch, c) => `Deposit $${c} of USDC as margin on ${n} (${ch}) and open one small hedged position, long and short the same asset in equal size, so the farm earns activity without directional risk`,
    second: (n, ch, c) => `Close and re-open the hedge once at the same size so ${n} records completed trades, not just a deposit, for the wallet`,
    weekly: 'roll the hedge once and confirm funding payments have not eaten more than a few dollars',
    risk: 'funding and liquidation: a hedged book still pays funding and can be liquidated leg by leg in a fast move',
  },
  basis: {
    core: (n, ch, c) => `Deposit $${c} of USDC into ${n}'s basis-trade vault on ${ch} and hold the shares for a full funding cycle before judging the yield`,
    second: (n, ch, c) => `Add $${Math.round(c * 0.25)} more after the first distribution lands, so the wallet shows two deposits across different funding conditions on ${ch}`,
    weekly: 'check the vault yield against the funding rate it reports and note any negative week in the farm log',
    risk: 'funding flip: when funding turns negative the basis trade pays instead of earning, and vault yield can go below zero',
  },
  chain: {
    core: (n, ch, c) => `Bridge $${c} of USDC plus a small gas balance to ${n}'s chain (${ch}) through its canonical route and make the wallet's first transactions there`,
    second: (n, ch, c) => `Use two native apps on ${n}'s chain with the bridged funds (one swap venue, one lending or staking app) so the wallet is a chain user, not just a bridge passer-by`,
    weekly: 'make two or three ordinary transactions on the chain (a swap, a transfer, a contract approval)',
    risk: 'bridge risk: the canonical bridge is the single point of failure for everything moved to the chain',
  },
  restaking: {
    core: (n, ch, c) => `Stake or restake about $${c} of the chain's staking asset through ${n} on ${ch} and keep the receipt token in the farming wallet`,
    second: (n, ch, c) => `Delegate or allocate the restaked position to one operator or service inside ${n} if it offers the choice, and record which one in the farm log`,
    weekly: 'check the operator set and any slashing or withdrawal-queue notice once',
    risk: 'slashing and lockup: restaked assets can be slashed for operator faults and withdrawals can queue for weeks',
  },
  insurance: {
    core: (n, ch, c) => `Buy about $${c} of cover from ${n} on ${ch} for a position you actually hold, or stake into its capital pool if buying cover is not offered`,
    second: (n, ch, c) => `Renew or extend the cover once when the first term lapses, so ${n} records a returning policyholder rather than a one-off visit`,
    weekly: 'check the cover terms and pool capacity once; no transaction is needed most weeks',
    risk: 'claims risk: cover pays only under the policy terms, and capital-pool staking can be drawn on by other users claims',
  },
  prediction: {
    core: (n, ch, c) => `Fund $${c} on ${n} (${ch}) and place small positions in three of its most liquid markets, sized so no single market holds more than half the stake`,
    second: (n, ch, c) => `Settle or close one finished market and re-enter a new one, so ${n} records a full trade-settle-retrade history for the wallet`,
    weekly: 'place or roll one position in a liquid market and record the entry price in the farm log',
    risk: 'total-loss markets: a wrong prediction settles at zero, so position sizing is the whole risk control',
  },
  fallback: {
    core: (n, ch, c) => `Deposit $${c} of USDC into ${n} on ${ch} through its main product surface and keep the position open; read its docs page first so the deposit uses the flagship flow, not a test pool`,
    second: (n, ch, c) => `Use a second surface of ${n} on ${ch} (a different vault, market or module) with about $${Math.round(c * 0.3)}, so the wallet is not a single-click visitor`,
    weekly: 'make one small qualifying transaction (a deposit, claim or adjustment) in the main position',
    risk: 'smart-contract risk: an unaudited or freshly upgraded contract can lose the deposit outright',
  },
};

function playbookFor(category: string | null): Playbook {
  const c = (category ?? '').toLowerCase();
  if (c.includes('lend')) return PLAYBOOKS.lending!;
  if (c.includes('dex')) return PLAYBOOKS.dexs!;
  if (c.includes('curator')) return PLAYBOOKS.risk!;
  if (c.includes('allocator')) return PLAYBOOKS.allocator!;
  if (c.includes('cdp')) return PLAYBOOKS.cdp!;
  if (c.includes('deriv') || c.includes('perpetual')) return PLAYBOOKS.derivatives!;
  if (c.includes('basis')) return PLAYBOOKS.basis!;
  if (c === 'chain') return PLAYBOOKS.chain!;
  if (c.includes('restak') || c.includes('staking')) return PLAYBOOKS.restaking!;
  if (c.includes('insurance')) return PLAYBOOKS.insurance!;
  if (c.includes('prediction')) return PLAYBOOKS.prediction!;
  if (c.includes('rwa')) return PLAYBOOKS.rwa!;
  if (c.includes('yield')) return PLAYBOOKS.yield!;
  return PLAYBOOKS.fallback!;
}

/** One protocol's farm plan: seven steps, each with its cost and its time. */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const book = playbookFor(p.category);
  const chain = p.chains[0] ?? 'its main chain';
  const gas = gasTier(chain);
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const steps: string[] = [
    `Set up a dedicated wallet for ${p.name} and fund it on ${chain} with the position capital plus a small gas balance; keep the seed phrase offline and never reuse this wallet for unrelated airdrops. Cost: about ${gas.setup} of ${gas.note} to make the wallet active. Time: 10 minutes.`,
    `${book.core(p.name, chain, capital)}. Cost: $${capital} of capital plus about ${gas.setup} of ${gas.note}. Time: 20 minutes to set up carefully.`,
    `${book.second(p.name, chain, capital)}. Cost: about ${gas.weekly} of ${gas.note} in transaction fees. Time: 15 minutes.`,
  ];
  if (p.chains.length >= 2) {
    const second = p.chains[1]!;
    const g2 = gasTier(second);
    steps.push(
      `Repeat a smaller position of about $${Math.round(capital * 0.4)} on ${second}, ${p.name}'s second chain, so the wallet qualifies on more than one network if activity is counted per chain. Cost: $${Math.round(capital * 0.4)} of capital plus about ${g2.setup} of ${g2.note}. Time: 20 minutes.`,
    );
  } else {
    steps.push(
      `After two clean weeks, add about $${Math.round(capital * 0.25)} to the main ${p.name} position on ${chain} in a separate transaction, so the wallet shows returning, growing usage rather than one deposit. Cost: $${Math.round(capital * 0.25)} of added capital plus about ${gas.weekly} of ${gas.note}. Time: 10 minutes.`,
    );
  }
  steps.push(
    `Once a week, ${book.weekly} on ${p.name}; keep every action in the same wallet and never batch a month of activity into one day. Cost: about ${gas.weekly} of ${gas.note} per week. Time: 10 minutes a week.`,
    `Hold the position for at least ${hold} days so the activity spans several weekly snapshots, and check ${p.name}'s own points or rewards page only through the link its official site or docs publish. Cost: the $${capital} stays deployed; never pay anyone to claim or to boost eligibility. Time: ${hold} days of holding, 5 minutes a check.`,
    `Log every transaction hash, date and balance in a farm log, and unwind if ${p.name}'s TVL falls more than 30% in a week or its docs announce a snapshot already taken; the standing risk here is ${book.risk}. Cost: nothing to log; unwinding costs about ${gas.setup} of ${gas.note}. Time: 15 minutes to exit.`,
  );
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 596)}...` : s));
}

// ---------------------------------------------------------------------------
// The board and the dashboard's data.
// ---------------------------------------------------------------------------

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  implied_value_usd: number;
  value_low_usd: number;
  value_high_usd: number;
  category_multiple: number;
  comps_n: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: ModelConstants;
  global: { live_n: number; median: number; p25: number; p75: number };
  categories: CategoryComps[];
  counts: {
    protocols: number;
    records_no_token: number;
    filtered_out: number;
    ranked: number;
    watchlist: number;
    live: number;
  };
  filter_reasons: Record<string, number>;
  rows: BoardRow[];
  live: LiveRow[];
}

/** The ranked board: every genuine pre-token candidate, strongest implied value first. */
export function buildBoard(snapshot: Snapshot, comps: Map<string, CategoryComps>): BoardRow[] {
  const watch = new Set(snapshot.watchlist);
  const candidates = snapshot.protocols.filter((p) => recordsNoToken(p) && exclusionReason(p) === null);
  const scored = candidates.map((p) => ({ p, v: impliedValue(p, snapshot.as_of, comps) }));
  scored.sort(
    (a, b) =>
      b.v.implied - a.v.implied ||
      b.p.tvl_usd - a.p.tvl_usd ||
      (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.v.age,
    on_watchlist: watch.has(s.p.slug),
    implied_value_usd: s.v.implied,
    value_low_usd: s.v.low,
    value_high_usd: s.v.high,
    category_multiple: s.v.category_multiple,
    comps_n: s.v.comps_n,
    growth_multiplier: s.v.growth_multiplier,
    maturity_multiplier: s.v.maturity_multiplier,
    breadth_multiplier: s.v.breadth_multiplier,
    farm_steps: farmSteps(s.p, s.v.age),
  }));
}

/** Everything the dashboard renders, computed from the snapshot alone. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const comps = categoryComps(snapshot);
  const board = buildBoard(snapshot, comps);
  const liveAll = snapshot.protocols.filter((p) => !recordsNoToken(p));
  const live: LiveRow[] = liveAll
    .slice()
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
  const reasons: Record<string, number> = {};
  let noToken = 0;
  for (const p of snapshot.protocols) {
    if (!recordsNoToken(p)) continue;
    noToken += 1;
    const r = exclusionReason(p);
    if (r !== null) reasons[r] = (reasons[r] ?? 0) + 1;
  }
  const global = comps.get('__global__')!;
  const categories = [...comps.values()]
    .filter((c) => c.category !== '__global__')
    .sort((a, b) => b.live_n - a.live_n || (a.category < b.category ? -1 : 1));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model: MODEL,
    global: { live_n: global.live_n, median: global.median, p25: global.p25, p75: global.p75 },
    categories,
    counts: {
      protocols: snapshot.protocols.length,
      records_no_token: noToken,
      filtered_out: noToken - board.length,
      ranked: board.length,
      watchlist: snapshot.watchlist.length,
      live: liveAll.length,
    },
    filter_reasons: reasons,
    rows: board,
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null when it is valid. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `the board has ${board.length} rows`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++)
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd)
    return 'every row shares one implied value: not a ranking';
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e12)
      return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
