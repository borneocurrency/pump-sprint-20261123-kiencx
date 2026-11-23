// Launch-surge bot for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea, in one paragraph: on pump.fun almost every coin dies, but a small share of launches
// explode in their very first slot. The opening tape of that slot tells you which ones: many
// distinct buyers piling in at once, several trades, and a price that has already run up hard
// from the create price. This bot only ever buys in a coin's create slot, and only when that
// opening tape is hot. It then takes profit fast, cuts losers fast, and never holds longer than
// a few dozen slots, because the peak of a launch spike is usually only seconds away and the
// retrace that follows is brutal. A second, smaller set of tiers buys cooler launches at a
// small stake so the run still clears the 20-coin guardrail in a short window; those tiers
// never add and never chase.
//
// Rules the bot lives by (written down before any tuning, and never broken for a hunch):
//  1. One shot per coin, in its create slot only. A coin that does not qualify at birth is
//     never bought later; chasing a run-up after the fact is how money dies here.
//  2. Buy the tape, not the story: distinct buyers, trade count, run-up and creator behaviour
//     are all measured from the replayed events, never assumed.
//  3. Every position has a take-profit, a stop-loss and a maximum hold before it is opened.
//  4. Fees are real: a buy and a sell together cost about 2.5% of the stake in curve fees plus
//     two transaction fees, so no order is ever split into pieces and no stake is so small
//     that the transaction fee eats the trade.
//  5. Determinism is a hard requirement: every decision is a pure function of the batches the
//     replay feeds the bot. No clock, no randomness, no network, no environment reads. The
//     same batches always produce the same orders, in the same order.
//
// The words below are used the way the harness uses them: the hello message opens the run,
// each batch carries one slot of events, and the bot answers that batch with its orders for
// that slot. The batch stream is the bot's whole world: nothing is read from anywhere else.

import { BPS, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/agentfun-bot.ts';

/** One entry tier: how hot the opening tape must be, and how the trade is run. */
interface Tier {
  /** Human-readable tier name (logs only, never sent anywhere). */
  name: string;
  /** Trades seen in the create slot, at least. */
  minTrades: number;
  /** Distinct non-creator buyers seen in the create slot, at least. */
  minBuyers: number;
  /** Price now over create price, in bps (10000 = 1.00x), at least. */
  minRunupBps: number;
  /** Same ratio, below this (exclusive): tiers are checked top-down, so this bounds a tier. */
  maxRunupBps: number;
  /** Lamports to aim for in the first buy (the 1%-of-real-reserve cap still applies). */
  stakeLamports: number;
  /** Extra buys after the first one, each on a later batch, while the coin keeps rising. */
  adds: number;
  /** Lamports per extra buy. */
  addLamports: number;
  /** Exit once the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit once it is worth this much under its cost (bps). */
  slBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
}

interface Params {
  /** Tiers in priority order: the first tier a coin qualifies for is the one it trades on. */
  tiers: Tier[];
  /** Creator's own buys in the create slot: lamports, at most. */
  maxDevBuyLamports: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSolLamports: number;
  maxRealSolLamports: number;
  /** Skip a coin when its creator has sold before entry. */
  skipDevSold: boolean;
  /** Smallest single buy worth paying the transaction fee for (lamports). */
  minBuyLamports: number;
  /** Slippage allowed on buys (bps); sells always go out at 10000. */
  buySlippageBps: number;
  /** Slots to wait after one buy before an add may be decided. */
  addDelay: number;
  /** Exit when the creator sells while a position is held. */
  exitOnDevSell: boolean;
  /** Most open positions the cooler tiers may occupy (the rest stays free for the hot tier). */
  maxLowerTierPositions: number;
}

// Settings traded with. Every number below was chosen by sweeping the local simulator on the
// dev window and keeping the setting that won in BOTH halves of the window, not just on the
// whole: a setting that wins only in one half is a fluke, not an edge.
const PARAMS: Params = {
  tiers: [
    {
      name: 'hot',
      minTrades: 7,
      minBuyers: 5,
      minRunupBps: 18000,
      maxRunupBps: 1_000_000,
      stakeLamports: 100_000_000,
      adds: 2,
      addLamports: 200_000_000,
      tpBps: 1500,
      slBps: 1200,
      maxHold: 40,
    },
    {
      name: 'warm',
      minTrades: 5,
      minBuyers: 5,
      minRunupBps: 15000,
      maxRunupBps: 18000,
      stakeLamports: 20_000_000,
      adds: 0,
      addLamports: 0,
      tpBps: 1000,
      slBps: 800,
      maxHold: 20,
    },
    {
      name: 'lukewarm',
      minTrades: 5,
      minBuyers: 5,
      minRunupBps: 13000,
      maxRunupBps: 15000,
      stakeLamports: 20_000_000,
      adds: 0,
      addLamports: 0,
      tpBps: 1000,
      slBps: 800,
      maxHold: 20,
    },
    {
      name: 'cool',
      minTrades: 5,
      minBuyers: 5,
      minRunupBps: 11000,
      maxRunupBps: 13000,
      stakeLamports: 20_000_000,
      adds: 0,
      addLamports: 0,
      tpBps: 1000,
      slBps: 800,
      maxHold: 20,
    },
  ],
  maxDevBuyLamports: 1_000_000_000,
  minRealSolLamports: 300_000_000,
  maxRealSolLamports: 30_000_000_000,
  skipDevSold: true,
  minBuyLamports: 10_000_000,
  buySlippageBps: 10_000,
  addDelay: 2,
  exitOnDevSell: true,
  maxLowerTierPositions: 4,
};

const FEE_BPS = 125n;

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time reserves: the run-up is measured against this price. */
  vq0: bigint;
  vt0: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  /** The creator's own buys in the create slot, in lamports. */
  devBuy: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  /** Trades of the last few slots, for the recent-flow read on adds. */
  recent: { slot: number; isBuy: boolean; sol: bigint }[];
  /** Never buy it again (entered then exited, or filtered out for good). */
  done: boolean;
  complete: boolean;
  /** Tier index this coin traded on, -1 when it never qualified. */
  tier: number;
  buysSent: number;
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  lastBuySlot: number;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  devSoldAtOpen: boolean;
  tier: number;
}

