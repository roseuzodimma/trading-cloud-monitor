const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const API_KEY = process.env.TWELVE_DATA_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const TIMEFRAME = "5min";
const POLL_MS = Math.max(
  300000,
  Number(process.env.POLL_MS || 300000)
);

// ============================================================
// PAIRS
// ============================================================

const PAIRS = [
  "EUR/USD",
  "GBP/USD",
  "USD/CAD",
  "XAU/USD",
  "USD/CHF",
  "EUR/GBP",
  "GBP/CHF"
];

// ============================================================
// STATE
// ============================================================

const state = {
  online: true,
  alerts: true,
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
    status: API_KEY ? "READY" : "NO_API_KEY",
    totalRequests: 0,
    requestsThisScan: 0,
    lastError: null,
    cooldownUntil: null
  }
};

const lastAlert = {};
const lastSignal = {};

// ============================================================
// MARKET HOURS
// ============================================================

function isForexMarketOpen() {
  const now = new Date();

  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();

  const minutes = hour * 60 + minute;

  // Saturday
  if (day === 6) return false;

  // Sunday before 22:00 UTC
  if (day === 0 && minutes < 22 * 60) {
    return false;
  }

  // Friday after 22:00 UTC
  if (day === 5 && minutes >= 22 * 60) {
    return false;
  }

  return true;
}

function isGoldMarketOpen() {
  return isForexMarketOpen();
}

// ============================================================
// FETCH TWELVE DATA
// ============================================================

