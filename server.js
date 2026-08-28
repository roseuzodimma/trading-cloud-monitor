const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TWELVE_DATA_API_KEY;

const TIMEFRAME = "5min";

// IMPORTANT:
// Do not scan more frequently than every 5 minutes.
// Your Twelve Data plan has an 8 requests/minute limit.
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

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || "";

const TELEGRAM_CHAT_ID =
  process.env.TELEGRAM_CHAT_ID || "";

let state = {
  online: true,
  alerts: true,
  lastScan: null,
  scanning: false,
  error: null,
  pairs: {},
  signals: [],
  lastAlertKey: null,
  lastAlertTime: 0
};


// ============================================================
// BASIC HELPERS
// ============================================================

function nowISO() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function round(value, decimals = 5) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(decimals));
}

function decimalsForPair(pair) {
  if (pair === "XAU/USD") return 2;
  return 5;
}


// ============================================================
// TECHNICAL CALCULATIONS
// ============================================================

function sma(values, period) {
  if (values.length < period) return null;

  const slice = values.slice(-period);

  return slice.reduce((a, b) => a + b, 0) / period;
}


function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let result =
    values.slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result =
      (values[i] - result) * multiplier + result;
  }

  return result;
}


function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];

    if (change >= 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];

    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain =
      ((avgGain * (period - 1)) + gain) / period;

    avgLoss =
      ((avgLoss * (period - 1)) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - (100 / (1 + rs));
}


// ============================================================
// CANDLE RESAMPLING
// ============================================================

function aggregateCandles(candles, minutes) {
  if (!candles.length) return [];

  const groups = new Map();

  for (const candle of candles) {
    const time = new Date(candle.datetime).getTime();

    const bucket =
      Math.floor(time / (minutes * 60 * 1000)) *
      (minutes * 60 * 1000);

    if (!groups.has(bucket)) {
      groups.set(bucket, {
        datetime: new Date(bucket).toISOString(),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume || 0
      });
    } else {
      const item = groups.get(bucket);

      item.high = Math.max(item.high, candle.high);
      item.low = Math.min(item.low, candle.low);
      item.close = candle.close;
      item.volume += candle.volume || 0;
    }
  }

  return [...groups.values()]
    .sort(
      (a, b) =>
        new Date(a.datetime) -
        new Date(b.datetime)
    );
}


// ============================================================
// TREND
// ============================================================

function getTrend(candles) {
  if (candles.length < 50) {
    return "NEUTRAL";
  }

  const closes = candles.map(c => c.close);

  const fast = ema(closes, 20);
  const slow = ema(closes, 50);

  if (!fast || !slow) return "NEUTRAL";

  const last = closes[closes.length - 1];

  if (last > fast && fast > slow) {
    return "BULLISH";
  }

  if (last < fast && fast < slow) {
    return "BEARISH";
  }

  return "NEUTRAL";
}


// ============================================================
// MARKET STRUCTURE
// ============================================================

function getStructure(candles) {
  if (candles.length < 20) {
    return "NEUTRAL";
  }

  const recent = candles.slice(-10);

  const previousHigh =
    Math.max(...candles.slice(-20, -10).map(c => c.high));

  const previousLow =
    Math.min(...candles.slice(-20, -10).map(c => c.low));

  const currentHigh =
    Math.max(...recent.map(c => c.high));

  const currentLow =
    Math.min(...recent.map(c => c.low));

  const last =
    candles[candles.length - 1].close;

  if (last > previousHigh && currentHigh > previousHigh) {
    return "BULLISH_BREAKOUT";
  }

  if (last < previousLow && currentLow < previousLow) {
    return "BEARISH_BREAKOUT";
  }

  if (currentHigh > previousHigh &&
      currentLow > previousLow) {
    return "BULLISH";
  }

  if (currentHigh < previousHigh &&
      currentLow < previousLow) {
    return "BEARISH";
  }

  return "NEUTRAL";
}


// ============================================================
// REJECTION CANDLE
// ============================================================

function bullishRejection(candle) {
  const body =
    Math.abs(candle.close - candle.open);

  const lowerWick =
    Math.min(candle.open, candle.close) -
    candle.low;

  return (
    candle.close > candle.open &&
    lowerWick > body * 1.2
  );
}


function bearishRejection(candle) {
  const body =
    Math.abs(candle.close - candle.open);

  const upperWick =
    candle.high -
    Math.max(candle.open, candle.close);

  return (
    candle.close < candle.open &&
    upperWick > body * 1.2
  );
}


// ============================================================
// SIGNAL ENGINE
// ============================================================

