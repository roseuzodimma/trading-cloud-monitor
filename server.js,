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
===========================================================
TRADING CLOUD MONITOR
Multi-Timeframe Smart Money / Technical Signal Engine
===========================================================
*/

/* ---------------- CONFIG ---------------- */

const PAIRS = [
  "EUR/USD",
  "GBP/USD",
  "USD/CAD",
  "XAU/USD",
  "USD/CHF",
  "EUR/GBP",
  "GBP/CHF"
];

const ENTRY_TIMEFRAME = "5min";
const ONE_HOUR_TIMEFRAME = "1h";
const TWELVE_HOUR_TIMEFRAME = "12h";

/*
IMPORTANT:

The old system was hitting Twelve Data too frequently.

Default scan = every 15 minutes.

We still analyze 5-minute candles, but we do NOT hammer
the API every 5 minutes.

This greatly reduces HTTP 429 problems.
*/
const POLL_MS = Math.max(
  900000,
  Number(process.env.POLL_MS || 900000)
);

/*
1H data is refreshed every 2 hours.
12H data is refreshed every 12 hours.
*/
const ONE_HOUR_CACHE_MS = 2 * 60 * 60 * 1000;
const TWELVE_HOUR_CACHE_MS = 12 * 60 * 60 * 1000;

/*
Twelve Data free/minute limits can be strict.

We wait between requests so that we don't send 20 requests
at exactly the same second.
*/
const API_REQUEST_GAP_MS = 9500;

/* ---------------- STATE ---------------- */

const state = {
  online: true,
  alerts: true,
  lastScan: null,
  scanning: false,

  pairs: {},

  performance: {
    totalSignals: 0,
    buys: 0,
    sells: 0,
    wins: 0,
    losses: 0
  },

  lastSignalKey: {}
};

for (const pair of PAIRS) {
  state.pairs[pair] = {
    symbol: pair,
    status: "WAIT",
    score: 0,
    maxScore: 5,

    entry: null,
    stopLoss: null,
    takeProfit: null,

    message: "Waiting for market data...",
    updated: null,

    timeframes: {
      h12: null,
      h1: null,
      m5: null
    },

    analysis: {}
  };
}

/* ---------------- HELPERS ---------------- */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function now() {
  return new Date().toISOString();
}

function roundPrice(value, digits = 5) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function priceDigits(pair) {
  if (pair === "XAU/USD") return 2;

  if (
    pair.includes("JPY")
  ) {
    return 3;
  }

  return 5;
}

function getNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/* ---------------- API RATE LIMITER ---------------- */

let lastApiRequest = 0;

async function waitForApiSlot() {
  const elapsed = Date.now() - lastApiRequest;

  if (elapsed < API_REQUEST_GAP_MS) {
    await sleep(API_REQUEST_GAP_MS - elapsed);
  }

  lastApiRequest = Date.now();
}

/* ---------------- TWELVE DATA ---------------- */

async function getCandles(symbol, interval, outputsize = 100) {
  if (!API_KEY) {
    throw new Error("TWELVE_DATA_API_KEY is missing");
  }

  await waitForApiSlot();

  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${outputsize}` +
    `&apikey=${encodeURIComponent(API_KEY)}`;

  const response = await fetch(url);

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Twelve Data HTTP ${response.status}`
    );
  }

  if (
    data.status === "error" ||
    data.code
  ) {
    throw new Error(
      `Twelve Data ${data.code || ""} ${data.message || ""}`.trim()
    );
  }

  if (
    !data.values ||
    !Array.isArray(data.values) ||
    data.values.length < 30
  ) {
    throw new Error("Insufficient candle data");
  }

  return data.values
    .map(c => ({
      datetime: c.datetime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: c.volume ? Number(c.volume) : 0
    }))
    .filter(c =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    )
    .reverse();
}

/* ---------------- INDICATORS ---------------- */

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let result =
    values
      .slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result =
      (values[i] - result) * multiplier + result;
  }

  return result;
}

function emaSeries(values, period) {
  if (values.length < period) {
    return [];
  }

  const multiplier = 2 / (period + 1);

  const result = [];

  let current =
    values
      .slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  result.push(current);

  for (let i = period; i < values.length; i++) {
    current =
      (values[i] - current) * multiplier + current;

    result.push(current);
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change >= 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    averageGain =
      (averageGain * (period - 1) + gain) / period;

    averageLoss =
      (averageLoss * (period - 1) + loss) / period;
  }

  if (averageLoss === 0) return 100;

  const rs = averageGain / averageLoss;

  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (candles.length <= period) return null;

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

  if (trs.length < period) return null;

  let value =
    trs
      .slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < trs.length; i++) {
    value =
      (value * (period - 1) + trs[i]) / period;
  }

  return value;
}