async function twelveData(symbol, interval, outputsize = 100) {
  if (!API_KEY) {
    throw new Error("TWELVE_DATA_API_KEY is missing");
  }

  if (
    state.api.cooldownUntil &&
    Date.now() < new Date(state.api.cooldownUntil).getTime()
  ) {
    throw new Error("Twelve Data cooldown active");
  }

  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${outputsize}` +
    `&apikey=${encodeURIComponent(API_KEY)}`;

  state.api.totalRequests++;

  const response = await fetch(url);

  if (response.status === 429) {
    const cooldown = Date.now() + 5 * 60 * 1000;

    state.api.cooldownUntil =
      new Date(cooldown).toISOString();

    state.api.lastError =
      "HTTP 429 rate limit";

    throw new Error("Twelve Data HTTP 429");
  }

  if (!response.ok) {
    throw new Error(
      `Twelve Data HTTP ${response.status}`
    );
  }

  const data = await response.json();

  if (data.status === "error") {
    throw new Error(
      data.message || "Twelve Data error"
    );
  }

  if (!Array.isArray(data.values)) {
    throw new Error("No candle data returned");
  }

  return data.values
    .map(c => ({
      datetime: c.datetime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    }))
    .reverse();
}

// ============================================================
// INDICATORS
// ============================================================

function calculateRSI(candles, period = 14) {
  if (candles.length < period + 1) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change =
      candles[i].close -
      candles[i - 1].close;

    if (change >= 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (
    let i = period + 1;
    i < candles.length;
    i++
  ) {
    const change =
      candles[i].close -
      candles[i - 1].close;

    const gain =
      change > 0 ? change : 0;

    const loss =
      change < 0 ? Math.abs(change) : 0;

    avgGain =
      (avgGain * (period - 1) + gain) /
      period;

    avgLoss =
      (avgLoss * (period - 1) + loss) /
      period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs = avgGain / avgLoss;

  return Number(
    (100 - 100 / (1 + rs)).toFixed(1)
  );
}

// ============================================================
// ATR
// ============================================================

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) {
    return null;
  }

  const ranges = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const tr = Math.max(
      current.high - current.low,
      Math.abs(
        current.high - previous.close
      ),
      Math.abs(
        current.low - previous.close
      )
    );

    ranges.push(tr);
  }

  const recent =
    ranges.slice(-period);

  if (!recent.length) {
    return null;
  }

  return (
    recent.reduce(
      (a, b) => a + b,
      0
    ) / recent.length
  );
}

// ============================================================
// TREND
// ============================================================

function getTrend(candles) {
  if (candles.length < 20) {
    return "NEUTRAL";
  }

  const recent =
    candles.slice(-10);

  const first =
    recent[0].close;

  const last =
    recent[recent.length - 1].close;

  const change =
    ((last - first) / first) * 100;

  if (change > 0.12) {
    return "BULLISH";
  }

  if (change < -0.12) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

// ============================================================
// 12H BIAS
// ============================================================
//
// IMPORTANT:
// The final CLOSED 12H candle determines the stable bias.
//
// The currently-forming 12H candle is also examined separately.
// It can be:
// BULLISH DEVELOPING
// BEARISH DEVELOPING
// NEUTRAL DEVELOPING
//
// But it does NOT immediately replace the confirmed bias.
// This prevents the dashboard from flipping every few minutes.
// ============================================================

function get12HBias(candles) {
  if (candles.length < 30) {
    return {
      confirmed: "NEUTRAL",
      developing: "NEUTRAL",
      strength: 0,
      rsi: null,
      candleAgeHours: 0
    };
  }

  const closed = candles.slice(0, -1);
  const current = candles[candles.length - 1];

  const confirmedCandles =
    closed.slice(-20);

  const confirmedTrend =
    getTrend(confirmedCandles);

  const rsi =
    calculateRSI(closed);

  const previous =
    closed[closed.length - 1];

  const currentMove =
    previous.close !== 0
      ? ((current.close - previous.close) /
          previous.close) *
        100
      : 0;

  let developing =
    "NEUTRAL";

  if (currentMove > 0.08) {
    developing = "BULLISH";
  } else if (currentMove < -0.08) {
    developing = "BEARISH";
  }

  let strength = 0;

  if (confirmedTrend === "BULLISH") {
    strength = 1;
  }

  if (confirmedTrend === "BEARISH") {
    strength = -1;
  }

  if (
    confirmedTrend === "BULLISH" &&
    developing === "BULLISH"
  ) {
    strength = 2;
  }

  if (
    confirmedTrend === "BEARISH" &&
    developing === "BEARISH"
  ) {
    strength = -2;
  }

  return {
    confirmed: confirmedTrend,
    developing,
    strength,
    rsi
  };
}

// ============================================================
// REJECTION
// ============================================================

function bullishRejection(candle) {
  if (!candle) return false;

  const body =
    Math.abs(
      candle.close - candle.open
    );

  const lowerWick =
    Math.min(
      candle.open,
      candle.close
    ) - candle.low;

  return (
    lowerWick > body * 1.2 &&
    candle.close >= candle.open
  );
}

function bearishRejection(candle) {
  if (!candle) return false;

  const body =
    Math.abs(
      candle.close - candle.open
    );

  const upperWick =
    candle.high -
    Math.max(
      candle.open,
      candle.close
    );

  return (
    upperWick > body * 1.2 &&
    candle.close <= candle.open
  );
}

// ============================================================
// BREAKOUT
// ============================================================

function bullishBreakout(candles) {
  if (candles.length < 8) {
    return false;
  }

  const current =
    candles[candles.length - 1];

  const previous =
    candles.slice(-7, -1);

  const resistance =
    Math.max(
      ...previous.map(c => c.high)
    );

  return current.close > resistance;
}

function bearishBreakout(candles) {
  if (candles.length < 8) {
    return false;
  }

  const current =
    candles[candles.length - 1];

  const previous =
    candles.slice(-7, -1);

  const support =
    Math.min(
      ...previous.map(c => c.low)
    );

  return current.close < support;
}

// ============================================================
// STRUCTURE
// ============================================================

function structure(candles) {
  if (candles.length < 10) {
    return "NEUTRAL";
  }

  const recent =
    candles.slice(-10);

  const highs =
    recent.map(c => c.high);

  const lows =
    recent.map(c => c.low);

  const last =
    recent[recent.length - 1];

  const previousHigh =
    Math.max(...highs.slice(0, -1));

  const previousLow =
    Math.min(...lows.slice(0, -1));

  if (
    last.close > previousHigh
  ) {
    return "BULLISH";
  }

  if (
    last.close < previousLow
  ) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

// ============================================================
// EXTENDED CHECK
// ============================================================

function isExtended(candles, atr) {
  if (!atr || candles.length < 10) {
    return false;
  }

  const recent =
    candles.slice(-5);

  const move =
    Math.abs(
      recent[recent.length - 1].close -
      recent[0].close
    );

  return move > atr * 2.5;
}

// ============================================================
// ANALYZE PAIR
// ============================================================

async function analyzePair(symbol) {
  const marketOpen =
    symbol === "XAU/USD"
      ? isGoldMarketOpen()
      : isForexMarketOpen();

  if (!marketOpen) {
    return {
      symbol,
      status: "WAIT",
      score: 0,
      message:
        "Market closed — no trading signal will be generated.",
      price: null,
      entry: null,
      stopLoss: null,
      takeProfit: null,
      timeframes: {
        h12: {
          trend: "MARKET CLOSED",
          rsi: null
        },
        h1: {
          trend: "MARKET CLOSED",
          rsi: null
        },
        m5: {
          trend: "MARKET CLOSED",
          rsi: null
        }
      },
      analysis: {
        h12SMC: "MARKET CLOSED",
        h1SMC: "MARKET CLOSED",
        breakout: false,
        rejection: false,
        location: "MARKET CLOSED",
        extended: false
      },
      updated: new Date().toISOString()
    };
  }

  const h12 = await twelveData(
    symbol,
    "12h",
    80
  );

  const h1 = await twelveData(
    symbol,
    "1h",
    100
  );

  const m5 = await twelveData(
    symbol,
    "5min",
    100
  );

  const h12Info =
    get12HBias(h12);

  const h1Trend =
    getTrend(h1);

  const m5Trend =
    getTrend(m5);

  const h1RSI =
    calculateRSI(h1);

  const m5RSI =
    calculateRSI(m5);

  const atr =
    calculateATR(m5);

  const current =
    m5[m5.length - 1];

  const previous =
    m5[m5.length - 2];

  const h1Structure =
    structure(h1);

  const m5Structure =
    structure(m5);

  const buyBreakout =
    bullishBreakout(m5);

  const sellBreakout =
    bearishBreakout(m5);

  const buyReject =
    bullishRejection(previous);

  const sellReject =
    bearishRejection(previous);

  const extended =
    isExtended(m5, atr);

  let buyScore = 0;
  let sellScore = 0;

  // ==========================================================
  // 12H CONFIRMATION
  // ==========================================================

  if (
    h12Info.confirmed === "BULLISH"
  ) {
    buyScore++;
  }

  if (
    h12Info.confirmed === "BEARISH"
  ) {
    sellScore++;
  }

  // ==========================================================
  // 1H CONFIRMATION
  // ==========================================================

  if (
    h1Trend === "BULLISH"
  ) {
    buyScore++;
  }

  if (
    h1Trend === "BEARISH"
  ) {
    sellScore++;
  }

  // ==========================================================
  // 5M TREND
  // ==========================================================

  if (
    m5Trend === "BULLISH"
  ) {
    buyScore++;
  }

  if (
    m5Trend === "BEARISH"
  ) {
    sellScore++;
  }

  // ==========================================================
  // RSI
  // ==========================================================

  if (
    m5RSI !== null &&
    m5RSI >= 50 &&
    m5RSI <= 68
  ) {
    buyScore++;
  }

  if (
    m5RSI !== null &&
    m5RSI < 50 &&
    m5RSI >= 32
  ) {
    sellScore++;
  }

  // ==========================================================
  // BREAKOUT / REJECTION
  // ==========================================================

  if (buyBreakout || buyReject) {
    buyScore++;
  }

  if (sellBreakout || sellReject) {
    sellScore++;
  }

  // ==========================================================
  // DO NOT ENTER EXTENDED MOVES
  // ==========================================================

  if (extended) {
    buyScore = Math.max(
      0,
      buyScore - 1
    );

    sellScore = Math.max(
      0,
      sellScore - 1
    );
  }

  let status = "WAIT";

  if (
    buyScore >= 4 &&
    buyScore > sellScore &&
    h12Info.confirmed === "BULLISH" &&
    h1Trend === "BULLISH"
  ) {
    status = "BUY";
  }

  if (
    sellScore >= 4 &&
    sellScore > buyScore &&
    h12Info.confirmed === "BEARISH" &&
    h1Trend === "BEARISH"
  ) {
    status = "SELL";
  }

  // ==========================================================
  // PRICE / SL / TP
  // ==========================================================

  let entry = null;
  let stopLoss = null;
  let takeProfit = null;

  if (
    status === "BUY" &&
    atr
  ) {
    entry = current.close;

    stopLoss =
      Math.min(
        previous.low,
        entry - atr * 1.2
      );

    const risk =
      entry - stopLoss;

    takeProfit =
      entry + risk * 2;
  }

  if (
    status === "SELL" &&
    atr
  ) {
    entry = current.close;

    stopLoss =
      Math.max(
        previous.high,
        entry + atr * 1.2
      );

    const risk =
      stopLoss - entry;

    takeProfit =
      entry - risk * 2;
  }

  const detail =
    `${h12Info.confirmed} 12H | ` +
    `${h1Trend} 1H | ` +
    `${m5Trend} 5M | ` +
    `RSI ${m5RSI ?? "—"} | ` +
    `12H developing ${h12Info.developing}`;

  return {
    symbol,
    status,
    score:
      status === "BUY"
        ? buyScore
        : status === "SELL"
          ? sellScore
          : Math.max(
              buyScore,
              sellScore
            ),

    message:
      status === "BUY"
        ? "Bullish 12H + 1H alignment with 5M entry confirmation."
        : status === "SELL"
          ? "Bearish 12H + 1H alignment with 5M entry confirmation."
          : "Waiting for 12H + 1H + 5M confirmation.",

    detail,

    price: current.close,

    entry,
    stopLoss,
    takeProfit,

    timeframes: {
      h12: {
        trend:
          h12Info.confirmed,
        developing:
          h12Info.developing,
        rsi:
          h12Info.rsi
      },

      h1: {
        trend: h1Trend,
        rsi: h1RSI
      },

      m5: {
        trend: m5Trend,
        rsi: m5RSI
      }
    },

    analysis: {
      h12SMC:
        h12Info.confirmed,

      h1SMC:
        h1Structure,

      breakout:
        buyBreakout ||
        sellBreakout,

      rejection:
        buyReject ||
        sellReject,

      location:
        extended
          ? "EXTENDED"
          : "NORMAL",

      extended
    },

    updated:
      new Date().toISOString()
  };
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(message) {
  if (
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {
    return;
  }

  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  await fetch(url, {
    method: "POST",

    headers: {
      "Content-Type":
        "application/json"
    },

    body: JSON.stringify({
      chat_id:
        TELEGRAM_CHAT_ID,

      text: message
    })
  });
}

// ============================================================
// SIGNAL MESSAGE
// ============================================================

function buildTelegramMessage(x) {
  const icon =
    x.status === "BUY"
      ? "🟢"
      : "🔴";

  const signal =
    x.status === "BUY"
      ? "STRONG BUY"
      : "STRONG SELL";

  const rr = "1:2";

  return (
`${icon} ${signal}: ${x.symbol}

📍 Entry: ${x.entry}
🛑 Stop Loss: ${x.stopLoss}
🎯 Take Profit: ${x.takeProfit}

⭐ Score: ${x.score}/5
📊 ${x.detail}

⏱ Entry TF: 5M
🔎 Confirmation: 1H + 12H + 5M
💰 Risk/Reward: ${rr}

⚠️ Signal confirmation required before entry.`
  );
}

// ============================================================
// PROCESS SIGNAL
// ============================================================

async function processSignal(x) {
  if (
    !state.alerts ||
    x.status === "WAIT"
  ) {
    return;
  }

  if (
    !isForexMarketOpen()
  ) {
    return;
  }

  if (
    x.symbol === "XAU/USD" &&
    !isGoldMarketOpen()
  ) {
    return;
  }

  const key =
    x.symbol;

  const signalKey =
    `${x.status}-${x.entry}-${x.stopLoss}-${x.takeProfit}`;

  if (
    lastSignal[key] === signalKey
  ) {
    return;
  }

  const now =
    Date.now();

  if (
    lastAlert[key] &&
    now - lastAlert[key] <
      30 * 60 * 1000
  ) {
    return;
  }

  lastSignal[key] =
    signalKey;

  lastAlert[key] =
    now;

  state.performance.totalSignals++;

  if (x.status === "BUY") {
    state.performance.buys++;
  }

  if (x.status === "SELL") {
    state.performance.sells++;
  }

  try {
    await sendTelegram(
      buildTelegramMessage(x)
    );
  } catch (error) {
    console.error(
      "Telegram error:",
      error.message
    );
  }
}

// ============================================================
// SCAN
// ============================================================

async function scan() {
  state.api.requestsThisScan = 0;

  if (!API_KEY) {
    state.online = false;

    state.api.status =
      "NO_API_KEY";

    return;
  }

  const marketOpen =
    isForexMarketOpen();

  if (!marketOpen) {
    for (const symbol of PAIRS) {
      state.pairs[symbol] = {
        symbol,
        status: "WAIT",
        score: 0,
        message:
          "Market closed — monitoring will resume when the market opens.",
        price: null,
        entry: null,
        stopLoss: null,
        takeProfit: null,

        timeframes: {
          h12: {
            trend: "MARKET CLOSED",
            rsi: null
          },

          h1: {
            trend: "MARKET CLOSED",
            rsi: null
          },

          m5: {
            trend: "MARKET CLOSED",
            rsi: null
          }
        },

        analysis: {
          h12SMC: "MARKET CLOSED",
          h1SMC: "MARKET CLOSED",
          breakout: false,
          rejection: false,
          location: "MARKET CLOSED",
          extended: false
        },

        updated:
          new Date().toISOString()
      };
    }

    state.online = true;
    state.lastScan =
      new Date().toISOString();

    return;
  }

  state.online = true;
  state.api.status =
    "CONNECTED";

  for (const symbol of PAIRS) {
    try {
      const result =
        await analyzePair(symbol);

      state.pairs[symbol] =
        result;

      await processSignal(result);

    } catch (error) {
      console.error(
        symbol,
        error.message
      );

      state.pairs[symbol] = {
        symbol,
        status: "OFFLINE",
        score: 0,
        message:
          error.message,

        price: null,
        entry: null,
        stopLoss: null,
        takeProfit: null,

        timeframes: {
          h12: {
            trend: "UNKNOWN",
            rsi: null
          },

          h1: {
            trend: "UNKNOWN",
            rsi: null
          },

          m5: {
            trend: "UNKNOWN",
            rsi: null
          }
        },

        analysis: {
          h12SMC: "UNKNOWN",
          h1SMC: "UNKNOWN",
          breakout: false,
          rejection: false,
          location: "UNKNOWN",
          extended: false
        },

        updated:
          new Date().toISOString()
      };
    }
  }

  state.lastScan =
    new Date().toISOString();
}

// ============================================================
// API STATUS
// ============================================================

app.get(
  "/api/status",
  (req, res) => {
    res.json(state);
  }
);

// ============================================================
// ALERT STATUS
// ============================================================

app.post(
  "/api/alerts",
  (req, res) => {
    state.alerts =
      Boolean(req.body.enabled);

    res.json({
      ok: true,
      alerts:
        state.alerts,
      enabled:
        state.alerts
    });
  }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,
      time:
        new Date().toISOString()
    });
  }
);

// ============================================================
// START
// ============================================================

app.listen(
  PORT,
  () => {
    console.log(
      `Trading Cloud Monitor running on port ${PORT}`
    );

    scan();

    setInterval(
      scan,
      POLL_MS
    );
  }
);
