const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const API_KEY = process.env.TWELVE_DATA_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const INTERVAL = process.env.TIMEFRAME || "5min";
const POLL_MS = Math.max(
  Number(process.env.POLL_MS || 300000),
  300000
);

const H1_CACHE_MS = 60 * 60 * 1000;
const NEWS_REFRESH_MS = 5 * 60 * 1000;
const TWELVE_DELAY_MS = 1200;
const TWELVE_COOLDOWN_MS = 60 * 1000;

const PAIRS = [
  "XAU/USD",
  "GBP/JPY"
];

/*
=========================================================
STATE
=========================================================
*/

const state = {
  online: true,
  lastScan: null,
  timeframe: INTERVAL,

  pairs: {},

  performance: {
    scans: 0,
    signals: 0,
    errors: 0
  },

  api: {
    lastStatus: null,
    lastError: null,
    cooldownUntil: 0
  },

  news: {
    lastRefresh: null,
    lastError: null,
    events: [],
    source: "Biquote"
  }
};

function createPairState() {
  return {
    status: "WAIT",
    signal: null,

    lastSignalDirection: null,
    lastSignalTime: 0,

    news: {
      phase: "NORMAL",
      eventKey: null,
      eventName: null,
      eventTime: null,

      direction: null,

      sequenceStart: null,

      liquiditySweep: false,
      sweepType: null,

      bosChoch: false,
      bosType: null,

      fvgFound: false,
      fvgType: null,
      fvgLow: null,
      fvgHigh: null,

      retracement: false,

      lastProcessedCandle: null
    }
  };
}

for (const pair of PAIRS) {
  state.pairs[pair] = createPairState();
}

/*
=========================================================
CACHES
=========================================================
*/

const h1Cache = {};

let lastNewsRefresh = 0;

