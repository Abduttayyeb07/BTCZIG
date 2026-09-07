/*
 * BTCZIG live — MEXC spot, ZIG vs BTC side by side.
 *
 *  - Serves the single-page UI (public/index.html)
 *  - REST proxy for 30d history + 24h ticker (api.mexc.com, JSON)
 *  - Upstream protobuf websocket to wss://wbs-api.mexc.com/ws
 *      spot@public.kline.v3.api.pb@<SYM>@<interval>
 *      spot@public.aggre.deals.v3.api.pb@100ms@<SYM>
 *    decoded with proto/mexc.proto and rebroadcast to the browser as JSON
 *  - Browser -> server control message: { type:'interval', value:'1H' }
 *
 * Node >= 18 (uses global fetch).  npm install, then: npm start
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const protobuf = require('protobufjs');
const { PegEngine, DEFAULTS: ENGINE_DEFAULTS } = require('./engine');

const PORT = process.env.PORT || 5173;
// 0.0.0.0 inside a container (the port mapping is what restricts exposure);
// set HOST=127.0.0.1 to bind loopback only when running bare on a host.
const HOST = process.env.HOST || '0.0.0.0';
// READONLY=1 blocks POST /api/engine, so a publicly shared URL cannot be used
// to reconfigure, reset, or wipe a run that is being measured.
const READONLY = process.env.READONLY === '1';
const SYMBOLS = ['ZIGUSDT', 'BTCUSDT'];
const MEXC_REST = 'https://api.mexc.com';
const MEXC_WS = 'wss://wbs-api.mexc.com/ws';

// UI interval key -> MEXC REST interval / MEXC WS interval / seconds per bar
const INTERVALS = {
  '1m': { rest: '1m', ws: 'Min1', sec: 60 },
  '5m': { rest: '5m', ws: 'Min5', sec: 300 },
  '15m': { rest: '15m', ws: 'Min15', sec: 900 },
  '30m': { rest: '30m', ws: 'Min30', sec: 1800 },
  '1H': { rest: '60m', ws: 'Min60', sec: 3600 },
  '4H': { rest: '4h', ws: 'Hour4', sec: 14400 },
  '1D': { rest: '1d', ws: 'Day1', sec: 86400 },
};
const DEFAULT_INTERVAL = '1H';

// ---------------------------------------------------------------------------
// protobuf
// ---------------------------------------------------------------------------
let Wrapper = null;
protobuf.load(path.join(__dirname, 'proto', 'mexc.proto'))
  .then((root) => {
    Wrapper = root.lookupType('PushDataV3ApiWrapper');
    console.log('[proto] loaded PushDataV3ApiWrapper');
    connectUpstream();
    calibrateEngine();
  })
  .catch((err) => {
    console.error('[proto] failed to load:', err);
    process.exit(1);
  });

// ---------------------------------------------------------------------------
// HTTP + browser websocket
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (url.pathname.startsWith('/vendor/')) {
      const safe = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
      const file = path.join(__dirname, 'public', safe);
      if (!file.startsWith(path.join(__dirname, 'public', 'vendor')) || !fs.existsSync(file)) {
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'max-age=86400' });
      return res.end(fs.readFileSync(file));
    }

    if (url.pathname === '/api/history') {
      const symbol = String(url.searchParams.get('symbol') || '').toUpperCase();
      const key = url.searchParams.get('interval') || DEFAULT_INTERVAL;
      const limit = Math.min(Number(url.searchParams.get('limit')) || 1000, 1000);
      if (!SYMBOLS.includes(symbol) || !INTERVALS[key]) return json(res, 400, { error: 'bad params' });
      const candles = await fetchKlines(symbol, key, limit);
      return json(res, 200, { symbol, interval: key, candles });
    }

    if (url.pathname === '/healthz') {
      const ok = engine.ready && up && up.readyState === WebSocket.OPEN;
      return json(res, ok ? 200 : 503, { ok, engine: engine.ready, upstream: !!(up && up.readyState === WebSocket.OPEN) });
    }

    if (url.pathname === '/api/report') {
      const rep = engine.matchReport();
      if (url.searchParams.get('format') === 'text') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(reportText(rep));
      }
      return json(res, 200, rep);
    }

    if (url.pathname === '/api/sim-history') {
      const key = url.searchParams.get('interval') || DEFAULT_INTERVAL;
      const limit = Math.min(Number(url.searchParams.get('limit')) || 1000, 5000);
      if (!INTERVALS[key]) return json(res, 400, { error: 'bad interval' });
      return json(res, 200, { interval: key, candles: engine.barsAt(INTERVALS[key].sec, limit) });
    }

    if (url.pathname === '/api/engine') {
      if (req.method === 'POST') {
        // READONLY=1 makes the deployment safe to share: viewers can watch
        // everything, but nobody can reconfigure or reset a run in progress.
        if (READONLY) {
          return json(res, 403, { error: 'read-only deployment', hint: 'unset READONLY to allow control' });
        }
        const body = await readBody(req);
        const cfg = sanitizeCfg(body);
        const wipe = body.reset === true;
        const needsRecalib = wipe || Object.keys(cfg).some((k) => RECALIB_KEYS.has(k));
        Object.assign(engine.cfg, cfg);
        if (wipe) {
          engine.reset();
          try { fs.rmSync(STATE_FILE, { force: true }); fs.rmSync(BARS_FILE, { force: true }); } catch {}
          console.log('[engine] state wiped by request');
        }
        if (needsRecalib) await calibrateEngine({ resume: !wipe });
        console.log(`[engine] reconfigured${needsRecalib ? ' (recalibrated)' : ' (live)'}`, JSON.stringify(cfg));
      }
      return json(res, 200, {
        cfg: engine.cfg, ready: engine.ready, resumed: engine.resumed, readonly: READONLY,
        runtimeMs: engine.runtimeMs + (Date.now() - engine.startedAt),
        bars: engine.bars1m.length,
        calib: {
          lambda: engine.lambda, volPerSec: engine.volPerSec,
          anchorZig: engine.anchorZig, anchorBtc: engine.anchorBtc,
        },
      });
    }

    if (url.pathname === '/api/ticker') {
      const symbol = String(url.searchParams.get('symbol') || '').toUpperCase();
      if (!SYMBOLS.includes(symbol)) return json(res, 400, { error: 'bad symbol' });
      const r = await fetch(`${MEXC_REST}/api/v3/ticker/24hr?symbol=${symbol}`, {
        headers: { 'user-agent': 'btczig-live/1.0' },
      });
      if (!r.ok) return json(res, 502, { error: `mexc ${r.status}` });
      return json(res, 200, await r.json());
    }

    res.writeHead(404); res.end('not found');
  } catch (err) {
    console.error('[http]', err);
    json(res, 500, { error: String(err && err.message || err) });
  }
});

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

const CFG_KEYS = Object.keys(ENGINE_DEFAULTS);
// changing these alters the starting book or lambda, so they need a re-calibrate;
// everything else (gain, participation, wash knobs) applies live
const RECALIB_KEYS = new Set(['capitalUSDT', 'splitToInventory', 'impactCoef']);

const TRACK_MODES = new Set(['absolute', 'slew', 'rolling', 'beta']);
function sanitizeCfg(body) {
  const out = {};
  for (const k of CFG_KEYS) {
    if (k === 'trackMode') {
      if (TRACK_MODES.has(body[k])) out[k] = body[k];
    } else if (typeof ENGINE_DEFAULTS[k] === 'boolean') {
      if (typeof body[k] === 'boolean') out[k] = body[k];
    } else {
      const v = Number(body[k]);
      if (Number.isFinite(v) && v >= 0) out[k] = v;
    }
  }
  return out;
}

/** MEXC spot klines silently cap at 500 rows/call -> page backwards from now. */
async function fetchKlines(symbol, key, limit) {
  const iv = INTERVALS[key];
  const barMs = iv.sec * 1000;
  let endTime = Date.now();
  const oldest = endTime - limit * barMs;
  const byTime = new Map();
  for (let call = 0; call < 6 && endTime > oldest; call++) {
    const startTime = Math.max(oldest, endTime - 500 * barMs);
    const u = `${MEXC_REST}/api/v3/klines?symbol=${symbol}&interval=${iv.rest}&limit=500&startTime=${startTime}&endTime=${endTime}`;
    const r = await fetch(u, { headers: { 'user-agent': 'btczig-live/1.0' } });
    if (!r.ok) throw new Error(`mexc ${r.status} for ${symbol}`);
    const raw = await r.json();
    if (!raw.length) break;
    // MEXC row: [openTime, open, high, low, close, volume, closeTime, quoteVolume]
    for (const k of raw) {
      byTime.set(k[0], { time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] });
    }
    endTime = raw[0][0] - 1;
    if (raw.length < 500) break;
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

const wss = new WebSocketServer({ server, path: '/stream' });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'status', upstream: upstreamReady, interval: currentKey }));
  ws.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg && msg.type === 'interval' && INTERVALS[msg.value]) changeInterval(msg.value);
  });
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