/** What selling `tokens` against (vq, vt) would pay after the 1.25% curve fee. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

/** Net lamports bought minus sold over the last `w` slots (older trades dropped). */
function flow(c: Coin, slot: number, w: number): bigint {
  const from = slot - w;
  let drop = 0;
  while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
  if (drop > 0) c.recent.splice(0, drop);
  let net = 0n;
  for (const t of c.recent) net += t.isBuy ? t.sol : -t.sol;
  return net;
}

/** Price now over create price, in bps (10000 = 1.00x). */
function runupBps(c: Coin, vq: bigint, vt: bigint): bigint {
  if (c.vq0 <= 0n || c.vt0 <= 0n || vt <= 0n) return 0n;
  return (vq * c.vt0 * BPS) / (vt * c.vq0);
}

/** First tier whose opening-tape conditions this coin meets, or -1. */
function pickTier(c: Coin, vq: bigint, vt: bigint): number {
  const runup = runupBps(c, vq, vt);
  for (let i = 0; i < PARAMS.tiers.length; i++) {
    const t = PARAMS.tiers[i]!;
    if (c.trades < t.minTrades) continue;
    if (c.buyers.size < t.minBuyers) continue;
    if (runup < BigInt(t.minRunupBps) || runup >= BigInt(t.maxRunupBps)) continue;
    return i;
  }
  return -1;
}

const coins = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();
/** Mints with a sell in flight. */
const selling = new Set<Pubkey>();

function readEvents(batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      coins.set(e.mint, {
        mint: e.mint,
        createSlot: e.slot,
        creator: e.creator,
        vq0: BigInt(e.virtual_quote_reserves),
        vt0: BigInt(e.virtual_token_reserves),
        trades: 0,
        buyers: new Set(),
        devBuy: 0n,
        devSold: false,
        lastTradeSlot: e.slot,
        recent: [],
        done: false,
        complete: false,
        tier: -1,
        buysSent: 0,
        lastBuyVq: 0n,
        lastBuyVt: 1n,
        lastBuySlot: 0,
      });
    } else if (e.event === 'TradeEvent') {
      const c = coins.get(e.mint);
      if (c === undefined) continue;
      const sol = BigInt(e.sol_amount);
      c.trades += 1;
      c.lastTradeSlot = e.slot;
      c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol });
      const isDev = e.user === c.creator;
      if (e.is_buy) {
        if (isDev && e.slot === c.createSlot) c.devBuy += sol;
        else if (!isDev) c.buyers.add(e.user);
      } else if (isDev) {
        c.devSold = true;
      }
    } else {
      const c = coins.get(e.mint);
      if (c !== undefined) {
        c.complete = true;
        c.done = true;
      }
    }
  }
}

function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
  for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
  return false;
}