function analyzePair(pair, candles5m) {

  if (!candles5m || candles5m.length < 100) {
    return {
      pair,
      status: "WAIT",
      reason: "Not enough market candles",
      updated: nowISO()
    };
  }

  const candles1h =
    aggregateCandles(candles5m, 60);

  const candles12h =
    aggregateCandles(candles5m, 720);

  const closes5 =
    candles5m.map(c => c.close);

  const rsi5 =
    calculateRSI(closes5);

  const trend5 =
    getTrend(candles5m);

  const trend1h =
    getTrend(candles1h);

  const trend12h =
    getTrend(candles12h);

  const structure5 =
    getStructure(candles5m);

  const last =
    candles5m[candles5m.length - 1];

  const previous =
    candles5m[candles5m.length - 2];

  const price = last.close;

  let buyScore = 0;
  let sellScore = 0;

  const reasonsBuy = [];
  const reasonsSell = [];

  // ----------------------------------------------------------
  // 12H confirmation
  // ----------------------------------------------------------

  if (trend12h === "BULLISH") {
    buyScore++;
    reasonsBuy.push("12H bullish");
  }

  if (trend12h === "BEARISH") {
    sellScore++;
    reasonsSell.push("12H bearish");
  }


  // ----------------------------------------------------------
  // 1H confirmation
  // ----------------------------------------------------------

  if (trend1h === "BULLISH") {
    buyScore++;
    reasonsBuy.push("1H bullish");
  }

  if (trend1h === "BEARISH") {
    sellScore++;
    reasonsSell.push("1H bearish");
  }


  // ----------------------------------------------------------
  // 5M trend
  // ----------------------------------------------------------

  if (trend5 === "BULLISH") {
    buyScore++;
    reasonsBuy.push("5M bullish");
  }

  if (trend5 === "BEARISH") {
    sellScore++;
    reasonsSell.push("5M bearish");
  }


  // ----------------------------------------------------------
  // RSI
  // ----------------------------------------------------------

  if (rsi5 !== null) {

    if (rsi5 >= 50 && rsi5 <= 70) {
      buyScore++;
      reasonsBuy.push(`RSI ${rsi5.toFixed(1)}`);
    }

    if (rsi5 <= 50 && rsi5 >= 30) {
      sellScore++;
      reasonsSell.push(`RSI ${rsi5.toFixed(1)}`);
    }
  }


  // ----------------------------------------------------------
  // Breakout / structure
  // ----------------------------------------------------------

  if (
    structure5 === "BULLISH" ||
    structure5 === "BULLISH_BREAKOUT"
  ) {
    buyScore++;
    reasonsBuy.push("5M structure bullish");
  }

  if (
    structure5 === "BEARISH" ||
    structure5 === "BEARISH_BREAKOUT"
  ) {
    sellScore++;
    reasonsSell.push("5M structure bearish");
  }


  // ----------------------------------------------------------
  // Candle confirmation
  // ----------------------------------------------------------

  if (bullishRejection(last)) {
    buyScore++;
    reasonsBuy.push("bullish rejection");
  }

  if (bearishRejection(last)) {
    sellScore++;
    reasonsSell.push("bearish rejection");
  }


  // ----------------------------------------------------------
  // Prevent buying at extreme RSI
  // ----------------------------------------------------------

  if (rsi5 !== null && rsi5 > 75) {
    buyScore = Math.max(0, buyScore - 1);
  }

  if (rsi5 !== null && rsi5 < 25) {
    sellScore = Math.max(0, sellScore - 1);
  }


  // ----------------------------------------------------------
  // FINAL SIGNAL
  // ----------------------------------------------------------

  let signal = "WAIT";
  let score = Math.max(buyScore, sellScore);

  if (
    buyScore >= 5 &&
    buyScore > sellScore &&
    trend12h !== "BEARISH" &&
    trend1h !== "BEARISH"
  ) {
    signal = "STRONG BUY";
  }

  else if (
    sellScore >= 5 &&
    sellScore > buyScore &&
    trend12h !== "BULLISH" &&
    trend1h !== "BULLISH"
  ) {
    signal = "STRONG SELL";
  }

  else if (
    buyScore >= 4 &&
    buyScore > sellScore
  ) {
    signal = "BUY";
  }

  else if (
    sellScore >= 4 &&
    sellScore > buyScore
  ) {
    signal = "SELL";
  }


  // ----------------------------------------------------------
  // SL / TP
  // ----------------------------------------------------------

  let stopLoss = null;
  let takeProfit = null;

  const decimals =
    decimalsForPair(pair);

  const recentCandles =
    candles5m.slice(-20);

  const recentLow =
    Math.min(...recentCandles.map(c => c.low));

  const recentHigh =
    Math.max(...recentCandles.map(c => c.high));

  const range =
    recentHigh - recentLow;

  const minimumRisk =
    pair === "XAU/USD"
      ? 5
      : price * 0.001;


  if (
    signal === "BUY" ||
    signal === "STRONG BUY"
  ) {

    stopLoss =
      Math.min(
        recentLow,
        price - minimumRisk
      );

    const risk =
      price - stopLoss;

    takeProfit =
      price + risk * 2;
  }


  if (
    signal === "SELL" ||
    signal === "STRONG SELL"
  ) {

    stopLoss =
      Math.max(
        recentHigh,
        price + minimumRisk
      );

    const risk =
      stopLoss - price;

    takeProfit =
      price - risk * 2;
  }


  return {
    pair,

    status: signal,

    signal,

    price: round(price, decimals),

    entry:
      signal === "BUY" ||
      signal === "STRONG BUY" ||
      signal === "SELL" ||
      signal === "STRONG SELL"
        ? round(price, decimals)
        : null,

    stopLoss:
      stopLoss !== null
        ? round(stopLoss, decimals)
        : null,

    takeProfit:
      takeProfit !== null
        ? round(takeProfit, decimals)
        : null,

    score,

    buyScore,
    sellScore,

    trend12h,
    trend1h,
    trend5m: trend5,

    rsi:
      rsi5 !== null
        ? round(rsi5, 1)
        : null,

    structure: structure5,

    reasons:
      signal.includes("BUY")
        ? reasonsBuy
        : signal.includes("SELL")
          ? reasonsSell
          : [
              `${trend12h} 12H`,
              `${trend1h} 1H`,
              rsi5 !== null
                ? `RSI ${rsi5.toFixed(1)}`
                : "RSI unavailable",
              "Waiting for 5M confirmation"
            ],

    updated: nowISO(),

    candles: candles5m.length
  };
}