const stats = { klZIGUSDT: 0, klBTCUSDT: 0, trZIGUSDT: 0, trBTCUSDT: 0 };
function broadcast(obj) {
  if (obj.type === 'kline') stats['kl' + obj.symbol]++;
  else if (obj.type === 'trade') stats['tr' + obj.symbol]++;
  const s = JSON.stringify(obj);
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(s);
}

// heartbeat: prints only when something moved
let lastBeat = { ...stats };
setInterval(() => {
  const changed = Object.keys(stats).some((k) => stats[k] !== lastBeat[k]);
  if (!changed && clients.size === 0) return;
  const d = (k) => stats[k] - lastBeat[k];
  console.log(
    `[feed] +15s  kline z:${d('klZIGUSDT')} b:${d('klBTCUSDT')}  ` +
    `trades z:${d('trZIGUSDT')} b:${d('trBTCUSDT')}  ` +
    `browsers:${clients.size}  upstream:${up && up.readyState === WebSocket.OPEN ? 'live' : 'down'}`
  );
  if (engine.ready) {
    const s = lastEngineState;
    if (s) {
      console.log(
        `[peg]  sim=${s.price.toPrecision(6)} target=${s.target.toPrecision(6)} ` +
        `err=${s.errBps.toFixed(1)}bps (rms ${s.risk.rmsErrBps.toFixed(1)})  ` +
        `equity=$${s.ledger.equity.toFixed(0)} pnl=$${s.ledger.pnl.toFixed(2)}  ` +
        `botVol=$${s.ledger.botVolUSDT.toFixed(0)}  ` +
        `flow ofi=${s.flow.ofi.toFixed(0)} buy%=${(s.flow.buyRatio * 100).toFixed(0)}  ` +
        `-> ${s.risk.verdict} (${s.risk.reason})`
      );
    }
  }
  lastBeat = { ...stats };
}, 15000);

