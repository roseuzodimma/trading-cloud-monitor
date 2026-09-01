
const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const API_KEY = process.env.TWELVE_DATA_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/*
=========================================================
TRADING CLOUD MONITOR
XAU/USD + GBP/JPY
=========================================================

ENGINE:

12H BIAS
   ↓
1H CONFIRMATION
   ↓
5M ENTRY CONFIRMATION
   ↓
BUY / SELL

PATCHES APPLIED TO ORIGINAL CODE:
1. Correct decimal rounding per pair
2. Separate ATR multipliers per pair
3. Fixed console logs
4. CHoCH weighted higher in scoring
5. Better Telegram message format
6. Per-pair SL/TP ATR factor
7. Signal cooldown per pair (4 hours)

=========================================================
*/

const TIMEFRAME = "5min";

const POLL_MS = Math.max(
  300000,
  Number(process.env.POLL_MS || 300000)
);

/*
=========================================================
PAIRS
=========================================================
*/

const PAIRS = [
  "XAU/USD",
  "GBP/JPY"
];

/*
=========================================================
PATCH 1 + 2 + 6 — PER PAIR CONFIG
Gold and GBP/JPY behave differently.
This is the root fix for decimals, ATR, and SL sizing.
=========================================================
*/

const PAIR_CONFIG = {
  "XAU/USD": {
    decimals: 2,        // Gold: 4421.41
    atrMultiplier: 3.5, // Gold moves big — wider extension buffer
    slAtrFactor: 1.5,   // Wider SL for Gold volatility
    label: "Gold",
    emoji: "🥇"
  },
  "GBP/JPY": {
    decimals: 3,        // GBP/JPY: 197.234
    atrMultiplier: 2.5, // Original setting
    slAtrFactor: 1.2,   // Original SL factor
    label: "GBP/JPY",
    emoji: "💴"
  }
};

/*
=========================================================
SETTINGS
=========================================================
*/

const H1_REFRESH_MS = 60 * 60 * 1000;

/*
=========================================================
PATCH 7 — SIGNAL COOLDOWN
Prevents same signal firing repeatedly.
4 hour cooldown per pair.
=========================================================
*/

const SIGNAL_COOLDOWN_MS = 4 * 60 * 60 * 1000;

let alertsEnabled = true;

/*
=========================================================
STATE
=========================================================
*/

const state = {
  online: true,
  lastScan: null,
  timeframe: TIMEFRAME,
  pairs: {},
  performance: {
    totalSignals: 0,
    buys: 0,
    sells: 0,
    wins: 0,
    losses: 0
  },
  api: {
    status: API_KEY ? "CONFIGURED" : "MISSING_API_KEY",
    totalRequests: 0,
    requestsThisScan: 0,
    lastError: null,
    cooldownUntil: null
  }
};

/*
=========================================================
PATCH 7 — COOLDOWN TRACKER
=========================================================
*/

const lastSignalTime = {};

for (const pair of PAIRS) {
  lastSignalTime[pair] = null;
}

function isSignalOnCooldown(pair) {
  const last = lastSignalTime[pair];
  if (!last) return false;
  return Date.now() - last < SIGNAL_COOLDOWN_MS;
}

function markSignalSent(pair) {
  lastSignalTime[pair] = Date.now();
}

/*
=========================================================
1H CACHE
=========================================================
*/

const h1Cache = {};

for (const pair of PAIRS) {
  h1Cache[pair] = {
    candles: null,
    updated: null
  };
}

/*
=========================================================
INITIAL STATE
=========================================================
*/