/* ---------------- MARKET STRUCTURE ---------------- */

function highest(candles, count, startFromEnd = 1) {
  const end = candles.length - startFromEnd;
  const start = Math.max(0, end - count);

  let value = -Infinity;

  for (let i = start; i < end; i++) {
    value = Math.max(value, candles[i].high);
  }

  return value;
}

function lowest(candles, count, startFromEnd = 1) {
  const end = candles.length - startFromEnd;
  const start = Math.max(0, end - count);

  let value = Infinity;

  for (let i = start; i < end; i++) {
    value = Math.min(value, candles[i].low);
  }

  return value;
}

function bullishCandle(c) {
  return c.close > c.open;
}

function bearishCandle(c) {
  return c.close < c.open;
}

function candleBody(c) {
  return Math.abs(c.close - c.open);
}

function candleRange(c) {
  return c.high - c.low;
}

function upperWick(c) {
  return c.high - Math.max(c.open, c.close);
}

function lowerWick(c) {
  return Math.min(c.open, c.close) - c.low;
}

/* ---------------- REJECTION ---------------- */

function bullishRejection(c) {
  const range = candleRange(c);

  if (range <= 0) return false;

  const lower = lowerWick(c);
  const body = candleBody(c);

  return (
    lower >= body * 1.5 &&
    lower >= range * 0.35 &&
    c.close > c.low + range * 0.55
  );
}

function bearishRejection(c) {
  const range = candleRange(c);

  if (range <= 0) return false;

  const upper = upperWick(c);
  const body = candleBody(c);

  return (
    upper >= body * 1.5 &&
    upper >= range * 0.35 &&
    c.close < c.high - range * 0.55
  );
}

/* ---------------- TREND ANALYSIS ---------------- */

function analyzeTrend(candles) {
  const closes = candles.map(c => c.close);

  const current = closes[closes.length - 1];

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsiValue = rsi(closes, 14);

  if (
    ema20 === null ||
    ema50 === null ||
    rsiValue === null
  ) {
    return {
      trend: "NEUTRAL",
      rsi: null,
      ema20,
      ema50
    };
  }

  let trend = "NEUTRAL";

  if (
    current > ema20 &&
    ema20 > ema50
  ) {
    trend = "BULLISH";
  } else if (
    current < ema20 &&
    ema20 < ema50
  ) {
    trend = "BEARISH";
  }

  return {
    trend,
    rsi: Number(rsiValue.toFixed(1)),
    ema20,
    ema50
  };
}

/* ---------------- CACHE ---------------- */

function cacheValid(pair, timeframe) {
  const item = state.pairs[pair].timeframes[timeframe];

  if (!item || !item.updated) {
    return false;
  }

  const age = Date.now() - item.updated;

  if (timeframe === "h1") {
    return age < ONE_HOUR_CACHE_MS;
  }

  if (timeframe === "h12") {
    return age < TWELVE_HOUR_CACHE_MS;
  }

  return false;
}

async function getCachedHigherTF(pair, timeframe, interval) {
  if (cacheValid(pair, timeframe)) {
    return state.pairs[pair].timeframes[timeframe];
  }

  const candles = await getCandles(pair, interval, 100);

  const analysis = analyzeTrend(candles);

  const item = {
    candles,
    analysis,
    updated: Date.now()
  };

  state.pairs[pair].timeframes[timeframe] = item;

  return item;
}

/* ---------------- ENTRY ENGINE ---------------- */

