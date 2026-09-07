# ZIG Peg Engine

**Question it answers:** given the order flow actually hitting ZIG/USDT on MEXC
right now, how much money would it take to make ZIG track BTC's chart — and
should you keep funding it?

Two MEXC-style candlestick panels side by side:

- **BTC/USDT (right)** — 100% real MEXC spot, live.
- **ZIG/USDT SIM (left)** — a simulated price driven by **real ZIG order flow**
  plus a peg-keeper bot that trades whatever size is needed to hold BTC's shape.

Below: a dashboard with the tracking error, the ledger, the flow, and a verdict.

Nothing is ever sent to MEXC. No API keys, no orders. The connection is one-way.

## The math

All inputs are real MEXC websocket data. The model on top:

**Price impact (Kyle's lambda).** Simulated ZIG log-price moves with signed flow:

```
d ln P = λ · q_signed
```

`λ` is calibrated from **real ZIG candles** — the median of `ln(high/low) / volume`
across 1000 one-minute bars, halved (a bar's range covers a round trip). That is
this market's measured elasticity: how far it actually moves per unit traded.

**Target.** The BTC-implied price, anchored at load:

```
T(t) = anchorZig · BTC(t) / anchorBtc
```

**Control law.** Each 100 ms tick, real trades are applied first, then the bot
sizes the trade that closes the remaining gap:

```
e  = ln T − ln P
q* = gain · e / λ
```

**Constraints** — the interesting part, because these are what make it fail:

| Constraint | Meaning |
|---|---|
| `maxParticipation · volPerSec · dt` | can't trade more than a fraction of what actually trades |
| `cash / P` | can't buy without cash |
| `inventory` | spot — can't sell ZIG you don't hold |
| `minNotionalUSDT` | always allowed one small clip, so a dead market still moves |

The bot's own fills move the price too, so its impact is fed back in.

**Verdict** covers the two independent failure modes — running out of money, and
the market being too thin to move at any price:

- `STOP` — out of capital / can't fill / rms error > 150 bps / runway < 1 h
- `CAUTION` — tracking slipping (> 60 bps) or runway < 4 h
- `HOLD` — funded, tracking loose
- `ADD` — rms error < 25 bps and flow supportive

## Data plumbing

| Piece | Detail |
|---|---|
| History | `GET api.mexc.com/api/v3/klines`, paged 500 at a time (MEXC silently caps there) |
| Live kline | `wss://wbs-api.mexc.com/ws` → `spot@public.kline.v3.api.pb@<SYM>@<iv>` |
| Live trades | `spot@public.aggre.deals.v3.api.pb@100ms@<SYM>` |
| Decode | `proto/mexc.proto` (subset of `github.com/mexcdevelop/websocket-proto`) via `protobufjs` |
| Engine | `engine.js`, stepped every 100 ms **server-side** — runs at full feed speed with no browser open |
| Charts | KLineChart v9 (MEXC-style candles, MA 5/10/30/60, volume) + Lightweight Charts for the normalized strip |

## Run

```bash
npm install
npm start
```

Open <http://localhost:5173>.

Startup should look like:

```
[proto] loaded PushDataV3ApiWrapper
[engine] calibrated  lambda=2.363e-7 /ZIG  vol=13.4 ZIG/s  anchor zig=0.048697 btc=79168.31
[upstream] open
[upstream] ack spot@public.kline.v3.api.pb@...
```

Then every 15 s:

```
[feed] +15s  kline z:0 b:11  trades z:0 b:27  browsers:1  upstream:live
[peg]  sim=0.0486920 target=0.0486920 err=0.0bps (rms 0.1)  equity=$99995 ... -> ADD
```

`z:` counts are the *real* ZIG feed — they can be 0 for minutes. That's normal;
ZIG is thin. The engine consumes them as order flow.

## Tuning

`GET /api/engine` returns the current config and calibration.
`POST /api/engine` with any of these re-calibrates and restarts the run:

```bash
curl -X POST http://localhost:5173/api/engine \
  -H 'content-type: application/json' \
  -d '{"capitalUSDT":500000,"gain":0.8,"maxParticipation":1.5}'
```

| Key | Default | Effect |
|---|---|---|
| `capitalUSDT` | 100000 | starting capital |
| `splitToInventory` | 0.5 | fraction held as ZIG so the bot can also sell |
| `gain` | 0.6 | how much of the gap to close per tick |
| `maxParticipation` | 0.6 | size cap vs real volume rate — usually the binding constraint |
| `feeBps` | 5 | taker fee |
| `impactCoef` | 0.5 | scales the calibrated λ |
| `targetRunwayMin` | 60 | runway the "top up" suggestion funds |

## Files

```
server.js            REST proxy, protobuf WS bridge, engine host, static server
engine.js            PegEngine — calibration, impact model, control law, verdict
proto/mexc.proto     minimal MEXC push-frame schema
public/index.html    charts + dashboard
public/vendor/       KLineChart + Lightweight Charts, vendored (no CDN)
```

## State persistence

The run survives restarts. Two files under `state/`:

| File | Written | Holds |
|---|---|---|
| `engine.json` | every 10 s + on exit | ledger (cash, inventory, fees, fills, PnL), anchors, calibration, cumulative runtime |
| `sim-bars.json` | every 15 s + on exit | simulated 1 m OHLC bars — the chart history |

A hard kill (no clean shutdown) loses at most ~15 s.

On restart it **always re-reads the live market** — λ and depth are re-calibrated
from fresh MEXC history — while the ledger and sim bars carry over. What happens
to the BTC anchor depends on how long it was down:

- **under `maxResumeGapMin` (2 min)** — continues, and the bot chases whatever gap
  opened while it was off. A quick restart stays seamless.
- **over 2 min** — re-anchors to the current BTC price, dropping the missed move.
  The sim ZIG price itself does not jump; only the target is re-pointed at today's
  market.

```bash
npm start                  # resume
npm start -- --fresh       # ignore saved state, start clean
FRESH=1 npm start          # same, via env
```

Wipe and restart over HTTP:

```bash
curl -X POST http://localhost:5173/api/engine \
  -H 'content-type: application/json' -d '{"reset":true}'
```

The ZIG chart splices real MEXC history (before the engine first ran) with the
persisted sim bars after it, so the panel shows one continuous series across
restarts. `GET /api/sim-history?interval=1H` returns the sim bars aggregated to
any interval.

## Layout

The dashboard's top edge is a **drag handle** — pull it down for taller charts.
The `▾ dash` button in the toolbar collapses it entirely. Both are remembered in
`localStorage`. Inside a chart: scroll to zoom, drag to pan, drag the price axis
to rescale it.

## Docker

```bash
docker compose up -d --build
docker compose logs -f
```

Reachable at <http://127.0.0.1:5173> on the host. The port is published to
loopback only (`127.0.0.1:5173:5173`), so nothing is exposed to the internet —
put a reverse proxy in front, or tunnel in:

```bash
ssh -N -L 5173:127.0.0.1:5173 user@your-server   # then open localhost:5173 locally
```

`HOST` must stay `0.0.0.0` **inside** the container or the port mapping can't
reach it; the loopback restriction is done by the published-port binding.

`./state` is bind-mounted, so `docker compose down && up` resumes the run with
its ledger and bars intact. `stop_grace_period: 20s` gives the engine time to
flush state and print a final match report on SIGTERM.

```bash
docker compose restart              # resume
docker compose down && docker compose up -d
rm -rf state && docker compose up -d --force-recreate   # start clean
```

Health: `GET /healthz` returns 200 only when the engine is calibrated *and* the
MEXC websocket is connected. Compose has a healthcheck wired to it.

## Match report

The point of an overnight run. Written to the log every `REPORT_MIN` minutes
(default 30) and on shutdown, or on demand:

```bash
curl -s http://127.0.0.1:5173/api/report?format=text
curl -s http://127.0.0.1:5173/api/report          # JSON
```

```
-- how closely did it track --
rms error     0.0 bps
worst error   0.5 bps
within  25bps 100.0%

-- did it reproduce the BTC shape --
correlation   0.9871   (1.0 = identical moves, 1m log returns)
beta          0.9420   (1.0 = captured the moves fully, <1 = lagged)
captured      94.2% of the BTC move

-- why it fell short (if it did) --
depth-limited 1.0% of ticks  (market too thin to fill)
starved       0.0% of ticks  (out of cash or inventory)
```

**How to read it.** `correlation` says whether the shape matched; `beta` says
whether the *magnitude* did. `beta` well under 1 with a high `depth-limited`
percentage is the expected failure: the sim traced BTC's path but couldn't move
far enough, because ZIG only trades ~13 ZIG/s and the peg can drag it about
0.68 %/hour at 60 % participation. Correlation and beta need more than two
1-minute bars, so they read `—` on a very short run.

## Two-wallet wash trading simulation

A study of how coordinated wallets distort a tape, and how that distortion is
detected. It is a **simulation** — like everything else here it places no orders
and holds no API keys.

Capital is split 50/50 across wallet **A** and wallet **B**. Both take peg fills.
With wash enabled they also trade *with each other*:

```
A sells 10,000 ZIG to B  at the prevailing price
B sells 10,000 ZIG to A  a moment later
```

What that does to the books:

| | Effect |
|---|---|
| Combined inventory | **zero** change — value moved A→B and back |
| Reported volume | **+2 × clip** — the tape shows two fills |
| Price | **no impact** — the buy and the sell cancel |
| Fees | **real loss** — both sides pay, every time |

That third row is the whole thing. Genuine flow moves price through λ; wash
volume adds to the denominator of "impact per unit volume" and nothing to the
numerator. So an observer with **no wallet labels at all** can still estimate
the fake fraction:

```
lambdaApparent  = Σ|Δ ln P| / Σ|q|      (over detectWindowSec)
washFraction   ≈ 1 − lambdaApparent / lambdaTrue
```

### Measured, live

```
                    wash off      wash on (3/s, $40 clip)
apparent volume     $3,583        $10,504
real volume         $3,583        $3,842      <- what moved price
inflation           1.0x          2.7x
lambda ratio        ~0.84         0.0326
implied wash        0%            96.7%
verdict             CLEAN         WASH LIKELY
fees burned         $0            $6.66       <- pure cost
```

Turned up to 8 trades/sec at $60, volume inflates **385×** while the λ ratio
falls to **0.002**. The signature is not subtle: the more volume is faked, the
more obviously the impact-per-unit-volume collapses. Faking volume is cheap to
do and, on this measure, very hard to hide.

### Controls

Toolbar button `wash: off/on`, or:

```bash
curl -X POST http://127.0.0.1:5173/api/engine -H 'content-type: application/json' \
  -d '{"washEnabled":true,"washRatePerSec":3,"washClipUSDT":40}'
```

| Key | Default | Effect |
|---|---|---|
| `washEnabled` | `false` | off unless turned on |
| `washRatePerSec` | 2 | matched A↔B trades per second |
| `washClipUSDT` | 25 | notional per wash trade |
| `washJitter` | 0.4 | ± size randomisation |
| `detectWindowSec` | 300 | window for the λ detector |

Dashboard row shows apparent vs real volume, inflation multiple, implied wash
fraction, the detection flag, and per-wallet cash / inventory / peg fills /
wash fills / fees.

## Forensics: what the literature actually uses

The first version of the wash detector used only a volume-vs-impact test, which
I derived from microstructure reasoning rather than from the literature. Checked
against the field afterwards, the canonical battery is different and broader.
Cong, Li, Tang & Yang, *Crypto Wash Trading* (NBER w30783) establish three
statistical tests that run on the public tape with **no wallet identity at all**,
and the on-chain literature adds identity-based graph tests.

### Tier 1 — public tape only

| Test | Idea | Implemented |
|---|---|---|
| **Benford's law** | first significant digits of trade sizes follow `log10(1+1/d)` in genuine multiplicative processes | `benford()` — MAD, chi², plus a noise floor |
| **Round-number clustering** | humans anchor on 1/2/5 × 10ᵏ; genuine tapes spike there | `roundness()` |
| **Power-law tail** | real trade sizes have α ≈ 2–3 | `hillAlpha()` |
| **Impact divergence** | genuine flow moves price through λ; wash volume does not | `_detect()` |

### Tier 2 — requires wallet identity

| Test | Idea | Implemented |
|---|---|---|
| **Self-trade ratio** | share of fills where both sides are the operator | yes |
| **Round-trip inversion** | buyer/seller swap on consecutive trades — ~60% of NFT wash trading is exactly this two-account pattern | yes (`roundTripRate`) |
| **Repeat-buyer cycles** | same buyer acquires the same asset 3+ times | no — needs asset-level identity |
| **Common funding source** | both wallets funded by one upstream account | no — needs on-chain graph |
| **Strongly connected components** | circular flow among ≥3 wallets | no — this sim has only 2 |

### Two corrections that came out of checking

**1. Nigrini's MAD thresholds are invalid at small n.** I initially flagged any
MAD ≥ 0.015. Run against *real* MEXC tape (`/api/v3/trades`, n=201) both ZIG and
BTC score "nonconforming" purely from sampling noise:

```
ZIGUSDT  n=201  MAD=0.0459   first digits  19.9 10.9 17.4 14.4 8.5 6.0 15.9 5.5 1.5
BTCUSDT  n=201  MAD=0.0260   first digits  39.8 13.4 12.4  5.0 6.0 6.5  7.0 6.0 4.0
Benford expected                            30.1 17.6 12.5  9.7 7.9 6.7  5.8 5.1 4.6
```

So the code now requires n ≥ 300, reports `insufficient data` below n = 1000,
computes the per-sample-size noise floor, and **flags relatively** — observed
tape against the genuine subset of the same tape — rather than against absolute
cut-offs. The paper works with millions of trades per exchange; these tests are
not reliable on a few hundred.

**2. The statistical trio detects *any* algorithmic fills, not wash trading
specifically.** With wash fully off, the round-number share still falls from
34.8% (genuine flow) to 11.9% (observed) — because the peg bot's own fills are
machine-sized and never land on round numbers. That is a true positive: running
algorithmic price support is itself visible on the tape. Only the λ-divergence
and round-trip tests isolate wash trading as such.

### Measured

```
                  CLEAN        WASH 3/s      WASH 10/s
Benford MAD       0.0692       0.0617        0.0847      (genuine ~0.050)
round-number      11.9%        10.2%          8.3%       (genuine ~35%)
power-law alpha    0.93         3.28           9.95      (genuine ~1.65)
lambda ratio       0.84         0.40           0.10
round-trip rate      —          1.000          1.000
inflation          1.0x         2.1x           8.1x
flags          [roundness]  [round,power]  [benford,round,power]
```

`lambda ratio` is the cleanest wash-specific signal, and `roundTripRate = 1.000`
is conclusive once you have identity — naive two-wallet ping-pong inverts on
every single trade.

Sources: [Cong, Li, Tang & Yang — Crypto Wash Trading (NBER w30783)](https://www.nber.org/system/files/working_papers/w30783/w30783.pdf) ·
[A Game of NFTs: Characterizing NFT Wash Trading](https://arxiv.org/pdf/2212.01225) ·
[Beyond the Surface: Advanced Wash Trading Detection in Decentralized NFT Markets](https://arxiv.org/pdf/2312.16603)