// ============================================================
// TWELVE DATA
// ============================================================

async function getMarketData(pair) {

  if (!API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY is missing"
    );
  }

  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(pair)}` +
    `&interval=5min` +
    `&outputsize=300` +
    `&apikey=${encodeURIComponent(API_KEY)}`;


  const response =
    await fetch(url);


  if (!response.ok) {

    if (response.status === 429) {
      throw new Error(
        "Twelve Data HTTP 429 - API limit reached"
      );
    }

    throw new Error(
      `Twelve Data HTTP ${response.status}`
    );
  }


  const data =
    await response.json();


  if (
    data.status === "error" ||
    data.code
  ) {

    if (
      data.code === 429 ||
      String(data.message || "")
        .toLowerCase()
        .includes("limit")
    ) {
      throw new Error(
        "Twelve Data HTTP 429 - API limit reached"
      );
    }

    throw new Error(
      data.message ||
      "Twelve Data returned an error"
    );
  }


  if (
    !data.values ||
    !Array.isArray(data.values)
  ) {
    throw new Error(
      "No candle data returned by Twelve Data"
    );
  }


  return data.values
    .map(c => ({
      datetime: c.datetime,

      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),

      volume:
        Number(c.volume || 0)
    }))
    .filter(c =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    )
    .reverse();
}


// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(message) {

  if (
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {
    console.log(
      "Telegram not configured."
    );
    return false;
  }


  try {

    const url =
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

    const response =
      await fetch(url, {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message
        })
      });


    return response.ok;

  } catch (error) {

    console.error(
      "Telegram error:",
      error.message
    );

    return false;
  }
}


function buildTelegramMessage(result) {

  const emoji =
    result.signal.includes("BUY")
      ? "🟢"
      : "🔴";


  return (
`${emoji} 🚨 ${result.signal}: ${result.pair}

Entry: ${result.entry}
🛑 Stop Loss: ${result.stopLoss}
🎯 Take Profit: ${result.takeProfit}

⭐ Score: ${result.score}/7

📊 12H: ${result.trend12h}
📊 1H: ${result.trend1h}
📊 5M: ${result.trend5m}
📈 RSI: ${result.rsi}

Structure: ${result.structure}