for (const pair of PAIRS) {
  state.pairs[pair] = {
    symbol: pair,
    status: "WAIT",
    score: 0,
    message: "Waiting for market data...",
    price: null,
    entry: null,
    stopLoss: null,
    takeProfit: null,
    updated: null,
    timeframes: {
      h12: {
        trend: "UNKNOWN",
        rsi: null,
        previous: "UNKNOWN",
        current: "UNKNOWN",
        previousCandle: null
      },
      h1: { trend: "UNKNOWN", rsi: null },
      m5: { trend: "UNKNOWN", rsi: null }
    },
    analysis: {
      direction: "WAIT",
      h12SMC: "UNKNOWN",
      h1SMC: "UNKNOWN",
      breakout: false,
      rejection: false,
      location: "—",
      extended: false,
      structure: "—",
      bos: "—",
      choch: "—",
      liquidity: "—"
    }
  };
}

/*
=========================================================
MARKET HOURS
=========================================================
*/

function isMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  const minutes = hour * 60 + minute;

  if (day === 6) return false;
  if (day === 0 && minutes < 22 * 60) return false;
  if (day === 5 && minutes >= 22 * 60) return false;

  return true;
}

/*
=========================================================
HELPERS
=========================================================
*/

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function average(values) {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

/*
=========================================================
PATCH 1 — FIXED: Per-pair decimal rounding
Original used toFixed(3) for everything.
Gold needs toFixed(2).
=========================================================
*/

function roundPrice(value, pair) {
  if (!Number.isFinite(value)) return null;
  const decimals = PAIR_CONFIG[pair]?.decimals ?? 3;
  return Number(value.toFixed(decimals));
}

/*
=========================================================
TWELVE DATA
=========================================================
*/

async function twelveData(symbol, interval, outputsize = 200) {
  if (!API_KEY) {
    throw new Error("TWELVE_DATA_API_KEY is missing");
  }

  if (
    state.api.cooldownUntil &&
    Date.now() < state.api.cooldownUntil
  ) {
    throw new Error("Twelve Data cooldown active");
  }

  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${outputsize}` +
    `&timezone=UTC` +
    `&apikey=${encodeURIComponent(API_KEY)}`;

  state.api.totalRequests++;

  const response = await fetch(url);

  const data = await response.json().catch(() => null);

  if (response.status === 429) {
    state.api.cooldownUntil = Date.now() + 60000;
    throw new Error("Twelve Data HTTP 429 - rate limit exceeded");
  }

  if (!response.ok) {
    throw new Error(`Twelve Data HTTP ${response.status}`);
  }

  if (data && data.status === "error") {
    throw new Error(data.message || "Twelve Data error");
  }

  if (!data || !Array.isArray(data.values)) {
    throw new Error("No candle data returned");
  }

  return data.values
    .map(candle => ({
      datetime: new Date(candle.datetime + " UTC"),
      open: num(candle.open),
      high: num(candle.high),
      low: num(candle.low),
      close: num(candle.close),
      volume: num(candle.volume)
    }))
    .filter(candle =>
      Number.isFinite(candle.open) &&
      Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) &&
      Number.isFinite(candle.close)
    )
    .sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
}

/*
=========================================================
REMOVE CURRENT INCOMPLETE CANDLE
=========================================================
*/

function getClosedCandles(candles, minutes) {
  if (!candles || !candles.length) return [];
  const now = Date.now();
  return candles.filter(candle => {
    const candleTime = candle.datetime.getTime();
    const candleEnd = candleTime + minutes * 60 * 1000;
    return candleEnd <= now;
  });
}

/*
=========================================================
BUILD COMPLETED 12H CANDLES
=========================================================
*/

function aggregate12HCandles(hourlyCandles) {
  if (!hourlyCandles || hourlyCandles.length < 24) return [];

  const closed1H = getClosedCandles(hourlyCandles, 60);
  const groups = new Map();

  for (const candle of closed1H) {
    const date = candle.datetime;
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const day = date.getUTCDate();
    const hour = date.getUTCHours();
    const half = hour < 12 ? 0 : 12;
    const key = `${year}-${month}-${day}-${half}`;

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candle);
  }

  const result = [];

  for (const candles of groups.values()) {
    candles.sort((a, b) => a.datetime.getTime() - b.datetime.getTime());

    if (candles.length !== 12) continue;

    const first = candles[0];
    const last = candles[candles.length - 1];

    result.push({
      datetime: first.datetime,
      open: first.open,
      high: Math.max(...candles.map(c => c.high)),
      low: Math.min(...candles.map(c => c.low)),
      close: last.close,
      volume: candles.reduce((sum, c) => sum + (c.volume || 0), 0)
    });
  }

  return result.sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
}

/*
=========================================================
RSI
=========================================================
*/

function calculateRSI(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/*
=========================================================
TREND
=========================================================
*/

function getTrend(candles) {
  if (!candles || candles.length < 20) return "UNKNOWN";

  const recent = candles.slice(-20);
  const fast = average(recent.slice(-5).map(c => c.close));
  const slow = average(recent.map(c => c.close));
  const first = recent[0].close;
  const last = recent[recent.length - 1].close;

  if (last > first && fast > slow) return "BULLISH";
  if (last < first && fast < slow) return "BEARISH";
  return "NEUTRAL";
}

/*
=========================================================
12H STRONGER TREND
=========================================================
*/

function get12HTrend(candles) {
  if (!candles || candles.length < 20) return "UNKNOWN";

  const closed = candles;
  const recent = closed.slice(-20);
  const closes = recent.map(c => c.close);
  const fast = average(closes.slice(-5));
  const slow = average(closes);
  const previous = closed[closed.length - 2];
  const current = closed[closed.length - 1];

  const bullishMove =
    current.close > previous.close &&
    current.high >= previous.high;

  const bearishMove =
    current.close < previous.close &&
    current.low <= previous.low;

  if (fast > slow && current.close > fast && bullishMove) return "BULLISH";
  if (fast < slow && current.close < fast && bearishMove) return "BEARISH";

  return "NEUTRAL";
}

/*
=========================================================
SWING HIGH / LOW
=========================================================
*/

function findSwingHigh(candles, index) {
  if (index < 2 || index >= candles.length - 2) return false;
  return (
    candles[index].high > candles[index - 1].high &&
    candles[index].high > candles[index - 2].high &&
    candles[index].high > candles[index + 1].high &&
    candles[index].high > candles[index + 2].high
  );
}

function findSwingLow(candles, index) {
  if (index < 2 || index >= candles.length - 2) return false;
  return (
    candles[index].low < candles[index - 1].low &&
    candles[index].low < candles[index - 2].low &&
    candles[index].low < candles[index + 1].low &&
    candles[index].low < candles[index + 2].low
  );
}

/*
=========================================================
SMC STRUCTURE
=========================================================
*/

function getStructure(candles) {
  if (!candles || candles.length < 15) {
    return { structure: "UNKNOWN", bos: "—", choch: "—", liquidity: "—" };
  }

  const highs = [];
  const lows = [];

  for (let i = 2; i < candles.length - 2; i++) {
    if (findSwingHigh(candles, i)) highs.push(candles[i]);
    if (findSwingLow(candles, i)) lows.push(candles[i]);
  }

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const previousHigh = highs.length ? highs[highs.length - 1].high : null;
  const previousLow = lows.length ? lows[lows.length - 1].low : null;

  let structure = "RANGE";
  let bos = "—";
  let choch = "—";
  let liquidity = "—";

  if (previousHigh !== null && last.close > previousHigh) {
    structure = "BULLISH";
    bos = "BULLISH";
  }

  if (previousLow !== null && last.close < previousLow) {
    structure = "BEARISH";
    bos = "BEARISH";
  }

  if (
    previousHigh !== null &&
    previous.close <= previousHigh &&
    last.close > previousHigh
  ) {
    choch = "BULLISH";
  }

  if (
    previousLow !== null &&
    previous.close >= previousLow &&
    last.close < previousLow
  ) {
    choch = "BEARISH";
  }

  if (
    previousHigh !== null &&
    last.high > previousHigh &&
    last.close < previousHigh
  ) {
    liquidity = "BUY-SIDE SWEPT";
  }

  if (
    previousLow !== null &&
    last.low < previousLow &&
    last.close > previousLow
  ) {
    liquidity = "SELL-SIDE SWEPT";
  }

  return { structure, bos, choch, liquidity };
}

/*
=========================================================
REJECTION
=========================================================
*/

function rejectionSignal(candle) {
  if (!candle) return { bullish: false, bearish: false };

  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const minimum = Math.max(body * 1.5, 0.0000001);

  return {
    bullish: lowerWick > minimum && candle.close > candle.open,
    bearish: upperWick > minimum && candle.close < candle.open
  };
}

/*
=========================================================
BREAKOUT
=========================================================
*/

function breakoutSignal(candles) {
  if (!candles || candles.length < 10) {
    return { bullish: false, bearish: false };
  }

  const current = candles[candles.length - 1];
  const previous = candles.slice(-6, -1);
  const highest = Math.max(...previous.map(c => c.high));
  const lowest = Math.min(...previous.map(c => c.low));

  return {
    bullish: current.close > highest,
    bearish: current.close < lowest
  };
}

/*
=========================================================
ATR
=========================================================
*/

function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];
    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );
    trs.push(tr);
  }

  return average(trs.slice(-period));
}

/*
=========================================================
12H ANALYSIS
=========================================================
*/

function get12HAnalysis(candles) {
  if (!candles || candles.length < 20) {
    return {
      bias: "UNKNOWN",
      trend: "UNKNOWN",
      rsi: null,
      previous: "UNKNOWN",
      current: "UNKNOWN",
      previousCandle: null,
      currentCandle: null
    };
  }

  const current = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const trend = get12HTrend(candles);
  const previousTrend = getTrend(candles.slice(0, -1));
  const currentTrend = getTrend(candles);
  const rsi = calculateRSI(candles);

  let bias = "NEUTRAL";

  if (
    trend === "BULLISH" &&
    current.close > current.open &&
    current.close > previous.close
  ) {
    bias = "BULLISH";
  }

  if (
    trend === "BEARISH" &&
    current.close < current.open &&
    current.close < previous.close
  ) {
    bias = "BEARISH";
  }

  return {
    bias,
    trend,
    rsi: rsi !== null ? Number(rsi.toFixed(1)) : null,
    previous: previousTrend,
    current: currentTrend,
    previousCandle: previous,
    currentCandle: current
  };
}

/*
=========================================================
ANALYZE PAIR
=========================================================
*/

function analyzePair(pair, h12, h1, m5) {
  if (!h12.length || !h1.length || !m5.length) {
    throw new Error("Insufficient candle data");
  }

  const closedM5 = getClosedCandles(m5, 5);
  const closedH1 = getClosedCandles(h1, 60);

  if (closedM5.length < 30) throw new Error("Not enough completed 5M candles");
  if (closedH1.length < 30) throw new Error("Not enough completed 1H candles");

  const latest = closedM5[closedM5.length - 1];
  const price = latest.close;

  /*
  PATCH 2: Get per-pair config
  */
  const config = PAIR_CONFIG[pair];

  const h12Analysis = get12HAnalysis(h12);
  const h1Trend = getTrend(closedH1);
  const h1RSI = calculateRSI(closedH1);
  const m5Trend = getTrend(closedM5);
  const m5RSI = calculateRSI(closedM5);
  const h12Structure = getStructure(h12);
  const h1Structure = getStructure(closedH1);
  const m5Structure = getStructure(closedM5);
  const rejection = rejectionSignal(latest);
  const breakout = breakoutSignal(closedM5);

  let buyScore = 0;
  let sellScore = 0;

  if (h12Analysis.bias === "BULLISH") buyScore += 2;
  if (h12Analysis.bias === "BEARISH") sellScore += 2;

  if (h1Trend === "BULLISH") buyScore++;
  if (h1Trend === "BEARISH") sellScore++;

  if (m5Trend === "BULLISH") buyScore++;
  if (m5Trend === "BEARISH") sellScore++;

  if (m5RSI !== null && m5RSI >= 50 && m5RSI <= 68) buyScore++;
  if (m5RSI !== null && m5RSI <= 50 && m5RSI >= 32) sellScore++;

  const bullishSMC =
    m5Structure.bos === "BULLISH" ||
    m5Structure.choch === "BULLISH" ||
    breakout.bullish ||
    rejection.bullish;

  const bearishSMC =
    m5Structure.bos === "BEARISH" ||
    m5Structure.choch === "BEARISH" ||
    breakout.bearish ||
    rejection.bearish;

  /*
  PATCH 4: CHoCH gets extra weight
  It is the most important SMC signal
  */
  if (m5Structure.choch === "BULLISH") buyScore++;
  if (m5Structure.choch === "BEARISH") sellScore++;

  if (bullishSMC) buyScore++;
  if (bearishSMC) sellScore++;

  buyScore = Math.min(5, buyScore);
  sellScore = Math.min(5, sellScore);

  let status = "WAIT";
  let score = Math.max(buyScore, sellScore);

  if (
    buyScore >= 4 &&
    h12Analysis.bias === "BULLISH" &&
    h1Trend === "BULLISH" &&
    (bullishSMC || m5Trend === "BULLISH")
  ) {
    status = "BUY";
  }

  if (
    sellScore >= 4 &&
    h12Analysis.bias === "BEARISH" &&
    h1Trend === "BEARISH" &&
    (bearishSMC || m5Trend === "BEARISH")
  ) {
    status = "SELL";
  }

  const atr = calculateATR(closedM5);
  let extended = false;

  if (atr !== null) {
    const reference = closedM5[Math.max(0, closedM5.length - 6)];
    const distance = Math.abs(price - reference.open);

    /*
    PATCH 2: Per-pair ATR multiplier
    Gold = 3.5, GBP/JPY = 2.5
    */
    if (distance > atr * config.atrMultiplier) {
      extended = true;
      status = "WAIT";
    }
  }

  let entry = null;
  let stopLoss = null;
  let takeProfit = null;

  if (status === "BUY" && atr !== null) {
    entry = price;
    /*
    PATCH 6: Per-pair SL factor
    Gold = 1.5, GBP/JPY = 1.2
    */
    stopLoss = Math.min(latest.low, price - atr * config.slAtrFactor);
    const risk = entry - stopLoss;
    if (risk > 0) takeProfit = entry + risk * 2;
  }

  if (status === "SELL" && atr !== null) {
    entry = price;
    /*
    PATCH 6: Per-pair SL factor
    */
    stopLoss = Math.max(latest.high, price + atr * config.slAtrFactor);
    const risk = stopLoss - entry;
    if (risk > 0) takeProfit = entry - risk * 2;
  }

  let location = "NEUTRAL";

  if (status === "BUY") {
    if (rejection.bullish) location = "BULLISH REJECTION";
    else if (breakout.bullish) location = "BULLISH BREAKOUT";
    else if (m5Structure.choch === "BULLISH") location = "CHoCH BULLISH";
    else if (m5Structure.bos === "BULLISH") location = "BULLISH BOS";
    else location = "BULLISH STRUCTURE";
  }

  if (status === "SELL") {
    if (rejection.bearish) location = "BEARISH REJECTION";
    else if (breakout.bearish) location = "BEARISH BREAKOUT";
    else if (m5Structure.choch === "BEARISH") location = "CHoCH BEARISH";
    else if (m5Structure.bos === "BEARISH") location = "BEARISH BOS";
    else location = "BEARISH STRUCTURE";
  }

  let message =
    `12H ${h12Analysis.bias} | ` +
    `1H ${h1Trend} | ` +
    `5M ${m5Trend} | ` +
    `RSI ${m5RSI !== null ? m5RSI.toFixed(1) : "—"}`;

  if (status === "BUY") message += " | BUY confirmation";
  if (status === "SELL") message += " | SELL confirmation";
  if (extended) message = "Move extended — waiting for pullback/confirmation";

  return {
    symbol: pair,
    status,
    score,
    message,
    /*
    PATCH 1: roundPrice now takes pair as second argument
    */
    price: roundPrice(price, pair),
    entry: roundPrice(entry, pair),
    stopLoss: roundPrice(stopLoss, pair),
    takeProfit: roundPrice(takeProfit, pair),
    updated: new Date().toISOString(),
    timeframes: {
      h12: {
        trend: h12Analysis.bias,
        rsi: h12Analysis.rsi,
        previous: h12Analysis.previous,
        current: h12Analysis.current,
        previousCandle: h12Analysis.previousCandle
          ? {
              open: h12Analysis.previousCandle.open,
              high: h12Analysis.previousCandle.high,
              low: h12Analysis.previousCandle.low,
              close: h12Analysis.previousCandle.close
            }
          : null
      },
      h1: {
        trend: h1Trend,
        rsi: h1RSI !== null ? Number(h1RSI.toFixed(1)) : null
      },
      m5: {
        trend: m5Trend,
        rsi: m5RSI !== null ? Number(m5RSI.toFixed(1)) : null
      }
    },
    analysis: {
      direction: status,
      h12SMC: h12Structure.structure,
      h1SMC: h1Structure.structure,
      breakout: breakout.bullish || breakout.bearish,
      rejection: rejection.bullish || rejection.bearish,
      location,
      extended,
      structure: m5Structure.structure,
      bos: m5Structure.bos,
      choch: m5Structure.choch,
      liquidity: m5Structure.liquidity
    }
  };
}

/*
=========================================================
PATCH 5 — BETTER TELEGRAM FORMAT
=========================================================
*/

async function sendTelegramSignal(signal) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !alertsEnabled) return;
  if (signal.status !== "BUY" && signal.status !== "SELL") return;

  const config = PAIR_CONFIG[signal.symbol];
  const dirEmoji = signal.status === "BUY" ? "🟢" : "🔴";
  const arrow = signal.status === "BUY" ? "⬆" : "⬇";

  const text =
`${dirEmoji} ${signal.status} SIGNAL — ${config.emoji} ${config.label}
${arrow} ${signal.status} @ ${signal.entry}

━━━━━━━━━━━━━━━━
📍 Entry:       ${signal.entry}
🛑 Stop Loss:   ${signal.stopLoss}
🎯 Take Profit: ${signal.takeProfit}
💰 Risk/Reward: 1:2
━━━━━━━━━━━━━━━━

⭐ Signal Score: ${signal.score}/5

📊 TIMEFRAME ALIGNMENT
   12H → ${signal.timeframes.h12.trend}
   1H  → ${signal.timeframes.h1.trend}
   5M  → ${signal.timeframes.m5.trend}

📈 SMC ANALYSIS
   Structure : ${signal.analysis.structure}
   BOS       : ${signal.analysis.bos}
   CHoCH     : ${signal.analysis.choch}
   Liquidity : ${signal.analysis.liquidity}
   Location  : ${signal.analysis.location}

🔢 RSI (5M): ${signal.timeframes.m5.rsi ?? "—"}

━━━━━━━━━━━━━━━━
⚠ ALERT ONLY — NOT A TRADE ORDER
Verify your full checklist on the
chart before entering any trade.
━━━━━━━━━━━━━━━━`;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
    });

    if (!response.ok) {
      console.error("Telegram HTTP error:", response.status);
    }
  } catch (error) {
    console.error("Telegram error:", error.message);
  }
}

/*
=========================================================
MARKET CLOSED
=========================================================
*/

function setMarketClosed(pair) {
  const result = state.pairs[pair];
  result.status = "WAIT";
  result.score = 0;
  result.message = "Market closed — monitoring will resume when the market opens.";
  result.price = null;
  result.entry = null;
  result.stopLoss = null;
  result.takeProfit = null;
  result.updated = new Date().toISOString();
  result.timeframes = {
    h12: { trend: "MARKET CLOSED", rsi: null, previous: "UNKNOWN", current: "UNKNOWN", previousCandle: null },
    h1: { trend: "MARKET CLOSED", rsi: null },
    m5: { trend: "MARKET CLOSED", rsi: null }
  };
  result.analysis = {
    direction: "WAIT",
    h12SMC: "MARKET CLOSED",
    h1SMC: "MARKET CLOSED",
    breakout: false,
    rejection: false,
    location: "MARKET CLOSED",
    extended: false,
    structure: "—",
    bos: "—",
    choch: "—",
    liquidity: "—"
  };
}

/*
=========================================================
GET 1H DATA
=========================================================
*/

async function getHourlyData(pair) {
  const cached = h1Cache[pair];
  const now = Date.now();

  if (
    cached.candles &&
    cached.updated &&
    now - cached.updated < H1_REFRESH_MS
  ) {
    console.log(`[${pair}] Using cached 1H data`);
    return cached.candles;
  }

  console.log(`[${pair}] Refreshing 1H data`);
  const hourly = await twelveData(pair, "1h", 300);
  state.api.requestsThisScan++;
  cached.candles = hourly;
  cached.updated = now;
  return hourly;
}

/*
=========================================================
SCAN PAIR
=========================================================
*/

async function scanPair(pair) {
  const result = state.pairs[pair];
  result.updated = new Date().toISOString();

  if (!isMarketOpen()) {
    setMarketClosed(pair);
    return;
  }

  try {
    const hourly = await getHourlyData(pair);
    const h12 = aggregate12HCandles(hourly);
    const h1 = getClosedCandles(hourly, 60).slice(-150);
    const m5 = await twelveData(pair, "5min", 150);
    state.api.requestsThisScan++;

    if (h12.length < 20) throw new Error(`Not enough COMPLETED 12H candles: ${h12.length}`);
    if (h1.length < 30) throw new Error(`Not enough COMPLETED 1H candles: ${h1.length}`);
    if (m5.length < 30) throw new Error("Not enough 5M candles");

    const signal = analyzePair(pair, h12, h1, m5);
    const oldStatus = result.status;

    const isNewBuy = signal.status === "BUY" && oldStatus !== "BUY";
    const isNewSell = signal.status === "SELL" && oldStatus !== "SELL";

    /*
    PATCH 7: Only send if not on cooldown
    */
    if ((isNewBuy || isNewSell) && !isSignalOnCooldown(pair)) {
      if (isNewBuy) {
        state.performance.totalSignals++;
        state.performance.buys++;
      }
      if (isNewSell) {
        state.performance.totalSignals++;
        state.performance.sells++;
      }
      await sendTelegramSignal(signal);
      markSignalSent(pair);
    }

    state.pairs[pair] = signal;

    console.log(`[${pair}] ${signal.status} | Score ${signal.score}/5 | ${signal.message}`);

  } catch (error) {
    console.error(`[${pair}]`, error.message);
    result.status = "OFFLINE";
    result.score = 0;
    result.message = error.message;
    result.updated = new Date().toISOString();
    result.price = null;
    result.entry = null;
    result.stopLoss = null;
    result.takeProfit = null;
    state.api.lastError = `${pair}: ${error.message}`;
  }
}

/*
=========================================================
SCAN ALL — PATCH 3: Fixed log message
=========================================================
*/

async function scanAll() {
  state.api.requestsThisScan = 0;
  state.api.lastError = null;

  console.log("====================================");
  console.log(`[SCAN] ${new Date().toISOString()}`);
  console.log("[SCAN] XAU/USD + GBP/JPY");  // PATCH 3 — was "GBP/JPY ONLY"
  console.log(`[SCAN] Market: ${isMarketOpen() ? "OPEN" : "CLOSED"}`);

  if (!isMarketOpen()) {
    for (const pair of PAIRS) setMarketClosed(pair);
    state.lastScan = new Date().toISOString();
    return;
  }

  for (const pair of PAIRS) {
    await scanPair(pair);
    await sleep(2000); // 2s gap to avoid rate limits with 2 pairs
  }

  state.lastScan = new Date().toISOString();

  console.log(`[SCAN COMPLETE] Requests this scan: ${state.api.requestsThisScan}`);
  console.log(`[TOTAL API REQUESTS] ${state.api.totalRequests}`);
  console.log("====================================");
}

/*
=========================================================
API ROUTES — unchanged from original
=========================================================
*/

app.get("/api/status", (req, res) => {
  const marketOpen = isMarketOpen();
  res.json({
    online: state.online,
    marketOpen,
    marketStatus: marketOpen ? "OPEN" : "CLOSED",
    alerts: alertsEnabled,
    lastScan: state.lastScan,
    timeframe: state.timeframe,
    pairs: state.pairs,
    performance: state.performance,
    api: state.api
  });
});

app.get("/api/alerts", (req, res) => {
  res.json({ ok: true, enabled: alertsEnabled, alerts: alertsEnabled });
});

app.post("/api/alerts", (req, res) => {
  alertsEnabled = Boolean(req.body.enabled);
  res.json({ ok: true, enabled: alertsEnabled, alerts: alertsEnabled });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    pairs: PAIRS,
    marketOpen: isMarketOpen(),
    marketStatus: isMarketOpen() ? "OPEN" : "CLOSED",
    time: new Date().toISOString()
  });
});

app.get("/api", (req, res) => {
  res.json({
    name: "Trading Cloud Monitor",
    status: "online",
    pairs: PAIRS,
    marketOpen: isMarketOpen(),
    engine: "12H + 1H + 5M",
    smc: true,
    rsi: true,
    h1Cache: true,
    completed12H: true,
    extensionProtection: true,
    riskReward: "1:2",
    message: "XAU/USD + GBP/JPY signal engine running"
  });
});

/*
=========================================================
START SERVER
=========================================================
*/

app.listen(PORT, async () => {
  console.log("====================================");
  console.log("TRADING CLOUD MONITOR");
  console.log("XAU/USD + GBP/JPY SIGNAL ENGINE");
  console.log(`Server running on port ${PORT}`);
  console.log(`Market: ${isMarketOpen() ? "OPEN" : "CLOSED"}`);
  console.log(`API Key: ${API_KEY ? "CONFIGURED" : "MISSING"}`);
  console.log("====================================");
  console.log("PAIRS:");
  console.log("- XAU/USD (Gold)  | 2dp | ATR x3.5 | SL x1.5");
  console.log("- GBP/JPY         | 3dp | ATR x2.5 | SL x1.2");
  console.log("====================================");
  console.log("PATCHES APPLIED:");
  console.log("1. Per-pair decimal rounding");
  console.log("2. Per-pair ATR extension multiplier");
  console.log("3. Fixed scan logs");
  console.log("4. CHoCH weighted higher");
  console.log("5. Better Telegram format");
  console.log("6. Per-pair SL ATR factor");
  console.log("7. Signal cooldown (4H per pair)");
  console.log("====================================");
  console.log("ENGINE: 12H + 1H + 5M");
  console.log("SMC: BOS + CHoCH + LIQUIDITY");
  console.log("RISK/REWARD: 1:2");
  console.log("====================================");
  console.log("Telegram:", TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? "CONFIGURED" : "NOT CONFIGURED");
  console.log("====================================");

  try {
    await scanAll();
  } catch (error) {
    console.error("Initial scan error:", error.message);
  }

  setInterval(async () => {
    try {
      await scanAll();
    } catch (error) {
      console.error("Scan loop error:", error.message);
    }
  }, POLL_MS);
});

