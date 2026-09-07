/*
 * Monte Carlo: how closely can the peg track BTC, across many real market windows?
 *
 * Replays REAL historical BTC 1m paths from MEXC (not synthetic curves) and
 * REAL ZIG per-minute volume as the order-flow intensity, then sweeps the one
 * assumption that actually matters: what multiple of the real ZIG market the
 * operator is willing to be.
 *
 *   node montecarlo.js [runs] [windowMin]
 */
'use strict';

const { PegEngine } = require('./engine');

const MEXC = 'https://api.mexc.com';
const RUNS = Number(process.argv[2] || 200);
const WINDOW_MIN = Number(process.argv[3] || 120);
const STEP_SEC = Number(process.env.STEP||5);                       // sim resolution
const PARTICIPATIONS = (process.env.PARTS||"0.6,1,2,3,5,10").split(",").map(Number);
const TRACK_BETA = 0.95;

// deterministic RNG so a run is reproducible
let seed = 20260908;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

async function fetchKlines(symbol, interval, barSec, want){
  const barMs = barSec * 1000;
  let endTime = Date.now();
  const oldest = endTime - want * barMs;
  const byTime = new Map();
  for (let call = 0; call < 40 && endTime > oldest; call++){
    const startTime = Math.max(oldest, endTime - 500 * barMs);
    const u = `${MEXC}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=500&startTime=${startTime}&endTime=${endTime}`;
    const r = await fetch(u, { headers: { 'user-agent': 'btczig-mc/1.0' } });
    if (!r.ok) throw new Error(`${symbol} ${r.status}`);
    const raw = await r.json();
    if (!raw.length) break;
    for (const k of raw){
      byTime.set(k[0], { time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] });
    }
    endTime = raw[0][0] - 1;
    if (raw.length < 500) break;
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function pct(arr, p){
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * s.length)));
  return s[i];
}
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const f = (x, d = 3) => (x == null || !isFinite(x) ? '  —  ' : x.toFixed(d));

/** One replay: a real BTC window, real ZIG flow intensity, one participation level. */
function replay(btcWin, zigWin, zigHist, btcHist, participation){
  const RealNow = Date.now;
  let SIM = 1700000000000;
  Date.now = () => SIM;
  try {
    const e = new PegEngine({
      trackMode: 'beta', trackBeta: TRACK_BETA,
      maxParticipation: participation,
      feedforward: Number(process.env.FF||0),
      gain: Number(process.env.GAIN||0.6),
      minNotionalUSDT: Number(process.env.MINNOT||5),
      capitalUSDT: 5e6,          // large enough that cash is never the binding constraint
      forensicsEnabled: false,   // not needed here, and it dominates runtime
    });
    if (!e.calibrate(zigHist, btcHist, 60)) return null;

    const stepsPerBar = Math.round(60 / STEP_SEC);
    for (let b = 0; b < btcWin.length; b++){
      const bar = btcWin[b];
      const zb = zigWin[b] || zigWin[zigWin.length - 1];
      // real ZIG volume for this minute, split across the sub-steps
      const qPerStep = Math.max((zb.volume || 0) / stepsPerBar, 0);
      for (let s = 0; s < stepsPerBar; s++){
        SIM += STEP_SEC * 1000;
        // interpolate inside the real BTC bar so intra-bar shape is preserved
        const t = s / stepsPerBar;
        const px = bar.open + (bar.close - bar.open) * t
                 + (bar.high - bar.low) * 0.5 * Math.sin(t * Math.PI * 2) * 0.5;
        e.onBtcPrice(px);
        if (qPerStep > 0){
          e.onZigTrade({ price: Math.exp(e.lnP), qty: qPerStep, side: rnd() < 0.5 ? 'buy' : 'sell', time: SIM });
        }
        e.step();
      }
    }
    const r = e.matchReport();
    return { corr: r.corr, beta: r.beta, h5: r.horizons.m5.corr, h15: r.horizons.m15.corr, h60: r.horizons.m60.corr, capture: r.capturePct, depthLim: r.depthLimitedPct,
             botVol: e.botVolUSDT, btcMovePct: (btcWin[btcWin.length - 1].close / btcWin[0].close - 1) * 100 };
  } finally {
    Date.now = RealNow;
  }
}

