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
Multi-Timeframe + SMC + RSI + EMA + ATR
===========================================================
*/

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
const HIGHER_TIMEFRAME = "1h";

/*
Scan every 15 minutes.
*/
const POLL_MS = Math.max(
  900000,
  Number(process.env.POLL_MS || 900000)
);

/*
Wait between Twelve Data requests.
*/
const API_REQUEST_GAP_MS = Math.max(
  3000,
  Number(process.env.API_REQUEST_GAP_MS || 9500)
);

/*
Cache:
5M = 15 minutes
1H = 2 hours

12H is built locally from 1H candles.
*/
const M5_CACHE_MS = 15 * 60 * 1000;
const H1_CACHE_MS = 2 * 60 * 60 * 1000;

/*
If Twelve Data returns 429, stop requesting for 5 minutes.
*/
const API_COOLDOWN_MS = 5 * 60 * 1000;

let lastApiRequest = 0;
let apiCooldownUntil = 0;

/* =========================================================
STATE
========================================================= */

const state = {
  online: true,
  alerts: true,
  lastScan: null,
  scanning: false,

  api: {
    configured: !!API_KEY,
    status: API_KEY ? "READY" : "NOT CONFIGURED",
    lastError: null,
    cooldownUntil: null,
    requestsThisScan: 0,
    totalRequests: 0
  },

  performance: {
    totalSignals: 0,
    buys: 0,
    sells: 0,
    wins: 0,
    losses: 0
  },

  lastSignalKey: {},

  pairs: {}
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

/* =========================================================
HELPERS
========================================================= */

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

  if (pair.includes("JPY")) {
    return 3;
  }

  return 5;
}

/* =========================================================
API RATE LIMITER
========================================================= */

async function waitForApiSlot() {
  const elapsed = Date.now() - lastApiRequest;

  if (elapsed < API_REQUEST_GAP_MS) {
    await sleep(API_REQUEST_GAP_MS - elapsed);
  }

  lastApiRequest = Date.now();
}

/* =========================================================
TWELVE DATA
========================================================= */

async function getCandles(symbol, interval, outputsize) {
  if (!API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY is missing"
    );
  }

  if (Date.now() < apiCooldownUntil) {
    const seconds = Math.ceil(
      (apiCooldownUntil - Date.now()) / 1000
    );

    throw new Error(
      `Twelve Data rate-limit cooldown (${seconds}s)`
    );
  }

  await waitForApiSlot();

  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${outputsize}` +
    `&apikey=${encodeURIComponent(API_KEY)}`;

  state.api.requestsThisScan++;
  state.api.totalRequests++;

  let response;

  try {
    response = await fetch(url);
  } catch (error) {
    state.api.status = "NETWORK ERROR";
    state.api.lastError = error.message;

    throw new Error(
      `Twelve Data network error: ${error.message}`
    );
  }

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(
      "Twelve Data returned invalid JSON"
    );
  }

  /*
  HTTP 429
  */
  if (response.status === 429) {
    apiCooldownUntil =
      Date.now() + API_COOLDOWN_MS;

    state.api.status = "RATE LIMITED";

    state.api.cooldownUntil =
      new Date(apiCooldownUntil).toISOString();

    state.api.lastError =
      "Twelve Data HTTP 429 - API limit reached";

    throw new Error(
      "Twelve Data HTTP 429 - API limit reached"
    );
  }

  if (!response.ok) {
    state.api.status = "API ERROR";

    state.api.lastError =
      `Twelve Data HTTP ${response.status}`;

    throw new Error(
      `Twelve Data HTTP ${response.status}`
    );
  }

  /*
  API-level error.
  */
  if (
    data.status === "error" ||
    data.code
  ) {
    const message =
      data.message ||
      "Twelve Data API error";

    if (
      /limit|credit|rate/i.test(message)
    ) {
      apiCooldownUntil =
        Date.now() + API_COOLDOWN_MS;

      state.api.status = "RATE LIMITED";

      state.api.cooldownUntil =
        new Date(apiCooldownUntil).toISOString();
    }

    state.api.lastError = message;

    throw new Error(
      `Twelve Data ${data.code || ""} ${message}`.trim()
    );
  }

  if (
    !data.values ||
    !Array.isArray(data.values) ||
    data.values.length < 30
  ) {
    throw new Error(
      "Insufficient candle data"
    );
  }

  state.api.status = "CONNECTED";
  state.api.lastError = null;

  return data.values
    .map(c => ({
      datetime: c.datetime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: c.volume
        ? Number(c.volume)
        : 0
    }))
    .filter(c =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    )
    .reverse();
}

/* =========================================================
EMA
========================================================= */

function ema(values, period) {
  if (values.length < period) {
    return null;
  }

  const multiplier =
    2 / (period + 1);

  let result =
    values
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    result =
      (values[i] - result) *
        multiplier +
      result;
  }

  return result;
}

/* =========================================================
RSI
========================================================= */

function rsi(values, period = 14) {
  if (values.length <=