server.listen(PORT, HOST, () => {
  console.log(`\n  ZIG peg engine  ->  http://127.0.0.1:${PORT}   (bound ${HOST}:${PORT})${READONLY ? '  [READ-ONLY]' : ''}\n`);
});

// ---------------------------------------------------------------------------
// peg engine — real MEXC flow in, cost-of-peg out
// ---------------------------------------------------------------------------
const engine = new PegEngine();
let engineTimer = null;
let lastEngineState = null;

const STATE_DIR = path.join(__dirname, 'state');
const STATE_FILE = path.join(STATE_DIR, 'engine.json');
const BARS_FILE = path.join(STATE_DIR, 'sim-bars.json');
const FRESH = process.argv.includes('--fresh') || process.env.FRESH === '1';

function writeAtomic(file, data) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function saveState() {
  if (!engine.ready) return;
  try { writeAtomic(STATE_FILE, JSON.stringify(engine.toJSON())); }
  catch (e) { console.warn('[state] save failed:', e.message); }
}
function saveBars() {
  if (!engine.ready || !engine.bars1m.length) return;
  try { writeAtomic(BARS_FILE, JSON.stringify({ version: 1, bars: engine.bars1m })); }
  catch (e) { console.warn('[state] bars save failed:', e.message); }
}
function saveAll() { saveState(); saveBars(); }