function analyzeEntry(pair, candles, h1, h12) {
  if (candles.length < 60) {
    return {
      status: "WAIT",
      score: 0,
      message: "Not enough 5M candles"
    };
  }

  const digits = priceDigits(pair);

  const closes = candles.map(c => c.close);

  const current = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const currentPrice = current.close;

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);

  const rsiValue = rsi(closes, 14);
  const atrValue = atr(candles, 14);

  if (
    ema20 === null ||
    ema50 === null ||
    rsiValue === null ||
    atrValue === null
  ) {
    return {
      status: "WAIT",
      score: 0,
      message: "Calculating indicators..."
    };
  }

  /*
  Recent structure.
  We deliberately use candles BEFORE the current candle
  when looking for a breakout.
  */
  const previousHigh = highest(candles, 10, 2);
  const previousLow = lowest(candles, 10, 2);

  const bullishBreak =
    current.close > previousHigh &&
    current.close > current.open;

  const bearishBreak =
    current.close < previousLow &&
    current.close < current.open;

  const bullReject =
    bullishRejection(current) ||
    bullishRejection(previous);

  const bearReject =
    bearishRejection(current) ||
    bearishRejection(previous);

  const bullish5m =
    currentPrice > ema20 &&
    ema20 > ema50;

  const bearish5m =
    currentPrice < ema20 &&
    ema20 < ema50;

  /*
  1H direction.
  */
  const h1Trend = h1.analysis.trend;

  /*
  12H is directional context only.

  NEUTRAL does NOT automatically block a signal.
  */
  const h12Trend = h12.analysis.trend;

  let buyScore = 0;
  let sellScore = 0;

  const buyReasons = [];
  const sellReasons = [];

  /* ---------- BUY ---------- */

  if (
    h12Trend === "BULLISH"
  ) {
    buyScore++;
    buyReasons.push("12H bullish");
  }

  if (
    h1Trend === "BULLISH"
  ) {
    buyScore++;
    buyReasons.push("1H bullish");
  }

  if (
    bullish5m
  ) {
    buyScore++;
    buyReasons.push("5M trend");
  }

  if (
    bullishBreak ||
    bullReject
  ) {
    buyScore++;
    buyReasons.push(
      bullishBreak
        ? "5M breakout"
        : "bullish rejection"
    );
  }

  if (
    rsiValue >= 52 &&
    rsiValue <= 68
  ) {
    buyScore++;
    buyReasons.push("RSI confirmation");
  }

  /* ---------- SELL ---------- */

  if (
    h12Trend === "BEARISH"
  ) {
    sellScore++;
    sellReasons.push("12H bearish");
  }

  if (
    h1Trend === "BEARISH"
  ) {
    sellScore++;
    sellReasons.push("1H bearish");
  }

  if (
    bearish5m
  ) {
    sellScore++;
    sellReasons.push("5M trend");
  }

  if (
    bearishBreak ||
    bearReject
  ) {
    sellScore++;
    sellReasons.push(
      bearishBreak
        ? "5M breakout"
        : "bearish rejection"
    );
  }

  if (
    rsiValue >= 32 &&
    rsiValue <= 48
  ) {
    sellScore++;
    sellReasons.push("RSI confirmation");
  }

  /*
  =========================================================
  LATE ENTRY PROTECTION
  =========================================================

  We don't want the bot buying the very top after a huge
  candle, or selling the very bottom after a huge dump.
  */

  const distanceFromEma =
    Math.abs(currentPrice - ema20);

  const extensionTooLarge =
    distanceFromEma > atrValue * 1.5;

  const hugeBullCandle =
    bullishCandle(current) &&
    candleRange(current) > atrValue * 1.8;

  const hugeBearCandle =
    bearishCandle(current) &&
    candleRange(current) > atrValue * 1.8;

  /*
  If price is already extremely extended, remove the
  entry point rather than chasing.
  */

  if (
    buyScore >= 4 &&
    !extensionTooLarge &&
    !hugeBullCandle
  ) {
    const swingLow =
      lowest(candles, 12, 1);

    let sl =
      swingLow - atrValue * 0.25;

    /*
    Make sure SL is actually below entry.
    */
    if (sl >= currentPrice) {
      sl =
        currentPrice - atrValue * 1.2;
    }

    const risk =
      currentPrice - sl;

    const tp =
      currentPrice + risk * 2;

    return {
      status: "BUY",
      score: buyScore,
      entry: roundPrice(currentPrice, digits),
      stopLoss: roundPrice(sl, digits),
      takeProfit: roundPrice(tp, digits),

      message:
        `12H ${h12Trend} | 1H ${h1Trend} | ` +
        `RSI ${rsiValue.toFixed(1)} | ` +
        buyReasons.join(" | "),

      analysis: {
        direction: "BUY",
        h12: h12Trend,
        h1: h1Trend,
        rsi: Number(rsiValue.toFixed(1)),
        atr: roundPrice(atrValue, digits),
        breakout: bullishBreak,
        rejection: bullReject,
        extended: false
      }
    };
  }

  if (
    sellScore >= 4 &&
    !extensionTooLarge &&
    !hugeBearCandle
  ) {
    const swingHigh =
      highest(candles, 12, 1);

    let sl =
      swingHigh + atrValue * 0.25;

    if (sl <= currentPrice) {
      sl =
        currentPrice + atrValue * 1.2;
    }

    const risk =
      sl - currentPrice;

    const tp =
      currentPrice - risk * 2;

    return {
      status: "SELL",
      score: sellScore,
      entry: roundPrice(currentPrice, digits),
      stopLoss: roundPrice(sl, digits),
      takeProfit: roundPrice(tp, digits),

      message:
        `12H ${h12Trend} | 1H ${h1Trend} | ` +
        `RSI ${rsiValue.toFixed(1)} | ` +
        sellReasons.join(" | "),

      analysis: {
        direction: "SELL",
        h12: h12Trend,
        h1: h1Trend,
        rsi: Number(rsiValue.toFixed(1)),
        atr: roundPrice(atrValue, digits),
        breakout: bearishBreak,
        rejection: bearReject,
        extended: false
      }
    };
  }

  /*
  No strong signal.
  */
  let waitReason =
    `12H ${h12Trend} | 1H ${h1Trend} | ` +
    `RSI ${rsiValue.toFixed(1)} | ` +
    `Waiting for 5M confirmation`;

  if (extensionTooLarge) {
    waitReason =
      `Price extended from EMA/ATR | Waiting for pullback`;
  }

  return {
    status: "WAIT",
    score: Math.max(buyScore, sellScore),
    message: waitReason,

    analysis: {
      h12: h12Trend,
      h1: h1Trend,
      rsi: Number(rsiValue.toFixed(1)),
      buyScore,
      sellScore,
      breakout:
        bullishBreak || bearishBreak,
      rejection:
        bullReject || bearReject,
      extended: extensionTooLarge
    }
  };
}

