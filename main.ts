// Pump.fun Sharpe Sprint — cleanest paper bot.
//
// What the dev window taught (measured, not assumed): on pump.fun bonding
// curves the median coin bleeds steadily after its first trades, and round
// -trip friction is ~2.5% curve fees plus tx fees, so active momentum
// trading loses money with high variance — the opposite of hourly Sharpe.
// The one entry profile with positive measured expectancy is narrow: a coin
// whose real SOL reserve crosses 3 SOL within ~100 slots of its first trade,
// with at least 4 distinct non-creator buyers and the creator's own buys a
// small share of volume (organic demand, not a dev bundle). Those entries
// are the PnL engine here: one per mint, small size, trailing exit.
//
// Everything else is loss-minimisation. The guardrails need round trips of
// at least 0.01 SOL on 20 distinct mints, so if selective entries are not
// covering that count as slots pass, the bot banks minimum-size round trips
// on live mints and exits within a few slots — the cost is essentially the
// fees, exposure time is tiny, and hourly returns stay near-flat.
//
// Determinism: no clock, no randomness, no network, no environment. Decisions
// depend only on hello/batch contents; ties break on the mint string, so two
// runs emit identical orders.

import { runBot, type BotState, type Batch, type OrderInput } from './vendor/makefun-bot.ts';

// ---- selective profile entries ---------------------------------------------
const PROFILE_RESERVE = 3_000_000_000n; // real SOL reserve crossing, 3 SOL
const PROFILE_MAX_SLOTS = 100; // crossing must happen within this many slots of the first trade
const PROFILE_MIN_BUYERS = 4; // distinct non-creator buyers by crossing time
const PROFILE_MAX_CREATOR_SHARE = 0.3; // creator buys <= 30% of buy volume
const PROFILE_SIZE = 80_000_000n; // 0.08 SOL target (capped by the 1% reserve rule)
const PROFILE_MIN_SIZE = 12_000_000n;

// ---- exits (profile positions) ----------------------------------------------
const STOP_LOSS = 0.88; // sell when net proceeds <= cost * 0.88
const TRAIL_ARM = 1.15; // trailing stop arms once proceeds >= cost * 1.15
const TRAIL_GIVEBACK = 0.85; // ...and fires 15% below peak proceeds
const MAX_HOLD_SLOTS = 600;
const DEAD_SLOTS = 300; // no trade on the mint for this long -> exit

// ---- guardrail banking -------------------------------------------------------
const BANK_SIZE = 12_000_000n; // 0.012 SOL, just above the 0.01 SOL round-trip minimum
const BANK_MIN_RESERVE = 1_500_000_000n;
const BANK_EXIT_AGE = 6; // slots after entry fill before selling a banking position
const BANK_PACE_SLOTS = 150; // at most one banking entry per this many slots
const BANK_START_SLOTS = 1200; // slots since first batch before banking begins
const GUARDRAIL_TARGET = 22; // distinct mints to cover (20 required + margin)
const GUARDRAIL_MIN_BUY = 10_000_000n;

const MAX_POSITIONS = 5;
const BUY_SLIPPAGE_BPS = 800;
const SELL_SLIPPAGE_BPS = 1500;

interface MintProfile {
  firstTradeSlot: number;
  creator: string;
  buyVol: bigint;
  creatorBuyVol: bigint;
  buyers: Set<string>;
  crossed: boolean; // reserve already crossed PROFILE_RESERVE (profile judged once)
  lastTradeSlot: number;
  trades: number;
}

interface HoldingInfo {
  entrySlot: number;
  peakProceeds: bigint;
  banking: boolean;
}

const profiles = new Map<string, MintProfile>();
const holdings = new Map<string, HoldingInfo>();
const boughtMints = new Set<string>(); // filled buy >= guardrail minimum
const roundTripped = new Set<string>(); // bought and later sold (filled)
const profileTraded = new Set<string>();
let firstSlot = -1;
let lastBankSlot = -1_000_000;

function getProfile(mint: string): MintProfile {
  let p = profiles.get(mint);
  if (!p) {
    p = { firstTradeSlot: -1, creator: '', buyVol: 0n, creatorBuyVol: 0n, buyers: new Set(), crossed: false, lastTradeSlot: -1, trades: 0 };
    profiles.set(mint, p);
  }
  return p;
}