function reportText(r) {
  const n = (v, d = 2) => (v == null || !isFinite(v) ? '—' : v.toFixed(d));
  const span = r.from && r.to
    ? `${new Date(r.from).toISOString().slice(0, 16).replace('T', ' ')} → ${new Date(r.to).toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : '—';
  return [
    '================ ZIG vs BTC — MATCH REPORT ================',
    `window        ${span}  (${r.minutes} min, ${r.ticks.toLocaleString('en-US')} ticks)`,
    '',
    '-- how closely did it track --',
    `rms error     ${n(r.rmsErrBps, 1)} bps`,
    `worst error   ${n(r.maxErrBps, 1)} bps`,
    `within  10bps ${n(r.within.b10, 1)}%`,
    `within  25bps ${n(r.within.b25, 1)}%`,
    `within  50bps ${n(r.within.b50, 1)}%`,
    `within 100bps ${n(r.within.b100, 1)}%`,
    `within 250bps ${n(r.within.b250, 1)}%`,
    '',
    '-- did it reproduce the BTC shape --',
    '  ZIG is ~6-9x more volatile than BTC, so at short horizons its own noise',
    '  drowns the BTC signal. Trend similarity should improve with horizon.',
    ...(r.horizons ? ['', '  horizon    corr     beta      n',
      ...['m1', 'm5', 'm15', 'm60'].map((k) => {
        const h = r.horizons[k];
        return `  ${k.padEnd(9)}${n(h.corr, 4).padStart(7)}  ${n(h.beta, 3).padStart(7)}  ${String(h.n).padStart(5)}`;
      }), ''] : []),
    `correlation   ${n(r.corr, 4)}   (1m log returns)`,
    `beta          ${n(r.beta, 4)}   (1.0 = captured the moves fully, <1 = lagged)`,
    `sim return    ${n(r.simRetPct, 3)}%`,
    `btc return    ${n(r.tgtRetPct, 3)}%`,
    `captured      ${n(r.capturePct, 1)}% of the BTC move`,
    '',
    '-- why it fell short (if it did) --',
    `depth-limited ${n(r.depthLimitedPct, 1)}% of ticks  (market too thin to fill)`,
    `starved       ${n(r.starvedPct, 1)}% of ticks  (out of cash or inventory)`,
    '===========================================================',
  ].join('\n');
}

function startEngineLoop() {
  clearInterval(engineTimer);
  engineTimer = setInterval(() => {
    const s = engine.step();
    if (s) { lastEngineState = s; broadcast(s); }
  }, engine.cfg.tickMs);
}

async function calibrateEngine({ resume = true } = {}) {
  try {
    // 1m bars give a fine-grained read on how far ZIG moves per unit of volume
    const [zig, btc] = await Promise.all([
      fetchKlines('ZIGUSDT', '1m', 1000),
      fetchKlines('BTCUSDT', '1m', 1000),
    ]);
    if (!engine.calibrate(zig, btc, INTERVALS['1m'].sec)) {
      return console.warn('[engine] calibration skipped — no history');
    }
    const freshLambda = engine.lambda, freshVol = engine.volPerSec;

    const saved = resume && !FRESH ? readJSON(STATE_FILE) : null;
    const note = saved ? engine.restore(saved, btc[btc.length - 1].close) : null;

    if (note) {
      // keep the ledger, but re-read liquidity from today's market
      engine.lambda = freshLambda;
      engine.volPerSec = freshVol;
      const bars = readJSON(BARS_FILE);
      if (bars && Array.isArray(bars.bars)) engine.bars1m = bars.bars.slice(-engine.cfg.maxBars);
      const eq = engine.cash + engine.inv * Math.exp(engine.lnP);
      console.log(
        `[engine] RESUMED after ${note.downMin.toFixed(1)}min down — ${note.mode}` +
        (note.mode === 'reanchor' ? ` (dropped a ${note.gapBps.toFixed(0)}bps gap)` : ` (chasing ${note.gapBps.toFixed(0)}bps)`)
      );
      console.log(
        `[engine] ledger  equity=$${eq.toFixed(2)} pnl=$${(eq - engine.equity0).toFixed(2)} ` +
        `cash=$${engine.cash.toFixed(0)} inv=${engine.inv.toFixed(0)} ZIG ` +
        `fills=${engine.botTicks} bars=${engine.bars1m.length}`
      );
    } else {
      console.log(
        `[engine] FRESH RUN  capital=$${engine.cfg.capitalUSDT} ` +
        `(cash $${engine.cash.toFixed(0)} + ${engine.inv.toFixed(0)} ZIG)`
      );
    }
    console.log(
      `[engine] calibrated  lambda=${engine.lambda.toExponential(3)} /ZIG  ` +
      `depth=${engine.volPerSec.toFixed(1)} ZIG/s  ` +
      `anchor zig=${engine.anchorZig} btc=${engine.anchorBtc}`
    );
    startEngineLoop();
  } catch (err) {
    console.error('[engine] calibration failed:', err.message);
  }
}

// frequent enough that a hard kill (no clean shutdown) loses at most ~10s
setInterval(saveState, 10000);
setInterval(saveBars, 15000);

// periodic match report, so an overnight log tells you how it went
const REPORT_MIN = Number(process.env.REPORT_MIN || 30);
setInterval(() => {
  if (!engine.ready || engine.track.ticks < 60) return;
  console.log('\n' + reportText(engine.matchReport()) + '\n');
}, REPORT_MIN * 60000);

let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(engineTimer);
  saveAll();
  if (engine.ready && engine.track.ticks > 60) console.log('\n' + reportText(engine.matchReport()));
  console.log(`\n[state] saved on ${sig} — "npm start" resumes, "npm start -- --fresh" resets\n`);
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(sig, () => shutdown(sig)); } catch {}
}
process.on('exit', () => { if (!shuttingDown) saveAll(); });

// ---------------------------------------------------------------------------
// upstream MEXC protobuf websocket
// ---------------------------------------------------------------------------
let up = null;
let upstreamReady = false;
let pingTimer = null;
let backoff = 1000;
let currentKey = DEFAULT_INTERVAL;

function klineChannel(sym, key) {
  return `spot@public.kline.v3.api.pb@${sym}@${INTERVALS[key].ws}`;
}
function dealsChannel(sym) {
  return `spot@public.aggre.deals.v3.api.pb@100ms@${sym}`;
}

function connectUpstream() {
  up = new WebSocket(MEXC_WS);

  up.on('open', () => {
    console.log('[upstream] open');
    backoff = 1000;
    const params = [];
    for (const s of SYMBOLS) { params.push(klineChannel(s, currentKey)); params.push(dealsChannel(s)); }
    up.send(JSON.stringify({ method: 'SUBSCRIPTION', params }));
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (up && up.readyState === WebSocket.OPEN) up.send(JSON.stringify({ method: 'PING' }));
    }, 20000);
  });

  up.on('message', (data, isBinary) => {
    if (!isBinary) {
      // JSON acks: {"id":0,"code":0,"msg":"..."} / PONG
      try {
        const m = JSON.parse(data.toString());
        if (m.msg && m.msg !== 'PONG') console.log('[upstream] ack', m.msg);
        if (m.code && m.code !== 0) console.warn('[upstream]', m);
      } catch { /* ignore */ }
      return;
    }
    if (!Wrapper) return;
    let o;
    try {
      o = Wrapper.toObject(Wrapper.decode(data), { longs: Number, defaults: false });
    } catch (err) {
      return console.warn('[upstream] decode failed', err.message);
    }
    const symbol = o.symbol;
    if (o.publicSpotKline) {
      const k = o.publicSpotKline;
      if (symbol === 'BTCUSDT') engine.onBtcPrice(+k.closingPrice);
      broadcast({
        type: 'kline', symbol, wsInterval: k.interval,
        candle: {
          time: Number(k.windowStart),
          open: +k.openingPrice, high: +k.highestPrice,
          low: +k.lowestPrice, close: +k.closingPrice, volume: +k.volume,
        },
      });
    } else if (o.publicAggreDeals && Array.isArray(o.publicAggreDeals.deals)) {
      for (const d of o.publicAggreDeals.deals) {
        const t = {
          type: 'trade', symbol,
          price: +d.price, qty: +d.quantity,
          side: d.tradeType === 2 ? 'sell' : 'buy',
          time: Number(d.time),
        };
        // real ZIG order flow drives the sim price; real BTC price is the target
        if (symbol === 'ZIGUSDT') engine.onZigTrade(t);
        else if (symbol === 'BTCUSDT') engine.onBtcPrice(t.price);
        broadcast(t);
      }
    }
  });

  up.on('close', () => { console.warn('[upstream] closed'); teardownUpstream(); });
  up.on('error', (e) => { console.warn('[upstream] error', e.message); try { up.close(); } catch {} });
}

function teardownUpstream() {
  upstreamReady = false;
  clearInterval(pingTimer);
  broadcast({ type: 'status', upstream: false, interval: currentKey });
  setTimeout(connectUpstream, backoff);
  backoff = Math.min(backoff * 2, 15000);
}

// mark ready shortly after open (first successful ack/data)
setInterval(() => {
  const live = up && up.readyState === WebSocket.OPEN;
  if (live !== upstreamReady) {
    upstreamReady = live;
    broadcast({ type: 'status', upstream: live, interval: currentKey });
  }
}, 2000);

function changeInterval(key) {
  if (key === currentKey || !up || up.readyState !== WebSocket.OPEN) { currentKey = key; return; }
  const oldParams = SYMBOLS.map((s) => klineChannel(s, currentKey));
  const newParams = SYMBOLS.map((s) => klineChannel(s, key));
  up.send(JSON.stringify({ method: 'UNSUBSCRIPTION', params: oldParams }));
  up.send(JSON.stringify({ method: 'SUBSCRIPTION', params: newParams }));
  currentKey = key;
  console.log('[upstream] interval ->', key);
  broadcast({ type: 'status', upstream: true, interval: key });
}
