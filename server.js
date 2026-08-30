const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const API_KEY = process.env.TWELVE_DATA_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const TIMEFRAME = process.env.TIMEFRAME || "5min";
const POLL_MS = Math.max(
  300000,
  Number(process.env.POLL_MS || 300000)
);

const PAIRS = [
  "EUR/USD",
  "GBP/USD",
  "USD/CAD",
  "XAU/USD",
  "USD/CHF",
  "EUR/GBP",
  "GBP/CHF"
];

let alertsEnabled = true;

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

/* =========================================================
   MARKET HOURS
   Forex generally closes Friday 22:00 UTC and opens
   Sunday 22:00 UTC. XAU/USD follows the same broad
   weekend protection here.
========================================================= */

function isMarketOpen() {
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

/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function roundPrice(value, pair) {
  if (!Number.isFinite(value)) return null;

  const decimals =
    pair === "XAU/USD" ? 2 :
    pair.includes("JPY") ? 3 :
    5;

  return Number(value.toFixed(decimals));
}

function average(values) {
  const clean = values.filter(Number.isFinite);

  if (!clean.length) return null;

  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

/* =========================================================
   TWELVE DATA
========================================================= */

async function twelveData(symbol, interval, outputsize = 100) {
  if (!API_KEY) {
    throw new Error("TWELVE_DATA_API_KEY is missing");
  }

  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${outputsize}` +
    `&apikey=${encodeURIComponent(API_KEY)}`;

  state.api.totalRequests++;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Twelve Data HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.status === "error") {
    throw new Error(data.message || "Twelve Data error");
  }

  if (!Array.isArray(data.values)) {
    throw new Error("No candle data returned");
  }

  return data.values
    .map(x => ({
      datetime: new Date(x.datetime),
      open: num(x.open),
      high: num(x.high),
      low: num(x.low),
      close: num(x.close),
      volume: num(x.volume)
    }))
    .filter(
      x =>
        Number.isFinite(x.open) &&
        Number.isFinite(x.high) &&
        Number.isFinite(x.low) &&
        Number.isFinite(x.close)
    )
    .sort(
      (a, b) =>
        a.datetime.getTime() -
        b.datetime.getTime()
    );
}

/* =========================================================
   RSI
========================================================= */

function calculateRSI(candles, period = 14) {
  if (!candles || candles.length < period + 1) {
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

    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    avgGain =
      ((avgGain * (period - 1)) + gain) /
      period;

    avgLoss =
      ((avgLoss * (period - 1)) + loss) /
      period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

/* =========================================================
   TREND
========================================================= */

function getTrend(candles) {
  if (!candles || candles.length < 20) {
    return "UNKNOWN";
  }

  const recent = candles.slice(-20);

  const fast =
    average(recent.slice(-5).map(x => x.close));

  const slow =
    average(recent.map(x => x.close));

  const first =
    recent[0].close;

  const last =
    recent[recent.length - 1].close;

  if (
    last > first &&
    fast > slow
  ) {
    return "BULLISH";
  }

  if (
    last < first &&
    fast < slow
  ) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

/* =========================================================
   SMC STRUCTURE
========================================================= */

function findSwingHigh(candles, index) {
  if (
    index < 2 ||
    index >= candles.length - 2
  ) {
    return false;
  }

  return (
    candles[index].high >
      candles[index - 1].high &&
    candles[index].high >
      candles[index - 2].high &&
    candles[index].high >
      candles[index + 1].high &&
    candles[index].high >
      candles[index + 2].high
  );
}

function findSwingLow(candles, index) {
  if (
    index < 2 ||
    index >= candles.length - 2
  ) {
    return false;
  }

  return (
    candles[index].low <
      candles[index - 1].low &&
    candles[index].low <
      candles[index - 2].low &&
    candles[index].low <
      candles[index + 1].low &&
    candles[index].low <
      candles[index + 2].low
  );
}

function getStructure(candles) {
  if (!candles || candles.length < 15) {
    return {
      structure: "UNKNOWN",
      bos: "—",
      choch: "—",
      liquidity: "—"
    };
  }

  const highs = [];
  const lows = [];

  for (
    let i = 2;
    i < candles.length - 2;
    i++
  ) {
    if (findSwingHigh(candles, i)) {
      highs.push(candles[i]);
    }

    if (findSwingLow(candles, i)) {
      lows.push(candles[i]);
    }
  }

  const last = candles[candles.length - 1];

  const previousHigh =
    highs.length
      ? highs[highs.length - 1].high
      : null;

  const previousLow =
    lows.length
      ? lows[lows.length - 1].low
      : null;

  let structure = "RANGE";
  let bos = "—";
  let choch = "—";

  if (
    previousHigh !== null &&
    last.close > previousHigh
  ) {
    structure = "BULLISH";
    bos = "BULLISH";
  }

  if (
    previousLow !== null &&
    last.close < previousLow
  ) {
    structure = "BEARISH";
    bos = "BEARISH";
  }

  const previous = candles[candles.length - 2];

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

  let liquidity = "—";

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

  return {
    structure,
    bos,
    choch,
    liquidity
  };
}

/* =========================================================
   REJECTION
========================================================= */

function rejectionSignal(candle) {
  if (!candle) {
    return {
      bullish: false,
      bearish: false
    };
  }

  const body =
    Math.abs(candle.close - candle.open);

  const upperWick =
    candle.high -
    Math.max(candle.open, candle.close);

  const lowerWick =
    Math.min(candle.open, candle.close) -
    candle.low;

  const minimum =
    Math.max(body * 1.5, 0.0000001);

  return {
    bullish:
      lowerWick > minimum &&
      candle.close > candle.open,

    bearish:
      upperWick > minimum &&
      candle.close < candle.open
  };
}

/* =========================================================
   BREAKOUT
========================================================= */

function breakoutSignal(candles) {
  if (!candles || candles.length < 10) {
    return {
      bullish: false,
      bearish: false
    };
  }

  const current =
    candles[candles.length - 1];

  const previous =
    candles.slice(-6, -1);

  const highest =
    Math.max(...previous.map(x => x.high));

  const lowest =
    Math.min(...previous.map(x => x.low));

  return {
    bullish:
      current.close > highest,

    bearish:
      current.close < lowest
  };
}

/* =========================================================
   PREVIOUS CLOSED 12H BIAS
=========================================================

   IMPORTANT:

   We use the PREVIOUS COMPLETED 12H candle for the stable
   12H bias.

   The current/developing 12H candle is displayed separately.

   This prevents the 12H bias from constantly flipping while
   the current 12H candle is still forming.
========================================================= */

function get12HAnalysis(candles) {
  if (!candles || candles.length < 20) {
    return {
      previousTrend: "UNKNOWN",
      currentTrend: "UNKNOWN",
      previousRSI: null,
      currentRSI: null,
      bias: "UNKNOWN",
      previousCandle: null,
      currentCandle: null
    };
  }

  const current =
    candles[candles.length - 1];

  const previous =
    candles[candles.length - 2];

  const previousClosed =
    candles.slice(
      0,
      candles.length - 1
    );

  const previousTrend =
    getTrend(previousClosed);

  const currentTrend =
    getTrend(candles);

  const previousRSI =
    calculateRSI(previousClosed);

  const currentRSI =
    calculateRSI(candles);

  let bias = previousTrend;

  /*
    The previous completed candle controls the official
    12H bias.
  */

  if (
    previous.close > previous.open &&
    previousTrend !== "BEARISH"
  ) {
    bias = "BULLISH";
  }

  if (
    previous.close < previous.open &&
    previousTrend !== "BULLISH"
  ) {
    bias = "BEARISH";
  }

  return {
    previousTrend,
    currentTrend,
    previousRSI:
      previousRSI !== null
        ? Number(previousRSI.toFixed(1))
        : null,

    currentRSI:
      currentRSI !== null
        ? Number(currentRSI.toFixed(1))
        : null,

    bias,

    previousCandle: previous,
    currentCandle: current
  };
}

/* =========================================================
   PRICE / ATR
========================================================= */

function calculateATR(candles, period = 14) {
  if (
    !candles ||
    candles.length < period + 1
  ) {
    return null;
  }

  const trs = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
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

    trs.push(tr);
  }

  return average(
    trs.slice(-period)
  );
}

/* =========================================================
   BUILD SIGNAL
========================================================= */

function analyzePair(
  pair,
  h12,
  h1,
  m5
) {
  const price =
    m5[m5.length - 1].close;

  const h12Analysis =
    get12HAnalysis(h12);

  const h1Trend =
    getTrend(h1);

  const m5Trend =
    getTrend(m5);

  const h1RSI =
    calculateRSI(h1);

  const m5RSI =
    calculateRSI(m5);

  const h1Structure =
    getStructure(h1);

  const m5Structure =
    getStructure(m5);

  const rejection =
    rejectionSignal(
      m5[m5.length - 1]
    );

  const breakout =
    breakoutSignal(m5);

  const h12Structure =
    getStructure(
      h12.slice(0, -1)
    );

  let buyScore = 0;
  let sellScore = 0;

  /* ---------------- 12H ---------------- */

  if (h12Analysis.bias === "BULLISH") {
    buyScore++;
  }

  if (h12Analysis.bias === "BEARISH") {
    sellScore++;
  }

  /* ---------------- 1H ---------------- */

  if (h1Trend === "BULLISH") {
    buyScore++;
  }

  if (h1Trend === "BEARISH") {
    sellScore++;
  }

  /* ---------------- 5M ---------------- */

  if (m5Trend === "BULLISH") {
    buyScore++;
  }

  if (m5Trend === "BEARISH") {
    sellScore++;
  }

  /* ---------------- RSI ---------------- */

  if (
    m5RSI !== null &&
    m5RSI >= 50 &&
    m5RSI <= 70
  ) {
    buyScore++;
  }

  if (
    m5RSI !== null &&
    m5RSI <= 50 &&
    m5RSI >= 30
  ) {
    sellScore++;
  }

  /* ---------------- SMC ---------------- */

  if (
    m5Structure.bos === "BULLISH" ||
    m5Structure.choch === "BULLISH" ||
    breakout.bullish ||
    rejection.bullish
  ) {
    buyScore++;
  }

  if (
    m5Structure.bos === "BEARISH" ||
    m5Structure.choch === "BEARISH" ||
    breakout.bearish ||
    rejection.bearish
  ) {
    sellScore++;
  }

  /*
    Maximum displayed score = 5.
  */

  buyScore = Math.min(5, buyScore);
  sellScore = Math.min(5, sellScore);

  let status = "WAIT";
  let score = Math.max(
    buyScore,
    sellScore
  );

  /*
    STRONG signals require the higher timeframe
    to agree.

    This prevents a 5M signal from fighting the 12H bias.
  */

  if (
    buyScore >= 4 &&
    h12Analysis.bias === "BULLISH" &&
    h1Trend === "BULLISH"
  ) {
    status = "BUY";
  }

  if (
    sellScore >= 4 &&
    h12Analysis.bias === "BEARISH" &&
    h1Trend === "BEARISH"
  ) {
    status = "SELL";
  }

  /* =====================================================
     EXTENSION PROTECTION

     Avoid entering after a very extended 5M move.
  ===================================================== */

  const atr =
    calculateATR(m5);

  let extended = false;

  if (atr !== null) {
    const recent =
      m5[m5.length - 6];

    const distance =
      Math.abs(
        price - recent.open
      );

    if (distance > atr * 2.5) {
      extended = true;
      status = "WAIT";
    }
  }

  /* =====================================================
     ENTRY / SL / TP
  ===================================================== */

  let entry = null;
  let stopLoss = null;
  let takeProfit = null;

  if (
    status === "BUY" &&
    atr !== null
  ) {
    entry = price;

    stopLoss =
      Math.min(
        m5[m5.length - 1].low,
        price - atr * 1.2
      );

    const risk =
      entry - stopLoss;

    takeProfit =
      entry + risk * 2;
  }

  if (
    status === "SELL" &&
    atr !== null
  ) {
    entry = price;

    stopLoss =
      Math.max(
        m5[m5.length - 1].high,
        price + atr * 1.2
      );

    const risk =
      stopLoss - entry;

    takeProfit =
      entry - risk * 2;
  }

  const roundedEntry =
    roundPrice(entry, pair);

  const roundedSL =
    roundPrice(stopLoss, pair);

  const roundedTP =
    roundPrice(takeProfit, pair);

  let location = "NEUTRAL";

  if (
    status === "BUY"
  ) {
    location =
      rejection.bullish
        ? "BULLISH REJECTION"
        : breakout.bullish
          ? "BULLISH BREAKOUT"
          : "BULLISH STRUCTURE";
  }

  if (
    status === "SELL"
  ) {
    location =
      rejection.bearish
        ? "BEARISH REJECTION"
        : breakout.bearish
          ? "BEARISH BREAKOUT"
          : "BEARISH STRUCTURE";
  }

  let message =
    `12H ${h12Analysis.bias} | ` +
    `1H ${h1Trend} | ` +
    `5M ${m5Trend} | ` +
    `RSI ${m5RSI !== null ? m5RSI.toFixed(1) : "—"}`;

  if (status === "BUY") {
    message +=
      " | Bullish confirmation";
  }

  if (status === "SELL") {
    message +=
      " | Bearish confirmation";
  }

  if (extended) {
    message =
      "Move extended — waiting for pullback/confirmation";
  }

  return {
    symbol: pair,
    status,
    score,
    message,

    price: roundPrice(
      price,
      pair
    ),

    entry: roundedEntry,
    stopLoss: roundedSL,
    takeProfit: roundedTP,

    updated:
      new Date().toISOString(),

    timeframes: {
      h12: {
        trend: h12Analysis.bias,
        rsi: h12Analysis.previousRSI,

        previous:
          h12Analysis.previousTrend,

        current:
          h12Analysis.currentTrend,

        previousCandle:
          h12Analysis.previousCandle
            ? {
                open:
                  h12Analysis.previousCandle.open,
                high:
                  h12Analysis.previousCandle.high,
                low:
                  h12Analysis.previousCandle.low,
                close:
                  h12Analysis.previousCandle.close
              }
            : null
      },

      h1: {
        trend: h1Trend,
        rsi:
          h1RSI !== null
            ? Number(h1RSI.toFixed(1))
            : null
      },

      m5: {
        trend: m5Trend,
        rsi:
          m5RSI !== null
            ? Number(m5RSI.toFixed(1))
            : null
      }
    },

    analysis: {
      direction: status,

      h12SMC:
        h12Structure.structure,

      h1SMC:
        h1Structure.structure,

      breakout:
        breakout.bullish ||
        breakout.bearish,

      rejection:
        rejection.bullish ||
        rejection.bearish,

      location,

      extended,

      structure:
        m5Structure.structure,

      bos:
        m5Structure.bos,

      choch:
        m5Structure.choch,

      liquidity:
        m5Structure.liquidity
    }
  };
}

/* =========================================================
   TELEGRAM
========================================================= */

async function sendTelegramSignal(signal) {
  if (
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_CHAT_ID ||
    !alertsEnabled
  ) {
    return;
  }

  if (
    signal.status !== "BUY" &&
    signal.status !== "SELL"
  ) {
    return;
  }

  const emoji =
    signal.status === "BUY"
      ? "🟢"
      : "🔴";

  const text =
`${emoji} STRONG ${signal.status}: ${signal.symbol}

📍 Entry: ${signal.entry}
🛑 Stop Loss: ${signal.stopLoss}
🎯 Take Profit: ${signal.takeProfit}

⭐ Score: ${signal.score}/5

📊 12H ${signal.timeframes.h12.trend} | 1H ${signal.timeframes.h1.trend} | RSI ${signal.timeframes.m5.rsi ?? "—"} | ${signal.analysis.location}

⏱ Entry TF: 5M
🔎 Confirmation: 12H + 1H + 5M
💰 Risk/Reward: 1:2

⚠️ Signal confirmation required before entry.`;

  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json"
      },
      body: JSON.stringify({
        chat_id:
          TELEGRAM_CHAT_ID,
        text
      })
    });
  } catch (error) {
    console.error(
      "Telegram error:",
      error.message
    );
  }
}

/* =========================================================
   SCAN
========================================================= */

async function scanPair(pair) {
  const result =
    state.pairs[pair];

  result.updated =
    new Date().toISOString();

  /*
    NEVER generate trading signals while market is closed.
  */

  if (!isMarketOpen()) {
    result.status = "WAIT";
    result.score = 0;

    result.message =
      "Market closed — monitoring will resume when the market opens.";

    result.price = null;
    result.entry = null;
    result.stopLoss = null;
    result.takeProfit = null;

    result.timeframes = {
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

    return;
  }

  try {
    /*
      12H = higher timeframe
      1H  = confirmation
      5M  = entry
    */

    const h12 = await twelveData(
      pair,
      "12h",
      100
    );

    const h1 = await twelveData(
      pair,
      "1h",
      100
    );

    const m5 = await twelveData(
      pair,
      "5min",
      100
    );

    state.api.requestsThisScan += 3;

    const signal =
      analyzePair(
        pair,
        h12,
        h1,
        m5
      );

    /*
      Count only newly generated strong signals.
    */

    const oldStatus =
      result.status;

    if (
      signal.status === "BUY" &&
      oldStatus !== "BUY"
    ) {
      state.performance.totalSignals++;
      state.performance.buys++;

      await sendTelegramSignal(
        signal
      );
    }

    if (
      signal.status === "SELL" &&
      oldStatus !== "SELL"
    ) {
      state.performance.totalSignals++;
      state.performance.sells++;

      await sendTelegramSignal(
        signal
      );
    }

    state.pairs[pair] =
      signal;

  } catch (error) {
    console.error(
      pair,
      error.message
    );

    result.status =
      "OFFLINE";

    result.score = 0;

    result.message =
      error.message;

    result.updated =
      new Date().toISOString();

    state.api.lastError =
      `${pair}: ${error.message}`;
  }
}

async function scanAll() {
  state.api.requestsThisScan = 0;
  state.api.lastError = null;

  /*
    Correct market state.
  */

  const marketOpen =
    isMarketOpen();

  state.online = true;

  console.log(
    `[SCAN] Market ${marketOpen ? "OPEN" : "CLOSED"}`
  );

  /*
    If closed, update every pair immediately without
    making unnecessary Twelve Data calls.
  */

  if (!marketOpen) {
    for (const pair of PAIRS) {
      await scanPair(pair);
    }

    state.lastScan =
      new Date().toISOString();

    return;
  }

  /*
    Small delay between pairs to reduce API pressure.
  */

  for (const pair of PAIRS) {
    await scanPair(pair);
    await sleep(500);
  }

  state.lastScan =
    new Date().toISOString();
}

/* =========================================================
   API ROUTES
========================================================= */

app.get("/api/status", (req, res) => {
  res.json({
    online: state.online,

    marketOpen:
      isMarketOpen(),

    marketStatus:
      isMarketOpen()
        ? "OPEN"
        : "CLOSED",

    alerts:
      alertsEnabled,

    lastScan:
      state.lastScan,

    timeframe:
      state.timeframe,

    pairs:
      state.pairs,

    performance:
      state.performance,

    api:
      state.api
  });
});

/* Alert state */

app.get("/api/alerts", (req, res) => {
  res.json({
    ok: true,
    enabled: alertsEnabled,
    alerts: alertsEnabled
  });
});

app.post("/api/alerts", (req, res) => {
  alertsEnabled =
    Boolean(req.body.enabled);

  res.json({
    ok: true,
    enabled: alertsEnabled,
    alerts: alertsEnabled
  });
});

/* Health */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    marketOpen:
      isMarketOpen(),
    time:
      new Date().toISOString()
  });
});

/* =========================================================
   START
========================================================= */

app.listen(PORT, async () => {
  console.log(
    `Trading Cloud Monitor running on port ${PORT}`
  );

  console.log(
    `Market status: ${
      isMarketOpen()
        ? "OPEN"
        : "CLOSED"
    }`
  );

  if (!API_KEY) {
    console.log(
      "WARNING: TWELVE_DATA_API_KEY is missing."
    );
  }

  await scanAll();

  setInterval(
    scanAll,
    POLL_MS
  );
});