(async () => {
  console.log(`fetching real MEXC history...`);
  const [btc, zig] = await Promise.all([
    fetchKlines('BTCUSDT', '1m', 60, 20000),
    fetchKlines('ZIGUSDT', '1m', 60, 20000),
  ]);
  console.log(`BTC 1m bars: ${btc.length}   ZIG 1m bars: ${zig.length}`);

  // align on shared timestamps
  const zigBy = new Map(zig.map((k) => [k.time, k]));
  const aligned = btc.filter((k) => zigBy.has(k.time));
  console.log(`aligned bars: ${aligned.length}  (~${(aligned.length / 1440).toFixed(1)} days)`);
  if (aligned.length < WINDOW_MIN * 2) throw new Error('not enough aligned history');

  const zigHist = aligned.map((k) => zigBy.get(k.time));
  const cal = { zig: zigHist.slice(0, 1000), btc: aligned.slice(0, 1000) };

  // pre-pick the windows so every participation level sees the SAME markets
  const windows = [];
  for (let i = 0; i < RUNS; i++){
    const start = Math.floor(rnd() * (aligned.length - WINDOW_MIN - 1));
    windows.push(start);
  }

  console.log(`\nrunning ${RUNS} windows x ${WINDOW_MIN}min x ${PARTICIPATIONS.length} participation levels`);
  console.log(`target amplitude: ${TRACK_BETA * 100}% of BTC\n`);

  const moves = windows.map((s) => (aligned[s + WINDOW_MIN - 1].close / aligned[s].close - 1) * 100);
  console.log(`BTC ${WINDOW_MIN}min moves in sample:  median ${f(pct(moves.map(Math.abs), 50), 2)}%  ` +
              `p90 ${f(pct(moves.map(Math.abs), 90), 2)}%  max ${f(Math.max(...moves.map(Math.abs)), 2)}%\n`);

  console.log('part |  corr: median   p10    p90  | amplitude med | capture med | depthLim | botVol med');
  console.log('-----+-----------------------------+---------------+-------------+----------+-----------');

  const summary = {};
  for (const p of PARTICIPATIONS){
    const corrs=[],betas=[],caps=[],dls=[],vols=[],h5=[],h15=[],h60=[];
    for (const start of windows){
      const bw = aligned.slice(start, start + WINDOW_MIN);
      const zw = zigHist.slice(start, start + WINDOW_MIN);
      const r = replay(bw, zw, cal.zig, cal.btc, p);
      if (!r || r.corr == null) continue;
      corrs.push(r.corr); if (r.beta != null) betas.push(r.beta);
      if(r.h5!=null)h5.push(r.h5); if(r.h15!=null)h15.push(r.h15); if(r.h60!=null)h60.push(r.h60);
      if (r.capture != null && isFinite(r.capture)) caps.push(r.capture);
      dls.push(r.depthLim); vols.push(r.botVol);
    }
    summary[p] = { n: corrs.length, corrMed: pct(corrs, 50), corrP10: pct(corrs, 10), corrP90: pct(corrs, 90),
                   betaMed: pct(betas, 50), capMed: pct(caps, 50), dlMed: pct(dls, 50), volMed: pct(vols,50), corrs, h5:pct(h5,50), h15:pct(h15,50), h60:pct(h60,50) };
    const s = summary[p];
    console.log(
      String(p).padStart(4) + ' | ' +
      f(s.corrMed, 3).padStart(11) + f(s.corrP10, 3).padStart(7) + f(s.corrP90, 3).padStart(7) + '  | ' +
      f(s.betaMed, 3).padStart(13) + ' | ' + f(s.capMed, 0).padStart(10) + '% | ' +
      f(s.dlMed,0).padStart(7)+'% | corr@5m '+f(s.h5,3).padStart(6)+' 15m '+f(s.h15,3).padStart(6)+' 60m '+f(s.h60,3).padStart(6)
    );
  }

  // how often does each level clear a similarity bar? (reuses the pass above)
  console.log('\nshare of windows reaching corr >=  0.90 / 0.75 / 0.50:');
  for (const p of PARTICIPATIONS){
    const c = summary[p].corrs;
    const h = (t) => ((c.filter((x) => x >= t).length / c.length) * 100).toFixed(0).padStart(3);
    console.log(`  ${String(p).padStart(4)}x   ${h(0.9)}%   ${h(0.75)}%   ${h(0.5)}%`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