/*
=========================================================
GENERAL HELPERS
=========================================================
*/

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function round(value, digits = 5) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function nowIso() {
  return new Date().toISOString();
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizePair(pair) {
  return pair.replace("/", "");
}

function priceDigits(pair) {
  return pair === "XAU/USD" ? 2 : 3;
}

function formatPrice(pair, value) {
  const digits = priceDigits(pair);
  return Number(value).toFixed(digits);
}

/*
=========================================================
MARKET HOURS
=========================================================
*/

function isWeekend() {
  const day = new Date().getUTCDay();

  return day === 0 || day === 6;
}

function marketIsClosed() {
  return isWeekend();
}

/*
=========================================================
TWELVE DATA
=========================================================
*/

async function twelveDataRequest(url) {
  if (!API_KEY) {
    throw new Error("TWELVE_DATA_API_KEY is missing");
  }

  if (Date.now() < state.api.cooldownUntil) {
    throw new Error("Twelve Data temporarily rate-limited");
  }

  const separator = url.includes("?") ? "&" : "?";
  const finalUrl =
    `${url}${separator}apikey=${encodeURIComponent(API_KEY)}`;

  const response = await fetch(finalUrl);

  state.api.lastStatus = response.status;

  if (response.status === 429) {
    state.api.cooldownUntil =
      Date.now() + TWELVE_COOLDOWN_MS;

    state.api.lastError =
      "Twelve Data HTTP 429 rate limit";

    throw new Error(
      "Twelve Data HTTP 429 rate limit"
    );
  }

  if (!response.ok) {
    const text = await response.text();

    throw new Error(
      `Twelve Data HTTP ${response.status}: ${text.slice(0, 200)}`
    );
  }

  const data = await response.json();

  if (data.status === "error") {
    throw new Error(
      data.message || "Twelve Data returned an error"
    );
  }

  return data;
}

/*
=========================================================
GET CLOSED CANDLES
=========================================================
*/

async function getClosedCandles(
  pair,
  interval,
  outputsize = 200
) {
  const symbol = encodeURIComponent(pair);

  const url =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${symbol}` +
    `&interval=${interval}` +
    `&outputsize=${outputsize}` +
    `&format=JSON`;

  const data = await twelveDataRequest(url);

  if (!data.values || !Array.isArray(data.values)) {
    throw new Error(
      `No candle data returned for ${pair} ${interval}`
    );
  }

  const candles = data.values
    .map(c => ({
      datetime: c.datetime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    }))
    .filter(c =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    )
    .sort(
      (a, b) =>
        new Date(a.datetime) -
        new Date(b.datetime)
    );

  if (candles.length < 30) {
    throw new Error(
      `Not enough ${interval} candles for ${pair}`
    );
  }

  /*
  Twelve Data normally returns the newest candle first.
  Remove the newest candle because it can still be forming.
  */
  candles.pop();

  return candles;
}

/*
=========================================================
12H AGGREGATION
=========================================================
*/

function aggregate12HCandles(h1Candles) {
  const blocks = {};

  for (const candle of h1Candles) {
    const date = new Date(candle.datetime);

    if (Number.isNaN(date.getTime())) continue;

    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const day = date.getUTCDate();
    const hour = date.getUTCHours();

    const blockHour = hour < 12 ? 0 : 12;

    const key =
      `${year}-${String(month + 1).padStart(2, "0")}-` +
      `${String(day).padStart(2, "0")}-${blockHour}`;

    if (!blocks[key]) {
      blocks[key] = {
        datetime: new Date(
          Date.UTC(year, month, day, blockHour)
        ).toISOString(),

        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,

        count: 0
      };
    }

    blocks[key].high =
      Math.max(blocks[key].high, candle.high);

    blocks[key].low =
      Math.min(blocks[key].low, candle.low);

    blocks[key].close = candle.close;
    blocks[key].count++;
  }

  return Object.values(blocks)
    .filter(block => block.count >= 10)
    .sort(
      (a, b) =>
        new Date(a.datetime) -
        new Date(b.datetime)
    );
}

/*
=========================================================
RSI
=========================================================
*/

function calculateRSI(candles, period = 14) {
  if (candles.length <= period) return null;

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

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (
    let i = period + 1;
    i < candles.length;
    i++
  ) {
    const change =
      candles[i].close -
      candles[i - 1].close;

    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    averageGain =
      ((averageGain * (period - 1)) + gain) /
      period;

    averageLoss =
      ((averageLoss * (period - 1)) + loss) /
      period;
  }

  if (averageLoss === 0) return 100;

  const rs = averageGain / averageLoss;

  return 100 - (100 / (1 + rs));
}

/*
=========================================================
TREND
=========================================================
*/

function getTrend(candles) {
  if (candles.length < 20) {
    return "NEUTRAL";
  }

  const last20 = candles.slice(-20);

  const fastAverage =
    last20
      .slice(-5)
      .reduce((sum, c) => sum + c.close, 0) / 5;

  const slowAverage =
    last20
      .reduce((sum, c) => sum + c.close, 0) / 20;

  const firstClose = last20[0].close;
  const lastClose = last20[last20.length - 1].close;

  if (
    fastAverage > slowAverage &&
    lastClose > firstClose
  ) {
    return "BULLISH";
  }

  if (
    fastAverage < slowAverage &&
    lastClose < firstClose
  ) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

/*
=========================================================
SWINGS
=========================================================
*/

function getSwingHighs(candles) {
  const swings = [];

  for (let i = 2; i < candles.length - 2; i++) {
    if (
      candles[i].high > candles[i - 1].high &&
      candles[i].high > candles[i - 2].high &&
      candles[i].high > candles[i + 1].high &&
      candles[i].high > candles[i + 2].high
    ) {
      swings.push({
        index: i,
        price: candles[i].high
      });
    }
  }

  return swings;
}

function getSwingLows(candles) {
  const swings = [];

  for (let i = 2; i < candles.length - 2; i++) {
    if (
      candles[i].low < candles[i - 1].low &&
      candles[i].low < candles[i - 2].low &&
      candles[i].low < candles[i + 1].low &&
      candles[i].low < candles[i + 2].low
    ) {
      swings.push({
        index: i,
        price: candles[i].low
      });
    }
  }

  return swings;
}

/*
=========================================================
STRUCTURE
=========================================================
*/

function getStructure(candles) {
  if (candles.length < 10) {
    return {
      type: "NONE",
      direction: "NEUTRAL"
    };
  }

  const highs = getSwingHighs(candles);
  const lows = getSwingLows(candles);

  const currentIndex = candles.length - 1;
  const current = candles[currentIndex];

  const previousHigh =
    highs.length
      ? highs[highs.length - 1]
      : null;

  const previousLow =
    lows.length
      ? lows[lows.length - 1]
      : null;

  if (
    previousHigh &&
    current.close > previousHigh.price
  ) {
    return {
      type: "BOS",
      direction: "BULLISH"
    };
  }

  if (
    previousLow &&
    current.close < previousLow.price
  ) {
    return {
      type: "BOS",
      direction: "BEARISH"
    };
  }

  return {
    type: "NONE",
    direction: "NEUTRAL"
  };
}

/*
=========================================================
LIQUIDITY
=========================================================
*/

function detectLiquiditySweep(candles) {
  if (candles.length < 8) {
    return {
      type: "NONE",
      direction: "NEUTRAL"
    };
  }

  const current =
    candles[candles.length - 1];

  const previous =
    candles[candles.length - 2];

  /*
  Buy-side liquidity sweep:
  Price takes previous high then closes below it.
  */

  if (
    current.high > previous.high &&
    current.close < previous.high
  ) {
    return {
      type: "BUY_SIDE_SWEEP",
      direction: "BEARISH"
    };
  }

  /*
  Sell-side liquidity sweep:
  Price takes previous low then closes above it.
  */

  if (
    current.low < previous.low &&
    current.close > previous.low
  ) {
    return {
      type: "SELL_SIDE_SWEEP",
      direction: "BULLISH"
    };
  }

  return {
    type: "NONE",
    direction: "NEUTRAL"
  };
}

/*
=========================================================
REJECTION
=========================================================
*/

function detectRejection(candle) {
  const body =
    Math.abs(candle.close - candle.open);

  const upperWick =
    candle.high -
    Math.max(candle.open, candle.close);

  const lowerWick =
    Math.min(candle.open, candle.close) -
    candle.low;

  if (
    body > 0 &&
    lowerWick > body * 1.5 &&
    candle.close > candle.open
  ) {
    return "BULLISH";
  }

  if (
    body > 0 &&
    upperWick > body * 1.5 &&
    candle.close < candle.open
  ) {
    return "BEARISH";
  }

  return "NONE";
}

/*
=========================================================
BREAKOUT
=========================================================
*/

function detectBreakout(candles) {
  if (candles.length < 7) {
    return "NONE";
  }

  const current =
    candles[candles.length - 1];

  const previous =
    candles.slice(
      candles.length - 6,
      candles.length - 1
    );

  const highest =
    Math.max(...previous.map(c => c.high));

  const lowest =
    Math.min(...previous.map(c => c.low));

  if (current.close > highest) {
    return "BULLISH";
  }

  if (current.close < lowest) {
    return "BEARISH";
  }

  return "NONE";
}

/*
=========================================================
ATR
=========================================================
*/

function calculateATR(candles, period = 14) {
  if (candles.length <= period) return null;

  const ranges = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );

    ranges.push(tr);
  }

  const recent =
    ranges.slice(-period);

  if (!recent.length) return null;

  return (
    recent.reduce((a, b) => a + b, 0) /
    recent.length
  );
}

/*
=========================================================
12H ANALYSIS
=========================================================
*/

async function analyze12H(pair) {
  let h1Candles;

  const cached = h1Cache[pair];

  if (
    cached &&
    Date.now() - cached.timestamp < H1_CACHE_MS
  ) {
    h1Candles = cached.candles;
  } else {
    h1Candles =
      await getClosedCandles(pair, "1h", 300);

    h1Cache[pair] = {
      candles: h1Candles,
      timestamp: Date.now()
    };
  }

  const candles12H =
    aggregate12HCandles(h1Candles);

  if (candles12H.length < 20) {
    return {
      trend: "NEUTRAL",
      candles: candles12H,
      rsi: null
    };
  }

  return {
    trend: getTrend(candles12H),
    candles: candles12H,
    rsi: calculateRSI(candles12H)
  };
}

/*
=========================================================
EXTENSION PROTECTION
=========================================================
*/

function isOverExtended(candles) {
  if (candles.length < 8) {
    return false;
  }

  const current =
    candles[candles.length - 1];

  const reference =
    candles[candles.length - 7];

  const atr =
    calculateATR(candles);

  if (!atr) return false;

  const move =
    Math.abs(current.close - reference.close);

  return move > atr * 2.5;
}

/*
=========================================================
FVG
=========================================================
*/

function findBullishFVG(candles) {
  if (candles.length < 3) {
    return null;
  }

  for (
    let i = candles.length - 1;
    i >= 2;
    i--
  ) {
    const a = candles[i - 2];
    const c = candles[i];

    if (c.low > a.high) {
      return {
        type: "BULLISH",
        low: a.high,
        high: c.low,
        index: i
      };
    }
  }

  return null;
}

function findBearishFVG(candles) {
  if (candles.length < 3) {
    return null;
  }

  for (
    let i = candles.length - 1;
    i >= 2;
    i--
  ) {
    const a = candles[i - 2];
    const c = candles[i];

    if (c.high < a.low) {
      return {
        type: "BEARISH",
        low: c.high,
        high: a.low,
        index: i
      };
    }
  }

  return null;
}

function candleTouchesFVG(candle, fvg) {
  if (!fvg) return false;

  return (
    candle.high >= fvg.low &&
    candle.low <= fvg.high
  );
}

/*
=========================================================
BIQUOTE NEWS CALENDAR
=========================================================
*/

function newsCountriesForPair(pair) {
  if (pair === "GBP/JPY") {
    return "GB,JP";
  }

  if (pair === "XAU/USD") {
    return "US";
  }

  return "US";
}

async function refreshNewsCalendar(force = false) {
  /*
  IMPORTANT:
  This function is protected against duplicate refreshes.

  It will NOT request the calendar again if it was
  refreshed within the last 5 minutes unless force=true.
  */

  if (
    !force &&
    lastNewsRefresh &&
    Date.now() - lastNewsRefresh <
      NEWS_REFRESH_MS
  ) {
    return state.news.events;
  }

  try {
    const now = new Date();

    const from =
      new Date(
        now.getTime() - 24 * 60 * 60 * 1000
      ).toISOString();

    const to =
      new Date(
        now.getTime() + 7 * 24 * 60 * 60 * 1000
      ).toISOString();

    /*
    We fetch both currencies together.

    GBP/JPY:
      GB + JP

    XAU/USD:
      US
    */

    const url =
      `https://biquote.io/api/calendar` +
      `?from=${encodeURIComponent(from)}` +
      `&to=${encodeURIComponent(to)}` +
      `&countries=US,GB,JP` +
      `&importance=high` +
      `&type=event` +
      `&limit=200`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Biquote calendar HTTP ${response.status}`
      );
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
      throw new Error(
        "Biquote calendar returned invalid data"
      );
    }

    state.news.events = data.filter(event => {
      return (
        event &&
        event.time &&
        event.timeMode === "exact"
      );
    });

    state.news.lastRefresh = nowIso();
    state.news.lastError = null;

    lastNewsRefresh = Date.now();

    return state.news.events;

  } catch (error) {
    state.news.lastError =
      error.message;

    /*
    FAIL OPEN:
    If the news service temporarily fails,
    keep the previous cached calendar and
    allow the normal strategy to continue.
    */

    return state.news.events;
  }
}

/*
=========================================================
RELEVANT NEWS EVENT
=========================================================
*/

function getRelevantNewsEvent(pair) {
  const countries =
    pair === "GBP/JPY"
      ? ["GB", "JP"]
      : ["US"];

  const now = Date.now();

  const relevant =
    state.news.events
      .filter(event => {
        const eventTime =
          new Date(event.time).getTime();

        if (!Number.isFinite(eventTime)) {
          return false;
        }

        if (
          !countries.includes(
            event.countryCode
          )
        ) {
          return false;
        }

        /*
        Relevant:
        15 minutes before
        through
        120 minutes after
        */

        return (
          eventTime >=
            now - 120 * 60 * 1000 &&
          eventTime <=
            now + 15 * 60 * 1000
        );
      })
      .sort(
        (a, b) =>
          new Date(a.time) -
          new Date(b.time)
      );

  return relevant[0] || null;
}

/*
=========================================================
RESET NEWS SEQUENCE
=========================================================
*/

function resetNewsSequence(pairState) {
  pairState.news = {
    phase: "NORMAL",
    eventKey: null,
    eventName: null,
    eventTime: null,

    direction: null,

    sequenceStart: null,

    liquiditySweep: false,
    sweepType: null,

    bosChoch: false,
    bosType: null,

    fvgFound: false,
    fvgType: null,
    fvgLow: null,
    fvgHigh: null,

    retracement: false,

    lastProcessedCandle: null
  };
}

/*
=========================================================
NEWS PROTECTION MESSAGE
=========================================================
*/

function newsProtectionMessage(pair) {
  const n =
    state.pairs[pair].news;

  if (n.phase === "PRE_NEWS") {
    return `NEWS WAIT: ${n.eventName}`;
  }

  if (n.phase === "POST_NEWS") {
    return `NEWS PROTECTION: ${n.eventName}`;
  }

  if (n.phase === "SEQUENCE") {
    return `NEWS SETUP: ${n.eventName}`;
  }

  return null;
}

/*
=========================================================
NEWS SEQUENCE PROCESSOR
=========================================================
*/

function processNewsProtection(
  pair,
  candles,
  event
) {
  const pairState =
    state.pairs[pair];

  const news =
    pairState.news;

  if (!event) {
    if (
      news.phase !== "NORMAL" &&
      news.sequenceStart
    ) {
      const age =
        Date.now() -
        news.sequenceStart;

      if (age > 120 * 60 * 1000) {
        resetNewsSequence(pairState);
      }
    }

    return {
      blocked: false,
      ready: false
    };
  }

  const eventTime =
    new Date(event.time).getTime();

  const now =
    Date.now();

  const minutesFromNews =
    (now - eventTime) / 60000;

  const eventKey =
    `${event.id || event.eventId || event.time}`;

  /*
  New event
  */

  if (news.eventKey !== eventKey) {
    resetNewsSequence(pairState);

    news.eventKey = eventKey;
    news.eventName =
      event.name || "High-impact news";
    news.eventTime = event.time;
  }

  /*
  =======================================================
  BEFORE NEWS
  =======================================================
  */

  if (minutesFromNews < 0) {
    news.phase = "PRE_NEWS";

    return {
      blocked: true,
      ready: false
    };
  }

  /*
  =======================================================
  IMMEDIATELY AFTER NEWS
  =======================================================
  */

  /*
  Wait for 2 fully closed 5M candles.
  */

  if (minutesFromNews < 10) {
    news.phase = "POST_NEWS";

    return {
      blocked: true,
      ready: false
    };
  }

  /*
  =======================================================
  AFTER NEWS: SEQUENCE
  =======================================================
  */

  if (!news.sequenceStart) {
    news.sequenceStart = eventTime;
  }

  news.phase = "SEQUENCE";

  /*
  Keep only closed candles.
  */

  const recent =
    candles.slice(-30);

  if (recent.length < 10) {
    return {
      blocked: true,
      ready: false
    };
  }

  const lastCandle =
    recent[recent.length - 1];

  /*
  Avoid processing the exact same candle repeatedly.
  */

  if (
    news.lastProcessedCandle ===
    lastCandle.datetime
  ) {
    return {
      blocked: !news.retracement,
      ready: news.retracement
    };
  }

  news.lastProcessedCandle =
    lastCandle.datetime;

  /*
  =======================================================
  STEP 1: LIQUIDITY SWEEP
  =======================================================
  */

  if (!news.liquiditySweep) {
    const sweep =
      detectLiquiditySweep(recent);

    if (
      sweep.type ===
      "SELL_SIDE_SWEEP"
    ) {
      news.liquiditySweep = true;
      news.sweepType =
        "SELL_SIDE_SWEEP";
      news.direction = "BUY";
    }

    else if (
      sweep.type ===
      "BUY_SIDE_SWEEP"
    ) {
      news.liquiditySweep = true;
      news.sweepType =
        "BUY_SIDE_SWEEP";
      news.direction = "SELL";
    }

    return {
      blocked: true,
      ready: false
    };
  }

  /*
  =======================================================
  STEP 2: BOS / CHOCH
  =======================================================
  */

  if (!news.bosChoch) {
    const structure =
      getStructure(recent);

    if (
      news.direction === "BUY" &&
      structure.direction ===
        "BULLISH"
    ) {
      news.bosChoch = true;
      news.bosType =
        structure.type;
    }

    if (
      news.direction === "SELL" &&
      structure.direction ===
        "BEARISH"
    ) {
      news.bosChoch = true;
      news.bosType =
        structure.type;
    }

    return {
      blocked: true,
      ready: false
    };
  }

  /*
  =======================================================
  STEP 3: FVG
  =======================================================
  */

  if (!news.fvgFound) {
    let fvg = null;

    if (news.direction === "BUY") {
      fvg = findBullishFVG(recent);
    }

    if (news.direction === "SELL") {
      fvg = findBearishFVG(recent);
    }

    if (fvg) {
      news.fvgFound = true;
      news.fvgType = fvg.type;
      news.fvgLow = fvg.low;
      news.fvgHigh = fvg.high;
    }

    return {
      blocked: true,
      ready: false
    };
  }

  /*
  =======================================================
  STEP 4: RETRACEMENT INTO FVG
  =======================================================
  */

  if (!news.retracement) {
    const fvg = {
      type: news.fvgType,
      low: news.fvgLow,
      high: news.fvgHigh
    };

    if (
      candleTouchesFVG(
        lastCandle,
        fvg
      )
    ) {
      news.retracement = true;

      return {
        blocked: false,
        ready: true
      };
    }

    return {
      blocked: true,
      ready: false
    };
  }

  return {
    blocked: false,
    ready: true
  };
}

/*
=========================================================
BUILD NEWS PROTECTION
=========================================================
*/

function buildNewsProtection(pair) {
  const n =
    state.pairs[pair].news;

  return {
    phase: n.phase,
    eventName: n.eventName,
    eventTime: n.eventTime,

    direction: n.direction,

    liquiditySweep:
      n.liquiditySweep,

    sweepType:
      n.sweepType,

    bosChoch:
      n.bosChoch,

    bosType:
      n.bosType,

    fvgFound:
      n.fvgFound,

    fvgType:
      n.fvgType,

    fvgLow:
      n.fvgLow,

    fvgHigh:
      n.fvgHigh,

    retracement:
      n.retracement
  };
}

/*
=========================================================
PAIR ANALYSIS
=========================================================
*/

async function analyzePair(pair) {
  /*
  H1
  */

  const h1 =
    await getClosedCandles(
      pair,
      "1h",
      200
    );

  /*
  12H
  */

  const analysis12H =
    await analyze12H(pair);

  /*
  5M
  */

  const candles5M =
    await getClosedCandles(
      pair,
      INTERVAL,
      200
    );

  if (candles5M.length < 30) {
    throw new Error(
      `Not enough 5M candles for ${pair}`
    );
  }

  const current =
    candles5M[candles5M.length - 1];

  const price =
    current.close;

  /*
  =======================================================
  NORMAL INDICATORS
  =======================================================
  */

  const trend12H =
    analysis12H.trend;

  const trend1H =
    getTrend(h1);

  const trend5M =
    getTrend(candles5M);

  const rsi =
    calculateRSI(candles5M);

  const structure =
    getStructure(candles5M);

  const liquidity =
    detectLiquiditySweep(candles5M);

  const rejection =
    detectRejection(current);

  const breakout =
    detectBreakout(candles5M);

  const atr =
    calculateATR(candles5M);

  /*
  =======================================================
  NEWS
  =======================================================
  */

  const event =
    getRelevantNewsEvent(pair);

  const newsResult =
    processNewsProtection(
      pair,
      candles5M,
      event
    );

  /*
  =======================================================
  SCORE
  =======================================================
  */

  let buyScore = 0;
  let sellScore = 0;

  /*
  12H
  */

  if (trend12H === "BULLISH") {
    buyScore += 2;
  }

  if (trend12H === "BEARISH") {
    sellScore += 2;
  }

  /*
  1H
  */

  if (trend1H === "BULLISH") {
    buyScore += 1;
  }

  if (trend1H === "BEARISH") {
    sellScore += 1;
  }

  /*
  5M
  */

  if (trend5M === "BULLISH") {
    buyScore += 1;
  }

  if (trend5M === "BEARISH") {
    sellScore += 1;
  }

  /*
  RSI
  */

  if (rsi !== null) {
    if (rsi >= 50 && rsi < 75) {
      buyScore += 1;
    }

    if (rsi < 50 && rsi > 25) {
      sellScore += 1;
    }
  }

  /*
  SMC / structure
  */

  if (
    structure.direction ===
    "BULLISH"
  ) {
    buyScore += 1;
  }

  if (
    structure.direction ===
    "BEARISH"
  ) {
    sellScore += 1;
  }

  /*
  CHOCH / BOS confirmation
  */

  if (
    structure.type === "BOS" &&
    structure.direction ===
      "BULLISH"
  ) {
    buyScore += 1;
  }

  if (
    structure.type === "BOS" &&
    structure.direction ===
      "BEARISH"
  ) {
    sellScore += 1;
  }

  /*
  Cap normal score at 5.
  */

  buyScore =
    Math.min(buyScore, 5);

  sellScore =
    Math.min(sellScore, 5);

  /*
  =======================================================
  EXTENSION PROTECTION
  =======================================================
  */

  const extended =
    isOverExtended(candles5M);

  /*
  =======================================================
  DEFAULT RESULT
  =======================================================
  */

  let direction = "WAIT";
  let score = 0;
  let entry = null;
  let stopLoss = null;
  let takeProfit = null;

  /*
  =======================================================
  NEWS BLOCK
  =======================================================
  */

  if (newsResult.blocked) {
    return {
      pair,
      status: "WAIT",
      direction: "WAIT",

      entry: null,
      stopLoss: null,
      takeProfit: null,

      score: 0,

      trend12H,
      trend1H,
      trend5M,

      rsi:
        rsi !== null
          ? round(rsi, 1)
          : null,

      structure,
      liquidity,
      rejection,
      breakout,

      atr:
        atr !== null
          ? round(atr, 6)
          : null,

      extended,

      newsProtection:
        buildNewsProtection(pair),

      newsMessage:
        newsProtectionMessage(pair),

      candles: {
        lastCandle:
          current.datetime
      }
    };
  }

  /*
  =======================================================
  POST-NEWS READY
  =======================================================
  */

  const postNewsReady =
    state.pairs[pair].news.retracement;

  /*
  If the news sequence is ready,
  allow the signal without adding
  another score requirement.

  Direction follows the confirmed
  post-news sequence.
  */

  if (
    postNewsReady &&
    state.pairs[pair].news.direction ===
      "BUY"
  ) {
    if (
      buyScore >= 3 ||
      trend5M === "BULLISH"
    ) {
      direction = "BUY";
      score = Math.max(buyScore, 4);
    }
  }

  if (
    postNewsReady &&
    state.pairs[pair].news.direction ===
      "SELL"
  ) {
    if (
      sellScore >= 3 ||
      trend5M === "BEARISH"
    ) {
      direction = "SELL";
      score = Math.max(sellScore, 4);
    }
  }

  /*
  =======================================================
  NORMAL STRATEGY
  =======================================================
  */

  if (!postNewsReady) {
    /*
    BUY
    */

    if (
      buyScore >= 4 &&
      trend12H === "BULLISH" &&
      trend1H === "BULLISH" &&
      (
        trend5M === "BULLISH" ||
        structure.direction === "BULLISH" ||
        liquidity.direction === "BULLISH"
      )
    ) {
      direction = "BUY";
      score = buyScore;
    }

    /*
    SELL
    */

    if (
      sellScore >= 4 &&
      trend12H === "BEARISH" &&
      trend1H === "BEARISH" &&
      (
        trend5M === "BEARISH" ||
        structure.direction === "BEARISH" ||
        liquidity.direction === "BEARISH"
      )
    ) {
      direction = "SELL";
      score = sellScore;
    }
  }

  /*
  =======================================================
  EXTENSION PROTECTION
  =======================================================
  */

  if (extended) {
    direction = "WAIT";
    score = 0;
  }

  /*
  =======================================================
  ENTRY / SL / TP
  =======================================================
  */

  if (
    direction === "BUY" &&
    atr
  ) {
    entry = price;

    stopLoss =
      price - atr * 1.2;

    const risk =
      entry - stopLoss;

    takeProfit =
      entry + risk * 2;
  }

  if (
    direction === "SELL" &&
    atr
  ) {
    entry = price;

    stopLoss =
      price + atr * 1.2;

    const risk =
      stopLoss - entry;

    takeProfit =
      entry - risk * 2;
  }

  /*
  =======================================================
  RESULT
  =======================================================
  */

  return {
    pair,

    status:
      direction === "WAIT"
        ? "WAIT"
        : direction,

    direction,

    entry:
      entry !== null
        ? round(
            entry,
            priceDigits(pair)
          )
        : null,

    stopLoss:
      stopLoss !== null
        ? round(
            stopLoss,
            priceDigits(pair)
          )
        : null,

    takeProfit:
      takeProfit !== null
        ? round(
            takeProfit,
            priceDigits(pair)
          )
        : null,

    score,

    trend12H,
    trend1H,
    trend5M,

    rsi:
      rsi !== null
        ? round(rsi, 1)
        : null,

    structure,
    liquidity,
    rejection,
    breakout,

    atr:
      atr !== null
        ? round(atr, 6)
        : null,

    extended,

    newsProtection:
      buildNewsProtection(pair),

    newsMessage:
      newsProtectionMessage(pair),

    candles: {
      lastCandle:
        current.datetime
    }
  };
}

/*
=========================================================
TELEGRAM
=========================================================
*/

async function sendTelegramMessage(message) {
  if (
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {
    return false;
  }

  const url =
    `https://api.telegram.org/bot` +
    `${TELEGRAM_BOT_TOKEN}/sendMessage`;

  try {
    const response = await fetch(url, {
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

    return response.ok;

  } catch (error) {
    console.error(
      "Telegram error:",
      error.message
    );

    return false;
  }
}

/*
=========================================================
TELEGRAM SIGNAL FORMAT
=========================================================
*/

function formatSignal(signal) {
  const pair =
    signal.pair;

  const emoji =
    signal.direction === "BUY"
      ? "🟢"
      : "🔴";

  const title =
    signal.direction === "BUY"
      ? "STRONG BUY"
      : "STRONG SELL";

  let text =
    `${emoji} ${title}: ${pair}\n\n`;

  text +=
    `📍 Entry: ${formatPrice(
      pair,
      signal.entry
    )}\n`;

  text +=
    `🛑 Stop Loss: ${formatPrice(
      pair,
      signal.stopLoss
    )}\n`;

  text +=
    `🎯 Take Profit: ${formatPrice(
      pair,
      signal.takeProfit
    )}\n`;

  text +=
    `⭐ Score: ${signal.score}/5\n\n`;

  text +=
    `📊 12H: ${signal.trend12H}\n`;

  text +=
    `📊 1H: ${signal.trend1H}\n`;

  text +=
    `📊 5M: ${signal.trend5M}\n`;

  if (signal.rsi !== null) {
    text +=
      `RSI: ${signal.rsi}\n`;
  }

  text +=
    `🔎 SMC: ${signal.structure.type} ${signal.structure.direction}\n`;

  text +=
    `💧 Liquidity: ${signal.liquidity.type}\n`;

  if (
    signal.newsProtection &&
    signal.newsProtection.phase !==
      "NORMAL"
  ) {
    text +=
      `\n📰 NEWS: ${signal.newsProtection.eventName}\n`;

    text +=
      `🔄 Sequence: Liquidity Sweep → BOS/CHoCH → FVG → Retracement\n`;
  }

  text +=
    `\n⚖️ Risk/Reward: 1:2`;

  return text;
}

/*
=========================================================
SCAN ONE PAIR
=========================================================
*/

async function scanPair(pair) {
  try {
    const result =
      await analyzePair(pair);

    const previous =
      state.pairs[pair].signal;

    state.pairs[pair].signal =
      result;

    state.pairs[pair].status =
      result.status;

    /*
    Send only when a new BUY/SELL signal appears.
    */

    if (
      result.direction !== "WAIT" &&
      result.direction !==
        state.pairs[pair].lastSignalDirection
    ) {
      const message =
        formatSignal(result);

      await sendTelegramMessage(message);

      state.performance.signals++;

      state.pairs[pair]
        .lastSignalDirection =
        result.direction;

      state.pairs[pair]
        .lastSignalTime =
        Date.now();
    }

    /*
    Reset signal direction when strategy
    returns to WAIT.
    */

    if (
      result.direction === "WAIT"
    ) {
      state.pairs[pair]
        .lastSignalDirection =
        null;
    }

    return result;

  } catch (error) {
    state.performance.errors++;

    state.api.lastError =
      error.message;

    state.pairs[pair].status =
      "OFFLINE";

    state.pairs[pair].signal = {
      pair,
      status: "OFFLINE",
      direction: "WAIT",
      error: error.message
    };

    console.error(
      `[${pair}] ${error.message}`
    );

    return state.pairs[pair].signal;
  }
}

/*
=========================================================
SCAN ALL
=========================================================
*/

let scanRunning = false;

async function scanAll() {
  if (scanRunning) {
    return;
  }

  scanRunning = true;

  try {
    state.online = true;

    /*
    IMPORTANT:
    News calendar refresh happens here ONLY
    when the 5-minute refresh period has expired.

    There is NO second news setInterval.
    */

    await refreshNewsCalendar();

    state.lastScan = nowIso();

    state.performance.scans++;

    for (const pair of PAIRS) {
      await scanPair(pair);

      await sleep(TWELVE_DELAY_MS);
    }

  } catch (error) {
    state.performance.errors++;

    state.api.lastError =
      error.message;

    console.error(
      "Scan error:",
      error.message
    );

  } finally {
    scanRunning = false;
  }
}

/*
=========================================================
API: STATUS
=========================================================
*/

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,

    online: state.online,

    lastScan:
      state.lastScan,

    timeframe:
      state.timeframe,

    pairs:
      state.pairs,

    performance:
      state.performance,

    api:
      state.api,

    news: {
      source:
        state.news.source,

      lastRefresh:
        state.news.lastRefresh,

      lastError:
        state.news.lastError,

      eventCount:
        state.news.events.length
    }
  });
});