function hasPendingSell(state: BotState, mint: Pubkey): boolean {
  for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
  return false;
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  readEvents(batch);
  const orders: OrderInput[] = [];
  const cap = state.hello.caps.max_orders_per_batch;
  const tx = state.txFeeLamports();
  const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
  for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

  // Fold in what resolved since the last batch: harness closes end a position, a filled
  // buy opens one, and every resolved order adds its transaction fee to the position's cost.
  for (const f of batch.fills) {
    if (f.client_id.startsWith('_')) {
      held.delete(f.mint);
      selling.delete(f.mint);
      continue;
    }
    const h = held.get(f.mint);
    if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
    if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
      const c = coins.get(f.mint);
      held.set(f.mint, {
        openedSlot: f.slot,
        txPaid: BigInt(f.tx_fee_lamports),
        devSoldAtOpen: c?.devSold ?? false,
        tier: c?.tier ?? -1,
      });
    }
  }
  for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
  for (const mint of [...held.keys()]) {
    if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
  }

  // Exits first: a position leaves whole, in one order, on the first of its take-profit,
  // its stop-loss, its maximum hold, or its creator selling.
  for (const [mint, pos] of state.positions) {
    if (orders.length >= cap) break;
    if (selling.has(mint)) continue;
    const c = coins.get(mint);
    let h = held.get(mint);
    if (h === undefined) {
      h = { openedSlot: state.slot, txPaid: tx, devSoldAtOpen: c?.devSold ?? false, tier: c?.tier ?? -1 };
      held.set(mint, h);
    }
    const tier = PARAMS.tiers[h.tier] ?? PARAMS.tiers[0]!;
    let mk = marks.get(mint);
    if (mk === undefined) {
      const cv = state.curves.get(mint);
      if (cv === undefined) continue;
      mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
    }
    const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
    const basis = pos.cost_lamports + h.txPaid;
    let exit = false;
    if (basis > 0n) {
      if (value * BPS >= basis * (BPS + BigInt(tier.tpBps))) exit = true;
      else if (value * BPS <= basis * (BPS - BigInt(tier.slBps))) exit = true;
    }
    if (state.slot - h.openedSlot >= tier.maxHold) exit = true;
    if (c !== undefined && PARAMS.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
    if (!exit) continue;
    orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    selling.add(mint);
    if (c !== undefined) c.done = true;
  }

  // Adds next: only the hot tier pyramids, and only into strength — the price must not
  // have fallen below the last buy's decision price, the recent flow must still show
  // buyers in charge, and at least addDelay slots must have passed since that buy was
  // decided. Once an exit was decided on a coin it is done: a buy that lands after the
  // exit decision leaves tokens behind, but those are sold off, never added to.
  let free = state.freeCashLamports() - tx * BigInt(orders.length);
  for (const [mint, pos] of state.positions) {
    if (orders.length >= cap) break;
    if (selling.has(mint) || hasPendingBuy(state, mint)) continue;
    const c = coins.get(mint);
    if (c === undefined || c.done || c.tier < 0) continue;
    const tier = PARAMS.tiers[c.tier]!;
    if (tier.adds <= 0 || c.buysSent - 1 >= tier.adds) continue;
    if (held.get(mint) === undefined) continue;
    if (state.slot - c.lastBuySlot < PARAMS.addDelay) continue;
    if (flow(c, state.slot, 10) < 0n) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const vq = curve.virtual_quote_reserves;
    const vt = curve.virtual_token_reserves;
    if (vq * c.lastBuyVt < c.lastBuyVq * vt) continue;
    const maxAdd = state.maxBuyLamports(mint);
    const want = BigInt(tier.addLamports);
    const amount = want < maxAdd ? want : maxAdd;
    if (amount < BigInt(PARAMS.minBuyLamports) || free < amount + tx) continue;
    orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: PARAMS.buySlippageBps });
    free -= amount + tx;
    c.buysSent += 1;
    c.lastBuyVq = vq;
    c.lastBuyVt = vt;
    c.lastBuySlot = state.slot;
  }

  // Entries last: only coins born in this very slot are considered, and each coin gets
  // exactly one decision. The cooler tiers may not fill the book: slots are kept free
  // for the hot tier, which is where the money is.
  let open = state.committedPositionCount();
  for (const c of coins.values()) {
    if (orders.length >= cap) break;
    if (c.done || c.complete) continue;
    if (state.slot !== c.createSlot) {
      // Past its birth slot: a coin that was never bought never will be. A bought coin
      // stays eligible for adds, so it is never marked done here.
      if (c.buysSent === 0) c.done = true;
      continue;
    }
    const curve = state.curves.get(c.mint);
    if (curve === undefined || curve.complete) {
      c.done = true;
      continue;
    }
    if (c.devSold && PARAMS.skipDevSold) {
      c.done = true;
      continue;
    }
    if (c.devBuy > BigInt(PARAMS.maxDevBuyLamports)) {
      c.done = true;
      continue;
    }
    const rq = curve.real_quote_reserves;
    if (rq < BigInt(PARAMS.minRealSolLamports) || rq > BigInt(PARAMS.maxRealSolLamports)) {
      c.done = true;
      continue;
    }
    const tierIdx = pickTier(c, curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (tierIdx < 0) {
      c.done = true;
      continue;
    }
    const tier = PARAMS.tiers[tierIdx]!;
    const isHot = tierIdx === 0;
    if (open >= state.hello.caps.max_open_positions) {
      c.done = true;
      continue;
    }
    if (!isHot && open >= PARAMS.maxLowerTierPositions) continue;
    const maxBuy = state.maxBuyLamports(c.mint);
    const want = BigInt(tier.stakeLamports);
    const amount = want < maxBuy ? want : maxBuy;
    if (amount < BigInt(PARAMS.minBuyLamports) || free < amount + tx) {
      c.done = true;
      continue;
    }
    orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: PARAMS.buySlippageBps });
    free -= amount + tx;
    c.buysSent = 1;
    c.tier = tierIdx;
    c.lastBuyVq = curve.virtual_quote_reserves;
    c.lastBuyVt = curve.virtual_token_reserves;
    c.lastBuySlot = state.slot;
    // Deliberately NOT marked done: the coin stays eligible for adds while held.
    // The birth-slot check above is what stops a second first buy.
    open += 1;
  }
  return orders;
}

await runBot({ onBatch });