/* ---------------- TELEGRAM ---------------- */

async function sendTelegramSignal(pair, signal) {
  if (
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {
    console.log(
      "Telegram credentials not configured."
    );
    return false;
  }

  const emoji =
    signal.status === "BUY"
      ? "🟢"
      : "🔴";

  const text =
`${emoji} STRONG ${signal.status}: ${pair}

📍 Entry: ${signal.entry}
🛑 Stop Loss: ${signal.stopLoss}
🎯 Take Profit: ${signal.takeProfit}

⭐ Score: ${signal.score}/5
📊 ${signal.message}

⏱ Timeframe: 5M
🔎 Confirmation: 1H + 12H + 5M
💰 Risk/Reward: 1:2

⚠️ Wait for the 5M candle confirmation before entering.`;

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text
        })
      }
    );

    const result = await response.json();

    if (!result.ok) {
      console.error(
        "Telegram error:",
        result
      );

      return false;
    }

    console.log(
      `Telegram signal sent: ${pair} ${signal.status}`
    );

    return true;

  } catch (error) {
    console.error(
      "Telegram connection error:",
      error.message
    );

    return false;
  }
}

/* ---------------- SIGNAL DUPLICATE PROTECTION ---------------- */

function signalKey(pair, signal) {
  return [
    pair,
    signal.status,
    signal.entry,
    signal.stopLoss,
    signal.takeProfit
  ].join("|");
}

function shouldSendSignal(pair, signal) {
  const key = signalKey(pair, signal);

  if (
    state.lastSignalKey[pair] === key
  ) {
    return false;
  }

  state.lastSignalKey[pair] = key;

  return true;
}

/* ---------------- SCAN ONE PAIR ---------------- */

async function scanPair(pair) {
  const item = state.pairs[pair];

  try {
    /*
    Fetch 5M current data.
    */
    const m5Candles =
      await getCandles(
        pair,
        ENTRY_TIMEFRAME,
        120
      );

    /*
    Fetch/cache higher timeframes.
    */
    const h1 =
      await getCachedHigherTF(
        pair,
        "h1",
        ONE_HOUR_TIMEFRAME
      );

    const h12 =
      await getCachedHigherTF(
        pair,
        "h12",
        TWELVE_HOUR_TIMEFRAME
      );

    const h1Analysis =
      h1.analysis;

    const h12Analysis =
      h12.analysis;

    const signal =
      analyzeEntry(
        pair,
        m5Candles,
        h1,
        h12
      );

    item.status =
      signal.status;

    item.score =
      signal.score || 0;

    item.entry =
      signal.entry || null;

    item.stopLoss =
      signal.stopLoss || null;

    item.takeProfit =
      signal.takeProfit || null;

    item.message =
      signal.message ||
      "Waiting for confirmation";

    item.updated =
      Date.now();

    item.timeframes = {
      h12: {
        trend: h12Analysis.trend,
        rsi: h12Analysis.rsi
      },

      h1: {
        trend: h1Analysis.trend,
        rsi: h1Analysis.rsi
      },

      m5: {
        rsi:
          signal.analysis
            ? signal.analysis.rsi
            : null
      }
    };

    item.analysis =
      signal.analysis || {};

    /*
    Only send a Telegram alert for a real 4/5 signal.
    */
    if (
      (signal.status === "BUY" ||
       signal.status === "SELL") &&
      signal.score >= 4
    ) {
      if (
        shouldSendSignal(pair, signal)
      ) {
        const sent =
          await sendTelegramSignal(
            pair,
            signal
          );

        if (sent) {
          state.performance.totalSignals++;

          if (
            signal.status === "BUY"
          ) {
            state.performance.buys++;
          }

          if (
            signal.status === "SELL"
          ) {
            state.performance.sells++;
          }
        }
    
