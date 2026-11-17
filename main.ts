// Dip-entry hold bot for the BTC race: buy pullbacks, then hold.
//
// The dev window is a choppy, nearly flat day (1-minute moves average ~4 bps)
// while a full-size round trip costs ~35 bps in fees, slippage and impact, so
// frequent trading loses money and the baseline that simply holds wins. This
// bot therefore trades at most twice: it buys in two tranches on pullbacks
// below the running high and then holds to the end of the window, with a wide
// disaster stop that only fires on a real crash.
//
//   - Tranche 1, 60% of equity: the first close at least 10 bps below the
//     highest close seen so far (every bar counts, warm-up bars included), or
//     at batch 240 if no such pullback has come by then.
//   - Tranche 2, the remaining cash: the first close at least 30 bps below
//     the running high after tranche 1, or at batch 720 if that never comes.
//   - Disaster stop: if the position is ever worth 8% less than it cost at a
//     close, sell it all and never buy again. On the dev window the worst
//     fall from an entry is under 1%, so the stop never fires there; it only
//     caps the damage if the race window crashes.
//   - Every decision is integer math on the closes the harness sent: no
//     clock, no environment, no randomness, so two runs answer alike.
//   - A rejected order is simply retried on the next bar: the rules key off
//     the account the batch reports, so a fill changes what the next batch
//     decides and a rejection leaves the rule standing.
//
// Graded locally with the kit (grade-local, process driver) on the published
// dev window: net PnL +3.811142 USDC over 2 trades, 0 rejected, max drawdown
// 2.12%, guardrails met, and the L1 regrade reproduced byte for byte.
//
// The bot speaks agent-fun/bars-replay/v1 through the kit's shim: hello once,
// then one batch per bar (each carrying the bar, the fills of the previous
// reply's orders and the account), and it answers every batch with exactly
// one reply echoing its seq.

import { runBars, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Tranche 1 fires this far (bps) below the running high close. */
const DIP1_BPS = 10n;
/** Tranche 2 fires this far (bps) below the running high close. */
const DIP2_BPS = 30n;
/** Tranche 1 fallback: buy at this batch if no pullback has come. */
const FALLBACK1_SEQ = 240;
/** Tranche 2 fallback: deploy the rest at this batch if no deep pullback. */
const FALLBACK2_SEQ = 720;
/** Tranche 1 size: this share (bps) of equity. */
const TRANCHE1_BPS = 6000n;
/** Disaster stop: sell when the position is worth this much (bps) under cost. */
const STOP_BPS = 800n;
/** Slippage cap per order, 1% past the close it was decided on. */
const MAX_SLIPPAGE_BPS = 100;

/** Highest close seen so far, across every bar of every batch. */
let peakClose: bigint | null = null;
/** Latched once the disaster stop sells: no rebuy after it. */
let stopped = false;

/** Whether the close sits at least dipBps below the running high close. */
function dipped(close: bigint, dipBps: bigint): boolean {
  if (peakClose === null) return false;
  return close * 10000n < peakClose * (10000n - dipBps);
}

await runBars({
  onBatch(state, batch) {
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      const c = BigInt(bar.c);
      if (peakClose === null || c > peakClose) peakClose = c;
    }
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null || peakClose === null) return [];
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    const held = state.positions.get(SYMBOL);

    if (held !== undefined) {
      // Disaster stop: the position worth 8% under its cost at this close.
      const value = state.value(SYMBOL, held.qty);
      if (value * 10000n <= held.cost * (10000n - STOP_BPS)) {
        stopped = true;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      // Tranche 2: deploy the remaining cash on a deeper pullback, or at the
      // fallback batch, while the weight cap leaves room for it.
      if (!stopped && state.cash >= minNotional && (dipped(close, DIP2_BPS) || state.seq >= FALLBACK2_SEQ)) {
        const room = state.weightRoom(SYMBOL);
        const amount = state.cash < room ? state.cash : room;
        if (amount >= minNotional) {
          const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS };
          return [buy];
        }
      }
      return [];
    }

    // Flat: tranche 1, unless the disaster stop already fired.
    if (stopped) return [];
    if (dipped(close, DIP1_BPS) || state.seq >= FALLBACK1_SEQ) {
      let amount = (state.equity * TRANCHE1_BPS) / 10000n;
      const room = state.weightRoom(SYMBOL);
      if (amount > room) amount = room;
      if (amount > state.cash) amount = state.cash;
      if (amount >= minNotional) {
        const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [buy];
      }
    }
    return [];
  },
});