${result.reasons.join(" ✓ ")}`
  );
}


// ============================================================
// ALERT CONTROL
// ============================================================

async function processAlert(result) {

  if (!state.alerts) return;

  if (
    result.signal !== "STRONG BUY" &&
    result.signal !== "STRONG SELL"
  ) {
    return;
  }


  const alertKey =
    `${result.pair}-${result.signal}-${result.entry}`;


  const now =
    Date.now();


  // Don't repeatedly send the same signal.
  if (
    state.lastAlertKey === alertKey &&
    now - state.lastAlertTime < 30 * 60 * 1000
  ) {
    return;
  }


  state.lastAlertKey = alertKey;
  state.lastAlertTime = now;


  const message =
    buildTelegramMessage(result);


  console.log(
    "SIGNAL:",
    message
  );


  await sendTelegram(message);
}


// ============================================================
// MAIN SCANNER
// ============================================================

async function scanMarkets() {

  if (state.scanning) {
    console.log(
      "Scan already running. Skipping."
    );

    return;
  }


  state.scanning = true;
  state.error = null;


  console.log(
    `\nStarting market scan: ${new Date().toISOString()}`
  );


  try {

    for (let i = 0; i < PAIRS.length; i++) {

      const pair =
        PAIRS[i];


      console.log(
        `Scanning ${pair}...`
      );


      try {

        const candles =
          await getMarketData(pair);


        const result =
          analyzePair(
            pair,
            candles
          );


        state.pairs[pair] =
          result;


        console.log(
          `${pair}: ${result.signal} | ` +
          `12H ${result.trend12h} | ` +
          `1H ${result.trend1h} | ` +
          `RSI ${result.rsi}`
        );


        await processAlert(result);


      } catch (error) {

        console.error(
          `${pair}:`,
          error.message
        );


        state.pairs[pair] = {

          pair,

          status:
            error.message.includes("429")
              ? "DATA WAIT"
              : "ERROR",

          signal: "WAIT",

          reason:
            error.message,

          updated:
            nowISO()
        };


        // If Twelve Data rate limit is reached,
        // don't hammer the API.
        if (
          error.message.includes("429")
        ) {

          console.log(
            "Twelve Data limit reached. " +
            "Stopping this scan."
          );

          break;
        }
      }


      // Small delay between pair requests.
      // This prevents burst traffic.
      if (i < PAIRS.length - 1) {
        await sleep(1500);
      }
    }


    state.lastScan =
      nowISO();


    state.signals =
      Object.values(state.pairs)
        .filter(p =>
          p.signal === "BUY" ||
          p.signal === "SELL" ||
          p.signal === "STRONG BUY" ||
          p.signal === "STRONG SELL"
        );


  } catch (error) {

    console.error(
      "SCAN ERROR:",
      error
    );

    state.error =
      error.message;

  } finally {

    state.scanning = false;

    console.log(
      `Scan completed: ${new Date().toISOString()}`
    );
  }
}


// ============================================================
// API ROUTES
// ============================================================

app.get("/health", (req, res) => {

  res.json({
    status: "ok",
    online: true,
    time: nowISO()
  });

});


app.get("/api/status", (req, res) => {

  res.json({

    online: state.online,

    status:
      state.online
        ? "Online"
        : "Offline",

    alerts:
      state.alerts
        ? "ON"
        : "OFF",

    alertsEnabled:
      state.alerts,

    scanning:
      state.scanning,

    lastScan:
      state.lastScan,

    timeframe:
      TIMEFRAME,

    monitoredPairs:
      PAIRS.length,

    pairCount:
      PAIRS.length,

    pairs:
      state.pairs,

    signals:
      state.signals,

    error:
      state.error,

    updated:
      nowISO()
  });

});


app.get("/api/pairs", (req, res) => {

  res.json({
    pairs: PAIRS,
    data: state.pairs
  });

});


app.get("/api/signals", (req, res) => {

  res.json({
    signals: state.signals
  });

});


app.get("/api/scan", async (req, res) => {

  if (state.scanning) {

    return res.json({
      ok: false,
      message: "Scan already running"
    });

  }


  scanMarkets();

  res.json({
    ok: true,
    message: "Scan started"
  });

});


app.post("/api/alerts", (req, res) => {

  if (
    typeof req.body.enabled ===
    "boolean"
  ) {

    state.alerts =
      req.body.enabled;
  }


  res.json({
    ok: true,
    alerts:
      state.alerts
  });

});


app.get("/", (req, res) => {

  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );

});


// ============================================================
// ERROR HANDLER
// ============================================================

app.use(
  (err, req, res, next) => {

    console.error(
      "SERVER ERROR:",
      err
    );

    res.status(500).json({
      error: "Internal server error"
    });
  }
);


// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Trading Cloud Monitor running on port ${PORT}`
    );

    console.log(
      `Monitoring ${PAIRS.length} pairs`
    );

    console.log(
      `Timeframe: ${TIMEFRAME}`
    );

    console.log(
      `Poll interval: ${POLL_MS}ms`
    );


    // Give Express a moment to start,
    // then perform the first scan.
    setTimeout(
      () => {
        scanMarkets();
      },
      3000
    );


    // Continue scanning.
    setInterval(
      () => {
        scanMarkets();
      },
      POLL_MS
    );
  }
);