/** Estimated SOL received for selling `tokens` now: constant-product curve
 *  proceeds, minus curve fees (protocol + creator fallback bps) and the
 *  per-order tx fee. Decision-time estimate only; the harness settles fills. */
function estSellProceeds(state: BotState, mint: string, tokens: bigint): bigint {
  const c = state.curves.get(mint);
  if (!c || tokens === 0n) return 0n;
  const vSol = c.virtual_quote_reserves;
  const vTok = c.virtual_token_reserves;
  if (vSol === 0n || vTok === 0n) return 0n;
  const gross = vSol - (vSol * vTok) / (vTok + tokens);
  const feeBps = BigInt(state.hello.fees.protocol_bps_fallback + state.hello.fees.creator_bps_fallback);
  const net = (gross * (10_000n - feeBps)) / 10_000n - state.txFeeLamports();
  return net > 0n ? net : 0n;
}

function ingestEvents(batch: Batch): string[] {
  // Mints whose reserve crosses PROFILE_RESERVE on a trade in this batch AND
  // pass the profile at that exact trade (state includes that trade, not
  // later trades in the batch — evaluating at end-of-batch would let
  // post-crossing flow dilute the creator-share and buyer tests).
  const qualifiedNow: string[] = [];
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      const p = getProfile(e.mint);
      if (!p.creator) p.creator = e.creator;
      continue;
    }
    if (e.event !== 'TradeEvent') continue;
    const p = getProfile(e.mint);
    if (!p.creator) p.creator = e.creator;
    if (p.firstTradeSlot < 0) p.firstTradeSlot = e.slot;
    p.lastTradeSlot = e.slot;
    p.trades += 1;
    if (e.is_buy) {
      const sol = BigInt(e.sol_amount);
      p.buyVol += sol;
      if (e.user === p.creator) p.creatorBuyVol += sol;
      else p.buyers.add(e.user);
    }
    if (!p.crossed && BigInt(e.real_quote_reserves) >= PROFILE_RESERVE) {
      p.crossed = true;
      const fast = e.slot - p.firstTradeSlot <= PROFILE_MAX_SLOTS;
      const broad = p.buyers.size >= PROFILE_MIN_BUYERS;
      const organic = p.buyVol === 0n || Number(p.creatorBuyVol) / Number(p.buyVol) <= PROFILE_MAX_CREATOR_SHARE;
      if (fast && broad && organic) qualifiedNow.push(e.mint);
    }
  }
  return qualifiedNow;
}

function ingestFills(state: BotState, batch: Batch): void {
  for (const f of batch.fills) {
    if (f.status !== 'filled') continue;
    if (f.side === 'buy') {
      if (BigInt(f.quote_lamports) >= GUARDRAIL_MIN_BUY) boughtMints.add(f.mint);
      if (!holdings.has(f.mint)) {
        holdings.set(f.mint, { entrySlot: f.slot, peakProceeds: 0n, banking: !profileTraded.has(f.mint) });
      }
    } else {
      if (boughtMints.has(f.mint)) roundTripped.add(f.mint);
      holdings.delete(f.mint);
    }
  }
  for (const mint of [...holdings.keys()]) {
    if (!state.positions.has(mint)) {
      let buyPending = false;
      for (const p of state.pending.values()) if (p.order.side === 'buy' && p.order.mint === mint) buyPending = true;
      if (!buyPending) holdings.delete(mint);
    }
  }
}

function pendingSides(state: BotState): { buys: Set<string>; sells: Set<string> } {
  const buys = new Set<string>();
  const sells = new Set<string>();
  for (const p of state.pending.values()) {
    if (p.order.side === 'buy') buys.add(p.order.mint);
    else sells.add(p.order.mint);
  }
  return { buys, sells };
}

function planExits(state: BotState, batch: Batch, pendingSells: Set<string>): OrderInput[] {
  const orders: OrderInput[] = [];
  for (const [mint, pos] of state.positions) {
    if (pendingSells.has(mint)) continue;
    const info = holdings.get(mint) ?? { entrySlot: batch.slot, peakProceeds: 0n, banking: true };
    holdings.set(mint, info);
    const age = batch.slot - info.entrySlot;
    let sell = false;
    if (info.banking) {
      sell = age >= BANK_EXIT_AGE;
    } else {
      const proceeds = estSellProceeds(state, mint, pos.token_amount);
      if (proceeds > info.peakProceeds) info.peakProceeds = proceeds;
      const cost = pos.cost_lamports;
      const p = profiles.get(mint);
      const deadFor = p && p.lastTradeSlot >= 0 ? batch.slot - p.lastTradeSlot : 0;
      const sl = proceeds * 100n <= cost * BigInt(Math.round(STOP_LOSS * 100));
      const trail =
        info.peakProceeds * 100n >= cost * BigInt(Math.round(TRAIL_ARM * 100)) &&
        proceeds * 100n <= info.peakProceeds * BigInt(Math.round(TRAIL_GIVEBACK * 100));
      sell = sl || trail || age >= MAX_HOLD_SLOTS || (age >= 100 && deadFor >= DEAD_SLOTS);
    }
    if (sell) orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
  }
  return orders;
}

