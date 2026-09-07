/*
 * PegEngine — how much would it cost to make ZIG track BTC?
 *
 * Inputs are 100% real MEXC websocket data:
 *   - real ZIG trades (size + side)  -> the order flow hitting the market
 *   - real BTC price                 -> the shape we want ZIG to follow
 *
 * Model:
 *   Simulated ZIG log-price moves with signed order flow (Kyle's lambda):
 *
 *       d ln P  =  lambda * q_signed
 *
 *   lambda is calibrated from REAL ZIG candles: the median of
 *   ln(high/low) / volume tells you how far this market actually moves
 *   per unit of volume traded. That is the market's real elasticity.
 *
 *   Target (the BTC-implied price, anchored at load):
 *
 *       T(t) = anchorZig * BTC(t) / anchorBtc
 *
 *   Each tick a peg-keeper bot trades whatever size closes the gap:
 *
 *       e   = ln T - ln P
 *       q*  = gain * e / lambda        (exact fill would be gain = 1)
 *
 *   capped by (a) participation vs real volume, (b) cash on hand for buys,
 *   (c) inventory on hand for sells (spot: you cannot sell what you don't own).
 *
 * Output: the running cost of holding that peg, and a verdict on whether
 * to keep funding it.
 */
'use strict';

const DEFAULTS = {
  capitalUSDT: 100000,     // starting capital
  splitToInventory: 0.5,   // half held as ZIG so the bot can also sell
  gain: 0.6,               // control gain, (0..1]. 1 = close the whole gap each tick
  maxParticipation: 0.6,   // bot size cap as a fraction of real ZIG volume rate
  minNotionalUSDT: 5,      // smallest clip it can work, so a dead market still moves
  feeBps: 5,               // 0.05% taker
  tickMs: 100,             // controller cadence (matches MEXC aggre-deals 100ms)
  impactCoef: 0.5,         // range covers a round trip, so halve it
  targetRunwayMin: 60,     // runway we want to fund
  windowSec: 60,           // rolling window for flow / burn stats
  maxBars: 20000,          // 1m sim bars kept (~14 days)
  maxResumeGapMin: 2,      // down longer than this -> re-anchor to the live market
                           // (a quick restart stays continuous and chases the gap)

  // --- two-wallet wash trading, for measuring how it distorts the tape ------
  washEnabled: false,      // off unless you turn it on
  washRatePerSec: 2,       // matched A<->B trades per second
  washClipUSDT: 25,        // notional per wash trade
  washJitter: 0.4,         // +/- size randomisation
  detectWindowSec: 300,    // window for the volume/impact detector
  forensicsEnabled: true,  // off for batch runs -- the tail fit sorts the tape
  forensicsMs: 2000,       // min gap between forensic passes

  // --- how the target follows BTC ------------------------------------------
  // 'absolute' chases BTC's level from a fixed anchor. The gap it can open is
  //            unbounded, so on a thin book it loses the peg and never recovers.
  // 'slew'     rate-limits the target to what the market can actually deliver.
  //            Same direction and turning points as BTC, amplitude compressed.
  // 'rolling'  re-anchors every rollingWindowSec, so the sim tracks BTC's
  //            short-horizon returns and never inherits an old gap.
  // 'beta'     scales BTC's log move by trackBeta (<1) — deliberately smaller
  //            amplitude, same shape.
  trackMode: 'absolute',
  trackBeta: 0.5,
  rollingWindowSec: 300,
  slewHeadroom: 0.7,       // leave capacity to also absorb adverse real flow

  // Pure feedback always lags: it waits for an error to appear before acting,
  // and lag is what destroys return correlation. Feedforward trades the
  // target's own move the moment it happens, so feedback only has to clean up
  // the residual. 1.0 = fully anticipate the target, 0 = the old behaviour.
  feedforward: 0,
};