/*
=========================================================
API: ALERTS
=========================================================
*/

app.get("/api/alerts", (req, res) => {
  const alerts = [];

  for (const pair of PAIRS) {
    const signal =
      state.pairs[pair].signal;

    if (
      signal &&
      signal.direction !== "WAIT"
    ) {
      alerts.push(signal);
    }
  }

  res.json({
    ok: true,
    alerts
  });
});

/*
=========================================================
API: MANUAL SCAN
=========================================================
*/

app.get("/api/scan", async (req, res) => {
  await scanAll();

  res.json({
    ok: true,
    lastScan:
      state.lastScan,
    pairs:
      state.pairs
  });
});

/*
=========================================================
HEALTH
=========================================================
*/

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    time: nowIso()
  });
});

/*
=========================================================
ROOT API
=========================================================
*/

app.get("/api", (req, res) => {
  res.json({
    name:
      "Trading Cloud Monitor",

    status: "online",

    strategy:
      "12H + 1H + 5M",

    pairs:
      PAIRS,

    newsProtection: true,

    newsSequence:
      "WAIT → 5M Liquidity Sweep → BOS/CHoCH → FVG → Retracement",

    newsProvider:
      "Biquote",

    newsRefresh:
      "5 minutes",

    twelveDataTimeframe:
      INTERVAL
  });
});

/*
=========================================================
START SERVER
=========================================================
*/

app.listen(PORT, () => {
  console.log(
    `Trading Cloud Monitor running on port ${PORT}`
  );

  console.log(
    `Pairs: ${PAIRS.join(", ")}`
  );

  console.log(
    `Timeframe: ${INTERVAL}`
  );

  console.log(
    "News protection: ENABLED"
  );

  console.log(
    "News calendar: Biquote"
  );

  console.log(
    "News calendar refresh: once per 5 minutes"
  );

  /*
  Initial scan
  */

  scanAll();

  /*
  Main 5-minute scan.
  There is deliberately NO separate
  refreshNewsCalendar interval.
  */

  setInterval(
    scanAll,
    POLL_MS
  );
});