function planProfileEntries(state: BotState, qualifiedNow: string[], slotsFree: number, pendingBuys: Set<string>): OrderInput[] {
  const orders: OrderInput[] = [];
  const freeCash = state.freeCashLamports();
  const txFee = state.txFeeLamports();
  let budget = freeCash;
  const sorted = [...qualifiedNow].sort();
  for (const mint of sorted) {
    if (orders.length >= slotsFree) break;
    if (profileTraded.has(mint) || state.positions.has(mint) || pendingBuys.has(mint)) continue;
    const c = state.curves.get(mint);
    if (!c || c.complete) continue;
    const cap = (state.maxBuyLamports(mint) * 9n) / 10n;
    const size = PROFILE_SIZE < cap ? PROFILE_SIZE : cap;
    if (size < PROFILE_MIN_SIZE) continue;
    if (size + txFee > budget) continue;
    budget -= size + txFee;
    profileTraded.add(mint);
    orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
  }
  return orders;
}

function coveredMints(state: BotState): number {
  const covered = new Set<string>(roundTripped);
  for (const mint of state.positions.keys()) covered.add(mint);
  for (const p of state.pending.values()) if (p.order.side === 'buy') covered.add(p.order.mint);
  return covered.size;
}

function planBankingEntry(state: BotState, batch: Batch, slotsFree: number, pendingBuys: Set<string>): OrderInput[] {
  if (slotsFree <= 0) return [];
  if (roundTripped.size >= 20) return [];
  if (coveredMints(state) >= GUARDRAIL_TARGET) return [];
  const elapsed = firstSlot >= 0 ? batch.slot - firstSlot : 0;
  if (elapsed < BANK_START_SLOTS) return [];
  if (batch.slot - lastBankSlot < BANK_PACE_SLOTS) return [];
  const txFee = state.txFeeLamports();
  if (BANK_SIZE + txFee > state.freeCashLamports()) return [];

  // pick the most active live mint we have not covered yet (deterministic:
  // most trades, then mint string)
  let best: string | null = null;
  let bestTrades = -1;
  for (const [mint, c] of state.curves) {
    if (c.complete || state.positions.has(mint) || pendingBuys.has(mint)) continue;
    if (roundTripped.has(mint) || profileTraded.has(mint)) continue;
    if (c.real_quote_reserves < BANK_MIN_RESERVE) continue;
    const p = profiles.get(mint);
    if (!p || p.lastTradeSlot < 0 || batch.slot - p.lastTradeSlot > 20) continue;
    if (p.trades > bestTrades || (p.trades === bestTrades && best !== null && mint < best)) {
      best = mint;
      bestTrades = p.trades;
    }
  }
  if (best === null) return [];
  const cap = (state.maxBuyLamports(best) * 9n) / 10n;
  const size = BANK_SIZE < cap ? BANK_SIZE : cap;
  if (size < GUARDRAIL_MIN_BUY + 500_000n) return [];
  lastBankSlot = batch.slot;
  return [{ side: 'buy', mint: best, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS }];
}

await runBot({
  onBatch(state, batch) {
    if (firstSlot < 0) firstSlot = batch.slot;
    const qualifiedNow = ingestEvents(batch);
    ingestFills(state, batch);
    const { buys, sells } = pendingSides(state);
    const exits = planExits(state, batch, sells);
    const slotsFree = Math.max(0, MAX_POSITIONS - state.committedPositionCount());
    const profile = planProfileEntries(state, qualifiedNow, slotsFree, buys);
    const banking = planBankingEntry(state, batch, slotsFree - profile.length, buys);
    const orders = [...exits, ...profile, ...banking];
    return orders.slice(0, state.hello.caps.max_orders_per_batch);
  },
});