function median(a){
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// --------------------------------------------------------------------------
// Forensic tests from the wash-trading literature.
// Cong, Li, Tang & Yang, "Crypto Wash Trading" (NBER w30783) establish the
// standard trio: first-digit conformity, trade-size roundness, and power-law
// tails. All three run on the public tape alone — no wallet identity needed.
// --------------------------------------------------------------------------

/** Leading significant digit of a positive number. */
function firstDigit(x){
  x = Math.abs(x);
  if (!(x > 0) || !isFinite(x)) return 0;
  while (x < 1) x *= 10;
  while (x >= 10) x /= 10;
  return Math.floor(x);
}

/**
 * Benford's law on first significant digits, scored by mean absolute deviation.
 * Nigrini's thresholds: <0.006 close conformity, <0.012 acceptable,
 * <0.015 marginal, above that nonconformity. Genuine multiplicative trading
 * processes conform; fabricated size distributions typically do not.
 */
function benford(sizes){
  const counts = new Array(10).fill(0);
  let n = 0;
  for (const s of sizes){
    const d = firstDigit(s);
    if (d >= 1 && d <= 9){ counts[d]++; n++; }
  }
  if (n < 300) return null;
  let mad = 0, chi2 = 0;
  const dist = [];
  for (let d = 1; d <= 9; d++){
    const obs = counts[d] / n;
    const exp = Math.log10(1 + 1 / d);
    mad += Math.abs(obs - exp);
    chi2 += Math.pow(counts[d] - n * exp, 2) / (n * exp);
    dist.push(obs);
  }
  mad /= 9;

  // Nigrini's MAD cut-offs were derived for large samples. At small n, sampling
  // noise alone inflates MAD -- real MEXC tape at n=201 scores "nonconforming"
  // for both ZIG and BTC. So expose the expected noise floor and only treat the
  // absolute verdict as meaningful once there is enough data for it.
  //   E|p_hat - p| ~ sqrt(2 p (1-p) / (pi n)) per digit, averaged over digits
  let noise = 0;
  for (let d = 1; d <= 9; d++){
    const p = Math.log10(1 + 1 / d);
    noise += Math.sqrt(2 * p * (1 - p) / (Math.PI * n));
  }
  noise /= 9;

  const reliable = n >= 1000;
  const excess = mad / noise;                 // 1.0 = indistinguishable from noise
  const verdict = !reliable ? 'insufficient data'
    : mad < 0.006 ? 'close' : mad < 0.012 ? 'acceptable'
    : mad < 0.015 ? 'marginal' : 'nonconforming';
  return { mad, n, dist, verdict, chi2, noiseFloor: noise, excess, reliable };
}

/**
 * Trade-size clustering on round numbers. Humans use round numbers as cognitive
 * reference points, so genuine tapes show a pronounced spike at 1/2/5 x 10^k.
 * An absence of that spike is itself suspicious.
 */
function roundness(sizes){
  let hit = 0, n = 0;
  for (const s of sizes){
    if (!(s > 0)) continue;
    n++;
    const k = Math.floor(Math.log10(s));
    for (const m of [1, 2, 5]){
      const ref = m * Math.pow(10, k);
      if (Math.abs(s - ref) / ref < 0.005){ hit++; break; }
    }
  }
  return n >= 50 ? hit / n : null;
}

/**
 * Hill estimator for the power-law tail exponent of trade sizes.
 * Real markets sit near alpha ~ 2-3; mechanically generated sizes do not.
 */
function hillAlpha(sizes, tailFrac = 0.1){
  const s = sizes.filter((x) => x > 0).sort((a, b) => b - a);
  if (s.length < 100) return null;
  const k = Math.max(20, Math.floor(s.length * tailFrac));
  if (k >= s.length) return null;
  const xk = s[k];
  if (!(xk > 0)) return null;
  let sum = 0;
  for (let i = 0; i < k; i++) sum += Math.log(s[i] / xk);
  return sum > 0 ? k / sum : null;
}

class PegEngine {
  constructor(cfg = {}){
    this.cfg = { ...DEFAULTS, ...cfg };
    this.reset();
  }

  reset(){
    this.ready = false;
    this.lambda = 0; this.volPerSec = 0;
    this.anchorZig = 0; this.anchorBtc = 0;
    this.lnP = 0; this.btcPrice = 0;
    this.cash = 0; this.inv = 0; this.equity0 = 0;
    this.fees = 0;
    this.botBought = 0; this.botSold = 0; this.botVolUSDT = 0; this.botTicks = 0;
    this.pendingBotQty = 0;
    this.pendingFlow = 0; this.pendingVol = 0;
    this.ofiWin = []; this.volWin = []; this.eqWin = []; this.errWin = [];
    this.ofiSum = 0; this.volSum = 0; this.buySum = 0; this.errSumSq = 0;
    this.lastStep = Date.now();
    this.startedAt = Date.now();
    this.runtimeMs = 0;      // accumulated across restarts
    this.resumed = false;
    this.bars1m = [];        // simulated 1m OHLC (+ target close), persisted chart history
    // whole-run tracking stats — this is what says how well it matched BTC
    this.track = { ticks: 0, sumSq: 0, maxAbs: 0, depthLimited: 0, starvedTicks: 0,
                   b10: 0, b25: 0, b50: 0, b100: 0, b250: 0 };

    // two wallets under one operator. Peg fills are split between them; wash
    // trades move value A<->B and change the combined position by exactly zero.
    this.wallets = [
      { id: 'A', cash: 0, inv: 0, fees: 0, fills: 0, washFills: 0 },
      { id: 'B', cash: 0, inv: 0, fees: 0, fills: 0, washFills: 0 },
    ];
    this.wash = {
      trades: 0, volUSDT: 0, volZIG: 0, fees: 0, carry: 0,
      realVolUSDT: 0,      // external flow + peg fills — the trades that moved price
      lastSide: 1,
    };
    // rolling window for the volume-vs-impact detector
    this.detWin = [];      // {t, absDlnP, qAll}
    this.lnPrev = null;
    this.lnTprev = null;

    // the public tape an outside analyst would see: every reported fill.
    // `src` is ground truth we happen to know because we generated it.
    this.tape = [];        // {q, src:'real'|'peg'|'wash', inv:bool}
    this.forensicCache = null;
    this.forensicAt = 0;
  }

  _tape(q, src, inverted){
    if (!(q > 0)) return;
    this.tape.push({ q, src, inv: !!inverted });
    if (this.tape.length > 6000) this.tape.splice(0, this.tape.length - 6000);
  }

  /**
   * Run the literature's forensic battery on the tape.
   *
   * Tier 1 (public data only) — Benford, roundness, power law, impact divergence.
   *   This is what a CEX analyst or anyone with just the trade feed can compute.
   * Tier 2 (identity required) — self-trade ratio, round-trip inversion rate.
   *   This is what an on-chain analyst with wallet labels can additionally see.
   *   Cong et al. find ~60% of NFT wash trading is exactly the two-account
   *   round-trip pattern this simulation generates.
   *
   * Cached — the sort in hillAlpha is not something to run at 10 Hz.
   */
  forensics(now){
    // hillAlpha sorts the whole tape, so this must never run per-tick
    if (!this.cfg.forensicsEnabled) return null;
    if (this.forensicCache && now - this.forensicAt < this.cfg.forensicsMs) return this.forensicCache;
    this.forensicAt = now;

    const all = this.tape.map((x) => x.q);
    const genuine = this.tape.filter((x) => x.src === 'real').map((x) => x.q);

    // round-trip inversion rate over consecutive identity-labelled fills
    let pairs = 0, inversions = 0;
    for (const x of this.tape){
      if (x.src !== 'wash') continue;
      pairs++;
      if (x.inv) inversions++;
    }

    const observed = {
      n: all.length,
      benford: benford(all),
      roundness: roundness(all),
      alpha: hillAlpha(all),
    };
    const baseline = {
      n: genuine.length,
      benford: benford(genuine),
      roundness: roundness(genuine),
      alpha: hillAlpha(genuine),
    };

    // Flags are RELATIVE — observed tape vs the genuine subset of the same tape.
    // That controls for sample size and for this market's own quirks, which
    // absolute thresholds do not.
    const flags = [];
    if (observed.benford && baseline.benford &&
        observed.benford.mad > baseline.benford.mad * 1.5 &&
        observed.benford.excess > 2) flags.push('benford');
    if (observed.roundness != null && baseline.roundness != null && baseline.roundness > 0.02 &&
        observed.roundness < baseline.roundness * 0.5) flags.push('roundness');
    if (observed.alpha != null && baseline.alpha != null &&
        Math.abs(observed.alpha - baseline.alpha) / baseline.alpha > 0.5) flags.push('powerlaw');

    this.forensicCache = {
      observed, baseline, flags,
      roundTripRate: pairs > 0 ? inversions / pairs : null,
      washFillsOnTape: pairs,
    };
    return this.forensicCache;
  }

  /** Combined book = the two wallets. Kept in sync so every existing metric works. */
  _sync(){
    this.cash = this.wallets[0].cash + this.wallets[1].cash;
    this.inv  = this.wallets[0].inv  + this.wallets[1].inv;
  }

  /** Everything needed to pick the run back up after a restart. */
  toJSON(){
    return {
      version: 1, savedAt: Date.now(),
      lnP: this.lnP, cash: this.cash, inv: this.inv, fees: this.fees,
      botBought: this.botBought, botSold: this.botSold,
      botVolUSDT: this.botVolUSDT, botTicks: this.botTicks,
      equity0: this.equity0, anchorZig: this.anchorZig, anchorBtc: this.anchorBtc,
      lambda: this.lambda, volPerSec: this.volPerSec,
      startedAt: this.startedAt, runtimeMs: this.runtimeMs + (Date.now() - this.startedAt),
      track: this.track,
      wallets: this.wallets, wash: this.wash,
      cfg: this.cfg,
    };
  }

  /**
   * Restore a saved run. Returns a note describing what happened, because the
   * interesting case is downtime: BTC kept moving while we were off, so either
   * the bot chases that gap or we re-anchor and let it go.
   */
  restore(s, nowBtcPrice){
    if (!s || s.version !== 1 || !Number.isFinite(s.lnP)) return null;
    this.cfg = { ...this.cfg, ...(s.cfg || {}) };
    this.lnP = s.lnP;
    if (Array.isArray(s.wallets) && s.wallets.length === 2){
      this.wallets = s.wallets.map((w) => ({ ...w }));
    } else {
      // legacy single-book save: split it 50/50 across the two wallets
      for (const w of this.wallets){ w.cash = (s.cash || 0) / 2; w.inv = (s.inv || 0) / 2; }
    }
    if (s.wash) this.wash = { ...this.wash, ...s.wash };
    this._sync();
    this.fees = s.fees || 0;
    this.botBought = s.botBought || 0; this.botSold = s.botSold || 0;
    this.botVolUSDT = s.botVolUSDT || 0; this.botTicks = s.botTicks || 0;
    this.equity0 = s.equity0;
    this.anchorZig = s.anchorZig; this.anchorBtc = s.anchorBtc;
    this.lambda = s.lambda; this.volPerSec = s.volPerSec;
    this.runtimeMs = s.runtimeMs || 0;
    if (s.track) this.track = { ...this.track, ...s.track };
    this.startedAt = Date.now();
    this.btcPrice = nowBtcPrice || s.anchorBtc;
    this.lastStep = Date.now();
    this.resumed = true;
    this.ready = true;

    const downMin = (Date.now() - (s.savedAt || Date.now())) / 60000;
    const gapBps = (Math.log(this.target) - this.lnP) * 1e4;
    if (downMin > this.cfg.maxResumeGapMin){
      // too long away — treat the missed move as water under the bridge
      this.anchorBtc = this.btcPrice;
      this.anchorZig = Math.exp(this.lnP);
      return { mode: 'reanchor', downMin, gapBps };
    }
    return { mode: 'continue', downMin, gapBps };
  }

  /**
   * Run the A<->B wash trades due this tick.
   * Seller hands inventory to buyer at the prevailing price; both pay fees.
   * Returns the ZIG quantity added to reported volume.
   */
  _washStep(P, dt, feeMul){
    const out = { qty: 0, notional: 0, trades: 0 };
    if (!this.cfg.washEnabled || !(P > 0)) return out;

    this.wash.carry += this.cfg.washRatePerSec * dt;
    let n = Math.floor(this.wash.carry);
    if (n <= 0) return out;
    this.wash.carry -= n;
    n = Math.min(n, 20);                       // sanity bound per tick

    for (let i = 0; i < n; i++){
      // alternate direction so the pair ping-pongs and nets flat
      this.wash.lastSide = -this.wash.lastSide;
      const seller = this.wash.lastSide > 0 ? this.wallets[0] : this.wallets[1];
      const buyer  = this.wash.lastSide > 0 ? this.wallets[1] : this.wallets[0];

      const jitter = 1 + (Math.random() * 2 - 1) * this.cfg.washJitter;
      let qty = (this.cfg.washClipUSDT * jitter) / P;
      if (qty > seller.inv) qty = seller.inv;                     // can't sell what you lack
      const notional = qty * P;
      const fee = notional * feeMul;
      if (qty <= 0 || buyer.cash < notional + fee) break;         // buyer must fund it

      seller.inv -= qty; seller.cash += notional - fee; seller.fees += fee; seller.washFills++;
      buyer.inv  += qty; buyer.cash  -= notional + fee; buyer.fees  += fee; buyer.washFills++;

      this.fees += fee * 2;
      this.wash.trades++;
      this.wash.volZIG += qty;
      this.wash.volUSDT += notional;
      this.wash.fees += fee * 2;
      this._tape(qty, 'wash', true);
      out.qty += qty; out.notional += notional; out.trades++;
    }
    this._sync();
    return out;
  }

  /**
   * Volume-vs-impact detector.
   *
   * Genuine flow moves price through lambda, so over a window
   * sum|d lnP| ~ lambda * sum|q|. Wash volume adds to the denominator and
   * nothing to the numerator, so the *apparent* lambda collapses. An outside
   * observer with no wallet labels can therefore estimate what fraction of
   * reported volume is fake:
   *
   *     washFracEstimate = 1 - lambdaApparent / lambdaTrue
   */
  _detect(now, absDlnP, qAll){
    this.detWin.push({ t: now, d: absDlnP, q: qAll });
    const cut = now - this.cfg.detectWindowSec * 1000;
    while (this.detWin.length && this.detWin[0].t < cut) this.detWin.shift();

    let sd = 0, sq = 0;
    for (const x of this.detWin){ sd += x.d; sq += x.q; }
    const lambdaApparent = sq > 0 ? sd / sq : null;
    const ratio = lambdaApparent != null && this.lambda > 0 ? lambdaApparent / this.lambda : null;
    const impliedWashFrac = ratio != null ? Math.max(0, Math.min(1, 1 - ratio)) : null;

    const totalTrades = this.botTicks + this.wash.trades;
    const selfTradeRatio = totalTrades > 0 ? this.wash.trades / totalTrades : 0;
    const apparentVolUSDT = this.botVolUSDT + this.wash.volUSDT + this.wash.realVolUSDT;
    const realVolUSDT = this.botVolUSDT + this.wash.realVolUSDT;
    const washRatio = apparentVolUSDT > 0 ? this.wash.volUSDT / apparentVolUSDT : 0;

    let flag = 'CLEAN', note = 'volume consistent with price impact';
    if (impliedWashFrac != null && impliedWashFrac > 0.7){
      flag = 'WASH LIKELY'; note = 'volume far exceeds its price impact';
    } else if (impliedWashFrac != null && impliedWashFrac > 0.4){
      flag = 'SUSPICIOUS'; note = 'impact per unit volume is depressed';
    }
    if (selfTradeRatio > 0.5){ flag = 'WASH CONFIRMED'; note = 'majority of fills are self-trades'; }

    return {
      lambdaTrue: this.lambda, lambdaApparent, impliedWashFrac,
      selfTradeRatio, washRatio, apparentVolUSDT, realVolUSDT,
      washVolUSDT: this.wash.volUSDT, washTrades: this.wash.trades, washFees: this.wash.fees,
      inflation: realVolUSDT > 0 ? apparentVolUSDT / realVolUSDT : 1,
      flag, note,
    };
  }

  /**
   * Roll the simulated price into 1m OHLC bars (this is the saved chart).
   * `tc` carries the BTC-implied target close for the same minute, which is
   * what makes the after-the-fact match report possible.
   */
  recordBar(now, P, T, volDelta){
    const b = Math.floor(now / 60000) * 60000;
    const last = this.bars1m[this.bars1m.length - 1];
    if (!last || b > last.t){
      this.bars1m.push({ t: b, o: P, h: P, l: P, c: P, v: volDelta || 0, tc: T });
      while (this.bars1m.length > this.cfg.maxBars) this.bars1m.shift();
    } else if (b === last.t){
      last.c = P;
      if (P > last.h) last.h = P;
      if (P < last.l) last.l = P;
      last.v += volDelta || 0;
      last.tc = T;
    }
  }

  /**
   * How well did the sim actually match BTC over the whole run?
   * Correlation and beta are computed on 1-minute log returns of the sim price
   * against the BTC-implied target. beta ~ 1 means it captured BTC's moves;
   * beta < 1 means it consistently lagged them.
   */
  matchReport(){
    const bars = this.bars1m.filter((b) => b.tc > 0 && b.c > 0);

    /** Correlation and beta of log returns measured over `h` one-minute bars. */
    const at = (h) => {
      let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
      for (let i = h; i < bars.length; i += h){
        const x = Math.log(bars[i].c / bars[i - h].c);
        const y = Math.log(bars[i].tc / bars[i - h].tc);
        if (!isFinite(x) || !isFinite(y)) continue;
        n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      }
      if (n <= 2) return { corr: null, beta: null, n };
      const mx = sx / n, my = sy / n;
      const cov = sxy / n - mx * my;
      const vx = sxx / n - mx * mx, vy = syy / n - my * my;
      return {
        corr: vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : null,
        beta: vy > 0 ? cov / vy : null,
        n,
      };
    };

    // "Trend" is not a 1-minute concept. Minute returns are mostly ZIG's own
    // noise; the longer horizons are where a shared trend actually shows up.
    const horizons = { m1: at(1), m5: at(5), m15: at(15), m60: at(60) };
    const { corr, beta } = horizons.m1;
    const first = bars[0], last = bars[bars.length - 1];
    const simRetPct = first && last ? (last.c / first.c - 1) * 100 : 0;
    const tgtRetPct = first && last ? (last.tc / first.tc - 1) * 100 : 0;

    const T = this.track, t = Math.max(T.ticks, 1);
    return {
      minutes: bars.length,
      ticks: T.ticks,
      rmsErrBps: Math.sqrt(T.sumSq / t),
      maxErrBps: T.maxAbs,
      within: {
        b10:  (T.b10  / t) * 100, b25: (T.b25 / t) * 100, b50: (T.b50 / t) * 100,
        b100: (T.b100 / t) * 100, b250: (T.b250 / t) * 100,
      },
      depthLimitedPct: (T.depthLimited / t) * 100,
      starvedPct: (T.starvedTicks / t) * 100,
      corr, beta, horizons, simRetPct, tgtRetPct,
      capturePct: tgtRetPct !== 0 ? (simRetPct / tgtRetPct) * 100 : null,
      from: first ? first.t : null, to: last ? last.t : null,
    };
  }

  /** Aggregate the stored 1m bars up to any coarser interval. */
  barsAt(intervalSec, limit = 1000){
    if (intervalSec < 60) intervalSec = 60;
    const out = [];
    for (const b of this.bars1m){
      const t = Math.floor(b.t / 1000 / intervalSec) * intervalSec;
      const last = out[out.length - 1];
      if (!last || t > last.time){
        out.push({ time: t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
      } else {
        last.close = b.c;
        if (b.h > last.high) last.high = b.h;
        if (b.l < last.low) last.low = b.l;
        last.volume += b.v;
      }
    }
    return out.slice(-limit);
  }

  /** Calibrate lambda + typical volume from real ZIG history, anchor to real prices. */
  calibrate(zigCandles, btcCandles, barSec){
    if (!zigCandles?.length || !btcCandles?.length) return false;

    const elasticity = [];
    for (const c of zigCandles){
      if (c.volume > 0 && c.low > 0 && c.high > c.low){
        elasticity.push(Math.log(c.high / c.low) / c.volume);
      }
    }
    this.lambda = (median(elasticity) || 1e-9) * this.cfg.impactCoef;

    const vols = zigCandles.map((c) => c.volume).filter((v) => v > 0);
    this.volPerSec = (median(vols) || 1) / Math.max(barSec, 1);

    this.anchorZig = zigCandles[zigCandles.length - 1].close;
    this.anchorBtc = btcCandles[btcCandles.length - 1].close;
    this.btcPrice = this.anchorBtc;
    this.lnP = Math.log(this.anchorZig);

    // 50/50 across the two wallets, each with the same cash/inventory split
    const perWallet = this.cfg.capitalUSDT / 2;
    for (const w of this.wallets){
      w.cash = perWallet * (1 - this.cfg.splitToInventory);
      w.inv = (perWallet * this.cfg.splitToInventory) / this.anchorZig;
      w.fees = 0; w.fills = 0; w.washFills = 0;
    }
    this._sync();
    this.equity0 = this.cash + this.inv * this.anchorZig;
    this.lastStep = Date.now();
    this.startedAt = Date.now();
    this.ready = true;
    return true;
  }

  onZigTrade(t){
    if (!this.ready) return;
    this._tape(t.qty, 'real', false);
    const signed = t.side === 'buy' ? t.qty : -t.qty;
    this.pendingFlow += signed;
    this.pendingVol += t.qty;
    const now = t.time || Date.now();
    this.ofiWin.push({ t: now, q: signed });
    this.volWin.push({ t: now, q: t.qty });
    this.ofiSum += signed; this.volSum += t.qty; if (signed > 0) this.buySum += signed;
  }

  onBtcPrice(p){ if (p > 0) this.btcPrice = p; }

  /** The unconstrained BTC-implied price: what a perfect 1:1 peg would hold. */
  get absoluteTarget(){ return this.anchorZig * (this.btcPrice / this.anchorBtc); }

  get target(){
    switch (this.cfg.trackMode){
      case 'slew':    return this.slewTarget || this.absoluteTarget;
      case 'beta':    return this.anchorZig * Math.pow(this.btcPrice / this.anchorBtc, this.cfg.trackBeta);
      case 'rolling': // anchors are refreshed on a timer, so this is a short-horizon peg
      case 'absolute':
      default:        return this.absoluteTarget;
    }
  }

  /** The fastest the peg can drag price, in log units per second. */
  get feasibleRate(){ return this.lambda * this.cfg.maxParticipation * this.volPerSec; }

  /** Advance whatever state the current tracking mode needs. */
  _updateTarget(now, dt){
    if (this.cfg.trackMode === 'rolling'){
      if (!this.anchorAt) this.anchorAt = now;
      if (now - this.anchorAt >= this.cfg.rollingWindowSec * 1000){
        this.anchorZig = Math.exp(this.lnP);   // re-base onto where we actually are
        this.anchorBtc = this.btcPrice;
        this.anchorAt = now;
      }
      return;
    }
    if (this.cfg.trackMode === 'slew'){
      if (!this.slewTarget) this.slewTarget = Math.exp(this.lnP);
      const lnDesired = Math.log(this.absoluteTarget);
      let lnSlew = Math.log(this.slewTarget);
      const gap = lnDesired - lnSlew;
      // never ask for more movement per tick than the book can supply
      const maxStep = this.feasibleRate * this.cfg.slewHeadroom * dt;
      lnSlew += Math.sign(gap) * Math.min(Math.abs(gap), maxStep);
      this.slewTarget = Math.exp(lnSlew);
    }
  }

  step(){
    if (!this.ready) return null;
    const now = Date.now();
    const dt = Math.max((now - this.lastStep) / 1000, 1e-3);
    this.lastStep = now;
    const feeMul = this.cfg.feeBps / 1e4;

    // ---- 1. real order flow moves the simulated price -----------------------
    this._updateTarget(now, dt);

    const flowSigned = this.pendingFlow;
    let volDelta = this.pendingVol;
    const lnStart = this.lnP;
    this.lnP += this.lambda * flowSigned;
    this.wash.realVolUSDT += this.pendingVol * Math.exp(this.lnP);
    this.pendingFlow = 0; this.pendingVol = 0;

    // ---- 2. control law: feedforward + feedback ----------------------------
    // feedforward acts on how far the TARGET moved this tick (no lag);
    // feedback acts on the error that is still outstanding (corrects drift).
    const lnT = Math.log(this.target);
    const dTarget = this.lnTprev != null ? lnT - this.lnTprev : 0;
    this.lnTprev = lnT;

    const err = lnT - this.lnP;
    const qFF = (this.cfg.feedforward * dTarget) / this.lambda;
    const qFB = (this.cfg.gain * err) / this.lambda;
    let q = qFF + qFB;

    // ---- 3. cap by realistic participation in the real market --------------
    // You cannot trade more than a fraction of what actually trades. This is
    // usually the binding constraint on a thin book, and it is the honest
    // reason a tick-for-tick peg is or isn't achievable.
    let P = Math.exp(this.lnP);
    const wanted = q;
    const cap = this.cfg.maxParticipation * this.volPerSec * dt;   // ZIG tradable this tick
    let capped = false;
    if (Math.abs(q) > cap){ q = Math.sign(q) * cap; capped = true; }

    // Exchange minimum order size. A maker cannot fire a sub-minimum clip every
    // 100ms, so it *works* the order: accumulate the allowance and send when the
    // clip is worth sending. Treating the minimum as a per-tick floor instead
    // would let it trade many times the market's entire volume.
    this.pendingBotQty += q;
    if (Math.abs(this.pendingBotQty) * P < this.cfg.minNotionalUSDT){
      q = 0;                                   // still working
    } else {
      q = this.pendingBotQty;
      this.pendingBotQty = 0;
    }

    // ---- 4. spot constraints: cash to buy, inventory to sell ---------------
    let starved = null;
    if (q > 0){
      const affordable = this.cash / (P * (1 + feeMul));
      if (q > affordable){ q = Math.max(affordable, 0); starved = 'cash'; }
    } else if (q < 0){
      if (-q > this.inv){ q = -Math.max(this.inv, 0); starved = 'inventory'; }
    }

    // ---- 5. execute on paper ----------------------------------------------
    let bot = null;
    if (Math.abs(q) * P > 1e-9){
      this.lnP += this.lambda * q;            // the bot moves the market too
      P = Math.exp(this.lnP);
      const notional = Math.abs(q) * P;
      const fee = notional * feeMul;
      this.fees += fee;
      // route to whichever wallet has capacity for this side
      const w = q > 0
        ? (this.wallets[0].cash >= this.wallets[1].cash ? this.wallets[0] : this.wallets[1])
        : (this.wallets[0].inv  >= this.wallets[1].inv  ? this.wallets[0] : this.wallets[1]);
      if (q > 0){ w.cash -= notional + fee; w.inv += q; this.botBought += q; }
      else      { w.cash += notional - fee; w.inv += q; this.botSold += -q; }
      w.fees += fee; w.fills++;
      this._sync();
      this.botVolUSDT += notional;
      this.botTicks++;
      volDelta += Math.abs(q);
      this._tape(Math.abs(q), 'peg', false);
      bot = { side: q > 0 ? 'buy' : 'sell', qty: Math.abs(q), price: P, notional, capped, starved, wallet: w.id };
    }

    // ---- 5b. wash trades between the two wallets ---------------------------
    // A matched trade at the current price: inventory moves A->B, cash moves
    // B->A. Combined position change is exactly zero, so it applies NO price
    // impact -- that asymmetry is what the detector below picks up. The only
    // real economic effect is that both sides pay the fee.
    const washVol = this._washStep(P, dt, feeMul);
    volDelta += washVol.qty;

    // ---- 6. metrics --------------------------------------------------------
    const equity = this.cash + this.inv * P;
    const errBps = (this.lnP - lnT) * 1e4;
    this.recordBar(now, P, Math.exp(lnT), volDelta);

    // detector sees every reported fill, but only genuine flow moved the price
    const detect = this._detect(now, Math.abs(this.lnP - lnStart), volDelta);

    const ae = Math.abs(errBps);
    const T = this.track;
    T.ticks++; T.sumSq += ae * ae;
    if (ae > T.maxAbs) T.maxAbs = ae;
    if (ae <= 10) T.b10++;
    if (ae <= 25) T.b25++;
    if (ae <= 50) T.b50++;
    if (ae <= 100) T.b100++;
    if (ae <= 250) T.b250++;
    if (capped) T.depthLimited++;
    if (starved) T.starvedTicks++;

    // amortised O(1) window trimming — these run at 10 Hz, so no per-tick
    // filter() allocations and no reduce() over the whole window
    const cut = now - this.cfg.windowSec * 1000;
    while (this.ofiWin.length && this.ofiWin[0].t < cut){ const x = this.ofiWin.shift(); this.ofiSum -= x.q; if (x.q > 0) this.buySum -= x.q; }
    while (this.volWin.length && this.volWin[0].t < cut) this.volSum -= this.volWin.shift().q;
    this.eqWin.push({ t: now, e: equity });
    while (this.eqWin.length && this.eqWin[0].t < cut) this.eqWin.shift();
    const sq = errBps * errBps;
    this.errWin.push(sq); this.errSumSq += sq;
    while (this.errWin.length > 900) this.errSumSq -= this.errWin.shift();

    const ofi = this.ofiSum;
    const vol = this.volSum;
    const buyVol = this.buySum;
    const buyRatio = vol > 0 ? buyVol / vol : 0.5;

    let burnPerMin = 0;
    if (this.eqWin.length > 1){
      const a = this.eqWin[0], b = this.eqWin[this.eqWin.length - 1];
      const mins = (b.t - a.t) / 60000;
      if (mins > 0.05) burnPerMin = (b.e - a.e) / mins;
    }
    const runwayMin = burnPerMin < 0 ? equity / Math.abs(burnPerMin) : Infinity;
    const rmsErrBps = Math.sqrt(this.errSumSq / Math.max(this.errWin.length, 1));

    // ---- 7. verdict: keep funding the peg, or stop? ------------------------
    // Two independent ways this fails: you run out of money, or the market is
    // too thin to move no matter how much money you have.
    const fillRatio = Math.abs(wanted) > 1e-12 ? Math.abs(q) / Math.abs(wanted) : 1;
    let verdict = 'HOLD', reason = 'tracking inside tolerance';
    if (this.cash <= 0 && this.inv <= 0){
      verdict = 'STOP'; reason = 'out of capital';
    } else if (starved){
      verdict = 'STOP'; reason = `cannot fill — out of ${starved}`;
    } else if (rmsErrBps > 150){
      verdict = 'STOP'; reason = 'peg not holding — market too thin for this flow';
    } else if (runwayMin <= 60){
      verdict = 'STOP'; reason = 'runway under 1h against this flow';
    } else if (rmsErrBps > 60){
      verdict = 'CAUTION'; reason = 'tracking slipping — size-limited by depth';
    } else if (runwayMin <= 240){
      verdict = 'CAUTION'; reason = 'burn rising, under 4h runway';
    } else if (rmsErrBps < 25){
      verdict = 'ADD'; reason = 'peg is cheap to hold, flow supportive';
    } else {
      verdict = 'HOLD'; reason = 'funded, but tracking is loose';
    }

    const suggestUSDT = burnPerMin < 0
      ? Math.max(0, Math.abs(burnPerMin) * this.cfg.targetRunwayMin - equity)
      : 0;

    return {
      type: 'engine', t: now,
      price: P, target: Math.exp(lnT), errBps, volDelta,
      // errBps is against the mode's own target; absErrBps is against the true
      // 1:1 BTC-implied price, which is the honest "how close to BTC" number
      absTarget: this.absoluteTarget,
      absErrBps: (this.lnP - Math.log(this.absoluteTarget)) * 1e4,
      trackMode: this.cfg.trackMode,
      feasiblePctPerHour: this.feasibleRate * 3600 * 100,
      bot,
      ledger: {
        cash: this.cash, inv: this.inv, equity, equity0: this.equity0,
        pnl: equity - this.equity0, fees: this.fees,
        botBought: this.botBought, botSold: this.botSold,
        botVolUSDT: this.botVolUSDT, botTicks: this.botTicks,
      },
      flow: { ofi, vol, buyRatio, flowSigned },
      risk: { burnPerMin, runwayMin: isFinite(runwayMin) ? runwayMin : null, rmsErrBps, verdict, reason, suggestUSDT,
              wantedQty: wanted, filledQty: q, fillRatio, depthLimited: capped },
      calib: { lambda: this.lambda, volPerSec: this.volPerSec, anchorZig: this.anchorZig, anchorBtc: this.anchorBtc, gain: this.cfg.gain },
      session: { resumed: this.resumed, runtimeMs: this.runtimeMs + (now - this.startedAt), bars: this.bars1m.length },
      wallets: this.wallets.map((w) => ({
        id: w.id, cash: w.cash, inv: w.inv, value: w.cash + w.inv * P,
        fees: w.fees, fills: w.fills, washFills: w.washFills,
      })),
      detect,
      forensics: this.forensics(now),
    };
  }
}

module.exports = { PegEngine, DEFAULTS };
