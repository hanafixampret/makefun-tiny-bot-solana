// Tiny Bot: dual-signal long-only trader for agent-fun/bars-replay/v1.
//
// Two independent entry signals, one shared risk frame:
//   - dip:   buy when a symbol's close sits 3.5% below its 24-bar average (mean reversion);
//            exit when the close reverts to that average.
//   - trend: buy when the 6-bar average is above the 24-bar average and the close is
//            within 0.5% of the 6-bar average (pullback inside an uptrend);
//            exit when the 6-bar average falls back below the 24-bar average.
// Every position also exits on a 4% stop-loss or a 6% take-profit measured from the
// close of the bar the buy was decided on. At most 5 positions, 15% of equity each
// (25% weight cap respected). When several symbols signal at once, the strongest
// signals go first: deepest dip, then strongest trend (ranked by exact bigint
// fractions, never floats), so a market-wide dip buys the most oversold names
// instead of the first names in the universe. The bot stays mostly in cash in a
// falling market and still clears the 8-trade guardrail in a quiet one.
//
// Determinism: all decisions use exact bigint arithmetic on the closes (no floats,
// no clock, no environment, no randomness), so two executions produce identical
// action logs. The hello message opens the run, each batch of bars yields at most
// one reply of orders, and a sell's proceeds never fund a buy in the same reply.

import { BPS, runBars, type BarsState, type BuyInput, type OrderInput } from './vendor/makefun-bars.ts';

const FAST_BARS = 6;
const SLOW_BARS = 24;
const DIP_BPS = 350; // 3.5% below the slow average
const PULLBACK_BPS = 50; // within 0.5% of the fast average
const STOP_BPS = 400; // -4% from the entry close
const TAKE_BPS = 600; // +6% from the entry close
const SIZE_BPS = 1500; // 15% of equity per position
const MAX_POSITIONS = 5;
const MAX_SLIPPAGE_BPS = 500;

/** Each universe symbol's close as of every batch so far, indexed by seq. */
const history = new Map<string, bigint[]>();
/** The close of the bar on which each held position's buy was decided. */
const entryClose = new Map<string, bigint>();
/** Which signal opened each held position ('dip' or 'trend'); the SDK's own
 *  position records carry no mode, so the bot tracks it itself. */
const positionMode = new Map<string, 'dip' | 'trend'>();

/** Sum of the last n closes ending at seq, or null when fewer than n bars exist. */
function sumLast(closes: bigint[], seq: number, n: number): bigint | null {
  if (seq < n - 1 || closes.length <= seq) return null;
  let total = 0n;
  for (let i = seq - n + 1; i <= seq; i++) total += closes[i]!;
  return total;
}

function equityOf(state: BarsState): bigint {
  return state.equity;
}

function exits(state: BarsState): OrderInput[] {
  const orders: OrderInput[] = [];
  for (const [symbol, held] of state.positions) {
    const closes = history.get(symbol);
    const close = state.close(symbol);
    const entry = entryClose.get(symbol);
    if (closes === undefined || close === null || entry === undefined) continue;
    const fastSum = sumLast(closes, state.seq, FAST_BARS);
    const slowSum = sumLast(closes, state.seq, SLOW_BARS);
    if (fastSum === null || slowSum === null) continue;
    // Stop-loss: close <= entry * (1 - 4%)  <=>  close * 25 <= entry * 24.
    // Take-profit: close >= entry * (1 + 6%)  <=>  close * 50 >= entry * 53.
    if (close * 25n <= entry * 24n || close * 50n >= entry * 53n) {
      orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      continue;
    }
    if (positionMode.get(symbol) === 'trend') {
      // Trend positions leave when the fast average falls below the slow one:
      // fastSum / 6 < slowSum / 24  <=>  fastSum * 4 < slowSum.
      if (fastSum * 4n < slowSum) {
        orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    } else {
      // Dip positions leave when the close reverts to the slow average:
      // close >= slowSum / 24  <=>  close * 24 >= slowSum.
      if (close * BigInt(SLOW_BARS) >= slowSum) {
        orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }
  }
  return orders;
}

function entries(state: BarsState): BuyInput[] {
  const orders: BuyInput[] = [];
  const { caps, fees } = state.hello;
  const equity = equityOf(state);
  const slots = Math.min(MAX_POSITIONS, caps.max_open_positions) - state.positions.size;
  if (slots <= 0) return orders;
  // Collect every signalling symbol with its strength as an exact fraction
  // num/den, then rank strongest first. Dip strength is how far the close sits
  // below the slow average: (slowSum - 24 * close) / slowSum. Trend strength is
  // how far the fast average sits above the slow one: (4 * fastSum - slowSum) /
  // slowSum. Both share den = slowSum, so ranking is exact cross-multiplication
  // with bigints; the stable sort keeps universe order on ties.
  type Candidate = { symbol: string; mode: 'dip' | 'trend'; num: bigint; den: bigint };
  const candidates: Candidate[] = [];
  for (const { symbol } of state.hello.symbols) {
    if (state.positions.has(symbol)) continue;
    const closes = history.get(symbol);
    const close = state.close(symbol);
    if (closes === undefined || close === null) continue;
    const fastSum = sumLast(closes, state.seq, FAST_BARS);
    const slowSum = sumLast(closes, state.seq, SLOW_BARS);
    if (fastSum === null || slowSum === null) continue;
    // Trend up: fastSum / 6 > slowSum / 24  <=>  fastSum * 4 > slowSum.
    const trending = fastSum * 4n > slowSum;
    // Dip: close < slow average * (1 - 3.5%)  <=>  close * 4800 < slowSum * 193.
    const dipped = close * 4800n < slowSum * 193n;
    // Pullback: close <= fast average * (1 + 0.5%)  <=>  close * 6000 <= fastSum * 1005.
    const pulledBack = close * 6000n <= fastSum * 1005n;
    if (dipped) candidates.push({ symbol, mode: 'dip', num: slowSum - close * 24n, den: slowSum });
    else if (trending && pulledBack) candidates.push({ symbol, mode: 'trend', num: fastSum * 4n - slowSum, den: slowSum });
  }
  candidates.sort((a, b) => {
    const left = a.num * b.den;
    const right = b.num * a.den;
    if (left > right) return -1;
    if (left < right) return 1;
    return 0;
  });
  for (const { symbol, mode } of candidates) {
    if (orders.length >= slots) break;
    const close = state.close(symbol);
    if (close === null) continue;
    const bySize = (BigInt(SIZE_BPS) * equity) / BPS;
    const byWeight = state.weightRoom(symbol);
    const notional = bySize < byWeight ? bySize : byWeight;
    if (notional === 0n || notional < BigInt(fees.min_notional_quote_units)) continue;
    if (notional > state.cash) continue;
    entryClose.set(symbol, close);
    positionMode.set(symbol, mode);
    orders.push({ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
  }
  return orders;
}

await runBars({
  onBatch(state, batch) {
    for (const { symbol } of state.hello.symbols) {
      const closes = history.get(symbol) ?? [];
      const close = state.close(symbol);
      // A symbol with no bar on this batch keeps its last close: carry it
      // forward so the averages stay aligned to seq instead of swallowing a 0.
      closes.push(close ?? closes[closes.length - 1] ?? 0n);
      history.set(symbol, closes);
      if (!state.positions.has(symbol)) {
        entryClose.delete(symbol);
        positionMode.delete(symbol);
      }
    }
    // Warm-up batches build history only: orders decided on them are rejected.
    if (state.warmingUp) return [];
    const sells = exits(state);
    if (sells.length > 0) return sells;
    return entries(state);
  },
});
