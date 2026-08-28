const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* =========================================================
   TRADING CLOUD MONITOR
   Version 2

   DATA:
   - Twelve Data
   - 7 monitored pairs

   TIMEFRAMES:
   - H12 = higher-timeframe context
   - H1  = primary structure
   - M5  = entry confirmation

   IMPORTANT:
   This version is deliberately conservative with API usage.
========================================================= */


/* =========================================================
   CONFIGURATION
========================================================= */

const PORT = process.env.PORT || 3000;

const API_KEY =
  process.env.TWELVE_DATA_API_KEY || "";

const TELEGRAM_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || "";

const TELEGRAM_CHAT_ID =
  process.env.TELEGRAM_CHAT_ID || "";


/*
   5M is the entry timeframe.
*/
const ENTRY_INTERVAL = "5min";


/*
   We scan every 20 minutes.

   With 7 pairs:
   - 5M data = 7 requests every 20 min
   - 1H data = 7 requests every hour

   Approximately:
   5M: 504/day
   1H: 168/day
   Total: ~672/day

   This leaves some safety room below an 800-credit
   daily allowance.
*/
const POLL_MS = Math.max(
  20 * 60 * 1000,
  Number(process.env.POLL_MS || 20 * 60 * 1000)
);


/*
   Delay between individual API requests.
*/
const REQUEST_DELAY_MS = Math.max(
  1500,
  Number(process.env.REQUEST_DELAY_MS || 1800)
);


/*
   Twelve Data cooldown after HTTP 429.
*/
const API_COOLDOWN_MS =
  5 * 60 * 1000;


/*
   Pairs.
*/
const pairs = [
  "EUR/USD",
  "GBP/USD",
  "USD/CAD",
  "XAU/USD",
  "USD/CHF",
  "EUR/GBP",
  "GBP/CHF"
];


/* =========================================================
   CACHE SETTINGS
========================================================= */

const CACHE_MS = {
  "1h": 60 * 60 * 1000,
  "5min": 20 * 60 * 1000
};

const candleCache = new Map();


/* =========================================================
   STATE
========================================================= */

const state = {

  lastScan: null,

  nextScan: null,

  scanning: false,

  pairs: {},

  alertsEnabled: true,

  api: {

    status:
      API_KEY
        ? "READY"
        : "NOT CONFIGURED",

    lastError: null,

    last429: null,

    cooldownUntil: null,

    requestsThisScan: 0,

    totalRequests: 0,

    dailyRequests: 0,

    dailyDate:
      new Date().toISOString().slice(0, 10)
  }
};


/* =========================================================
   SIGNAL STATE
========================================================= */

const lastSignal = {};


/* =========================================================
   UTILITY
========================================================= */

function sleep(ms) {

  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}


function todayKey() {

  return new Date()
    .toISOString()
    .slice(0, 10);
}


function resetDailyCounterIfNeeded() {

  const today =
    todayKey();

  if (
    state.api.dailyDate !== today
  ) {

    state.api.dailyDate = today;

    state.api.dailyRequests = 0;
  }
}


function roundPrice(value, pair) {

  if (
    !Number.isFinite(value)
  ) {
    return value;
  }


  /*
    Gold generally needs fewer decimal places
    than FX pairs.
  */

  if (
    pair === "XAU/USD"
  ) {

    return +value.toFixed(2);
  }


  return +value.toFixed(5);
}


function safeNumber(value) {

  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : 0;
}


/* =========================================================
   EMA
========================================================= */

function ema(values, period) {

  if (
    !Array.isArray(values) ||
    values.length === 0
  ) {

    return 0;
  }


  if (
    values.length < period
  ) {

    return values[values.length - 1];
  }


  const multiplier =
    2 / (period + 1);


  let result =
    values[0];


  for (
    let i = 1;
    i < values.length;
    i++
  ) {

    result =
      (
        values[i] -
        result
      ) *
      multiplier +
      result;
  }


  return result;
}


/* =========================================================
   RSI
========================================================= */

function rsi(values, period = 14) {

  if (
    !Array.isArray(values) ||
    values.length <
      period + 1
  ) {

    return 50;
  }


  let gains = 0;
  let losses = 0;


  for (
    let i =
      values.length - period;
    i < values.length;
    i++
  ) {

    const difference =
      values[i] -
      values[i - 1];


    if (
      difference > 0
    ) {

      gains += difference;

    } else {

      losses -= difference;
    }
  }


  if (
    losses === 0
  ) {

    return 100;
  }


  const averageGain =
    gains / period;

  const averageLoss =
    losses / period;


  const relativeStrength =
    averageGain /
    averageLoss;


  return 100 -
    (
      100 /
      (1 + relativeStrength)
    );
}


/* =========================================================
   CANDLE HELPERS
========================================================= */

function candleDirection(candle) {

  const open =
    safeNumber(candle.open);

  const close =
    safeNumber(candle.close);


  if (
    close > open
  ) {

    return "BULLISH";
  }


  if (
    close < open
  ) {

    return "BEARISH";
  }


  return "NEUTRAL";
}


function bodySize(candle) {

  return Math.abs(
    safeNumber(candle.close) -
    safeNumber(candle.open)
  );
}


function candleRange(candle) {

  return (
    safeNumber(candle.high) -
    safeNumber(candle.low)
  );
}


/* =========================================================
   SMC STRUCTURE
========================================================= */

function analyzeStructure(candles) {

  if (
    !Array.isArray(candles) ||
    candles.length < 25
  ) {

    return {

      bias: "NEUTRAL",

      bos: false,

      choch: false,

      sweep: false,

      rejection: false,

      strength: "WEAK",

      swingHigh: 0,

      swingLow: 0
    };
  }


  /*
    Only COMPLETED candles are used.

    The latest candle is excluded because it may still
    be forming.
  */

  const completed =
    candles.slice(0, -1);


  const last =
    completed[completed.length - 1];

  const previous =
    completed[completed.length - 2];


  /*
    Structure range.

    We exclude the last few candles so that the current
    structure is not contaminated by the immediate candle.
  */

  const structureWindow =
    completed.slice(-22, -4);


  if (
    structureWindow.length < 10
  ) {

    return {

      bias: "NEUTRAL",

      bos: false,

      choch: false,

      sweep: false,

      rejection: false,

      strength: "WEAK",

      swingHigh: 0,

      swingLow: 0
    };
  }


  const swingHigh =
    Math.max(
      ...structureWindow.map(
        c => safeNumber(c.high)
      )
    );


  const swingLow =
    Math.min(
      ...structureWindow.map(
        c => safeNumber(c.low)
      )
    );


  const close =
    safeNumber(last.close);

  const open =
    safeNumber(last.open);

  const high =
    safeNumber(last.high);

  const low =
    safeNumber(last.low);


  const previousClose =
    safeNumber(previous.close);


  /*
    Break of structure.
  */

  const bullishBOS =
    close > swingHigh;

  const bearishBOS =
    close < swingLow;


  /*
    Liquidity sweeps.

    Bullish sweep:
    price trades below the swing low and closes back above it.

    Bearish sweep:
    price trades above the swing high and closes back below it.
  */

  const bullishSweep =
    low < swingLow &&
    close > swingLow;


  const bearishSweep =
    high > swingHigh &&
    close < swingHigh;


  /*
    Rejection detection.
  */

  const range =
    candleRange(last);


  const body =
    bodySize(last);


  const upperWick =
    high -
    Math.max(open, close);


  const lowerWick =
    Math.min(open, close) -
    low;


  const bullishRejection =
    range > 0 &&
    lowerWick > body * 1.2 &&
    close > open;


  const bearishRejection =
    range > 0 &&
    upperWick > body * 1.2 &&
    close < open;


  /*
    EMA trend support.
  */

  const closes =
    completed.map(
      c => safeNumber(c.close)
    );


  const ema20 =
    ema(closes, 20);

  const ema50 =
    ema(closes, 50);


  let bias =
    "NEUTRAL";


  if (
    bullishBOS ||
    bullishSweep
  ) {

    bias = "BULLISH";

  } else if (
    bearishBOS ||
    bearishSweep
  ) {

    bias = "BEARISH";

  } else if (
    ema20 > ema50 &&
    close > ema20
  ) {

    bias = "BULLISH";

  } else if (
    ema20 < ema50 &&
    close < ema20
  ) {

    bias = "BEARISH";
  }


  let strength =
    "WEAK";


  if (
    bullishBOS ||
    bearishBOS
  ) {

    strength = "STRONG";

  } else if (
    bullishSweep ||
    bearishSweep
  ) {

    strength = "CONFIRMED";

  } else if (
    bias !== "NEUTRAL"
  ) {

    strength = "DEVELOPING";
  }


  /*
    Basic CHOCH interpretation.

    A bullish CHOCH occurs when price moves bullishly after
    a bearish structure environment.

    A bearish CHOCH is the opposite.
  */

  const previousDirection =
    candleDirection(previous);

  const currentDirection =
    candleDirection(last);


  const choch =
    (
      bias === "BULLISH" &&
      previousDirection === "BEARISH" &&
      currentDirection === "BULLISH"
    ) ||
    (
      bias === "BEARISH" &&
      previousDirection === "BULLISH" &&
      currentDirection === "BEARISH"
    );


  return {

    bias,

    bos:
      bullishBOS ||
      bearishBOS,

    choch,

    sweep:
      bullishSweep ||
      bearishSweep,

    rejection:
      bullishRejection ||
      bearishRejection,

    strength,

    swingHigh,

    swingLow,

    ema20,

    ema50,

    close,

    bullishBOS,

    bearishBOS,

    bullishSweep,

    bearishSweep,

    bullishRejection,

    bearishRejection
  };
}


/* =========================================================
   BUILD H12 FROM COMPLETED H1 CANDLES
========================================================= */

function build12HCandles(hourly) {

  if (
    !Array.isArray(hourly) ||
    hourly.length < 24
  ) {

    return [];
  }


  /*
    Remove the currently forming H1 candle.
  */

  const completed =
    hourly.slice(0, -1);


  const groups =
    new Map();


  for (
    const candle of completed
  ) {

    const date =
      new Date(candle.datetime);


    if (
      Number.isNaN(
        date.getTime()
      )
    ) {

      continue;
    }


    const year =
      date.getUTCFullYear();

    const month =
      String(
        date.getUTCMonth() + 1
      ).padStart(2, "0");

    const day =
      String(
        date.getUTCDate()
      ).padStart(2, "0");

    const hour =
      date.getUTCHours();


    /*
      00:00 UTC - 11:00 UTC
      becomes one H12 candle.

      12:00 UTC - 23:00 UTC
      becomes another H12 candle.
    */

    const bucketHour =
      hour < 12
        ? 0
        : 12;


    const key =
      `${year}-${month}-${day} ${String(
        bucketHour
      ).padStart(2, "0")}:00:00`;


    if (
      !groups.has(key)
    ) {

      groups.set(
        key,
        []
      );
    }


    groups
      .get(key)
      .push(candle);
  }


  const result = [];


  for (
    const [
      datetime,
      candles
    ] of groups
  ) {

    /*
      Require at least 10 completed H1 candles
      to construct a reliable H12 candle.

      A normal completed H12 period has 12 candles.
    */

    if (
      candles.length < 10
    ) {

      continue;
    }


    candles.sort(
      (a, b) =>
        new Date(a.datetime) -
        new Date(b.datetime)
    );


    const first =
      candles[0];

    const last =
      candles[candles.length - 1];


    result.push({

      datetime,

      open:
        safeNumber(first.open),

      high:
        Math.max(
          ...candles.map(
            c => safeNumber(c.high)
          )
        ),

      low:
        Math.min(
          ...candles.map(
            c => safeNumber(c.low)
          )
        ),

      close:
        safeNumber(last.close),

      volume:
        candles.reduce(
          (sum, c) =>
            sum +
            safeNumber(c.volume),
          0
        )
    });
  }


  return result.sort(
    (a, b) =>
      new Date(a.datetime) -
      new Date(b.datetime)
  );
}


/* =========================================================
   TWELVE DATA
========================================================= */

async function fetchCandles(
  pair,
  interval
) {

  resetDailyCounterIfNeeded();


  if (!API_KEY) {

    state.api.status =
      "NOT CONFIGURED";

    throw new Error(
      "TWELVE_DATA_API_KEY is not configured"
    );
  }


  /*
    Never deliberately exceed the known daily allowance.

    This is an emergency safety guard.
  */

  if (
    state.api.dailyRequests >= 780
  ) {

    state.api.status =
      "DAILY LIMIT PROTECTION";

    throw new Error(
      "Daily API safety limit reached"
    );
  }


  /*
    Global cooldown.
  */

  if (
    Date.now() <
    apiCooldownUntil
  ) {

    const seconds =
      Math.ceil(
        (
          apiCooldownUntil -
          Date.now()
        ) / 1000
      );


    throw new Error(
      `Twelve Data cooldown (${seconds}s)`
    );
  }


  const outputSize =
    interval === "1h"
      ? 300
      : 120;


  const url =
    "https://api.twelvedata.com/time_series" +
    "?symbol=" +
    encodeURIComponent(pair) +
    "&interval=" +
    encodeURIComponent(interval) +
    "&outputsize=" +
    outputSize +
    "&apikey=" +
    encodeURIComponent(API_KEY);


  state.api.requestsThisScan++;
  state.api.totalRequests++;
  state.api.dailyRequests++;


  let response;


  try {

    response =
      await fetch(url);

  } catch (error) {

    state.api.status =
      "NETWORK ERROR";

    state.api.lastError =
      error.message;


    throw error;
  }


  /*
    Rate limit.
  */

  if (
    response.status === 429
  ) {

    apiCooldownUntil =
      Date.now() +
      API_COOLDOWN_MS;


    state.api.status =
      "RATE LIMITED";


    state.api.last429 =
      new Date().toISOString();


    state.api.cooldownUntil =
      new Date(
        apiCooldownUntil
      ).toISOString();


    state.api.lastError =
      "Twelve Data HTTP 429";


    throw new Error(
      "Twelve Data HTTP 429 - API limit reached"
    );
  }


  if (
    !response.ok
  ) {

    const error =
      `Twelve Data HTTP ${response.status}`;


    state.api.status =
      "API ERROR";

    state.api.lastError =
      error;


    throw new Error(error);
  }


  let data;


  try {

    data =
      await response.json();

  } catch (error) {

    state.api.status =
      "API ERROR";

    state.api.lastError =
      "Invalid JSON response";


    throw new Error(
      "Invalid Twelve Data response"
    );
  }


  if (
    data.status === "error"
  ) {

    const message =
      data.message ||
      "Twelve Data error";


    if (
      /limit|credit|rate/i.test(
        message
      )
    ) {

      apiCooldownUntil =
        Date.now() +
        API_COOLDOWN_MS;


      state.api.status =
        "RATE LIMITED";


      state.api.last429 =
        new Date().toISOString();


      state.api.cooldownUntil =
        new Date(
          apiCooldownUntil
        ).toISOString();
    }


    state.api.lastError =
      message;


    throw new Error(message);
  }


  if (
    !Array.isArray(data.values) ||
    data.values.length === 0
  ) {

    throw new Error(
      "No candle data returned"
    );
  }


  state.api.status =
    "CONNECTED";

  state.api.lastError =
    null;

  state.api.cooldownUntil =
    null;


  return data.values
    .slice()
    .reverse();
}


/* =========================================================
   CACHED CANDLES
========================================================= */

async function getCandles(
  pair,
  interval
) {

  const key =
    `${pair}:${interval}`;


  const now =
    Date.now();


  const cached =
    candleCache.get(key);


  if (
    cached &&
    now - cached.time <
      CACHE_MS[interval]
  ) {

    return cached.data;
  }


  /*
    Delay before requesting the API.
  */

  await sleep(
    REQUEST_DELAY_MS
  );


  /*
    Check cooldown again after sleeping.
  */

  if (
    Date.now() <
    apiCooldownUntil
  ) {

    throw new Error(
      "Twelve Data cooldown active"
    );
  }


  const data =
    await fetchCandles(
      pair,
      interval
    );


  candleCache.set(
    key,
    {

      data,

      time:
        Date.now()
    }
  );


  return data;
}


/* =========================================================
   5M ENTRY ANALYSIS
========================================================= */

function analyze5MEntry(candles) {

  if (
    !Array.isArray(candles) ||
    candles.length < 30
  ) {

    return {

      direction: "NEUTRAL",

      score: 0,

      reason:
        "Not enough 5M candles",

      entry: null,

      stopLoss: null,

      takeProfit: null
    };
  }


  /*
    Exclude live candle.

    We only trigger from a completed 5M candle.
  */

  const completed =
    candles.slice(0, -1);


  const current =
    completed[
      completed.length - 1
    ];

  const previous =
    completed[
      completed.length - 2
    ];


  const recent =
    completed.slice(-13, -1);


  const recentHigh =
    Math.max(
      ...recent.map(
        c => safeNumber(c.high)
      )
    );


  const recentLow =
    Math.min(
      ...recent.map(
        c => safeNumber(c.low)
      )
    );


  const range =
    recentHigh -
    recentLow;


  if (
    range <= 0
  ) {

    return {

      direction: "NEUTRAL",

      score: 0,

      reason:
        "Invalid 5M range",

      entry: null,

      stopLoss: null,

      takeProfit: null
    };
  }


  const open =
    safeNumber(current.open);

  const close =
    safeNumber(current.close);

  const high =
    safeNumber(current.high);

  const low =
    safeNumber(current.low);


  const previousHigh =
    safeNumber(previous.high);

  const previousLow =
    safeNumber(previous.low);


  const currentRange =
    high - low;


  const body =
    Math.abs(
      close - open
    );


  const upperWick =
    high -
    Math.max(open, close);


  const lowerWick =
    Math.min(open, close) -
    low;


  /*
    Momentum.
  */

  const closes =
    completed.map(
      c => safeNumber(c.close)
    );


  const currentRSI =
    rsi(closes, 14);


  const ema9 =
    ema(closes, 9);

  const ema21 =
    ema(closes, 21);


  /*
    Bullish conditions.
  */

  const bullishCandle =
    close > open;


  const bearishCandle =
    close < open;


  const bullishBreak =
    close > previousHigh;


  const bearishBreak =
    close < previousLow;


  const bullishSweep =
    low < recentLow &&
    close > recentLow;


  const bearishSweep =
    high > recentHigh &&
    close < recentHigh;


  const bullishRejection =
    currentRange > 0 &&
    lowerWick >
      body * 1.15 &&
    close > open;


  const bearishRejection =
    currentRange > 0 &&
    upperWick >
      body * 1.15 &&
    close < open;


  const bullishMomentum =
    ema9 > ema21 &&
    close > ema9;


  const bearishMomentum =
    ema9 < ema21 &&
    close < ema9;


  /*
    Pullback location.

    We don't want to buy after price has already travelled
    almost the entire range.
  */

  const bullishExtension =
    (
      close -
      recentLow
    ) / range;


  const bearishExtension =
    (
      recentHigh -
      close
    ) / range;


  const buyNotLate =
    bullishExtension <= 0.80;


  const sellNotLate =
    bearishExtension <= 0.80;


  /*
    BUY SCORE
  */

  let buyScore = 0;

  const buyReasons = [];


  if (
    bullishCandle
  ) {

    buyScore += 1;

    buyReasons.push(
      "bullish candle"
    );
  }


  if (
    bullishBreak
  ) {

    buyScore += 2;

    buyReasons.push(
      "5M BOS"
    );
  }


  if (
    bullishSweep
  ) {

    buyScore += 2;

    buyReasons.push(
      "liquidity sweep"
    );
  }


  if (
    bullishRejection
  ) {

    buyScore += 1;

    buyReasons.push(
      "rejection"
    );
  }


  if (
    bullishMomentum
  ) {

    buyScore += 1;

    buyReasons.push(
      "momentum"
    );
  }


  if (
    currentRSI >= 50 &&
    currentRSI <= 72
  ) {

    buyScore += 1;

    buyReasons.push(
      `RSI ${currentRSI.toFixed(1)}`
    );
  }


  if (
    buyNotLate
  ) {

    buyScore += 1;

    buyReasons.push(
      "entry not extended"
    );
  }


  /*
    SELL SCORE
  */

  let sellScore = 0;

  const sellReasons = [];


  if (
    bearishCandle
  ) {

    sellScore += 1;

    sellReasons.push(
      "bearish candle"
    );
  }


  if (
    bearishBreak
  ) {

    sellScore += 2;

    sellReasons.push(
      "5M BOS"
    );
  }


  if (
    bearishSweep
  ) {

    sellScore += 2;

    sellReasons.push(
      "liquidity sweep"
    );
  }


  if (
    bearishRejection
  ) {

    sellScore += 1;

    sellReasons.push(
      "rejection"
    );
  }


  if (
    bearishMomentum
  ) {

    sellScore += 1;

    sellReasons.push(
      "momentum"
    );
  }


  if (
    currentRSI >= 28 &&
    currentRSI <= 50
  ) {

    sellScore += 1;

    sellReasons.push(
      `RSI ${currentRSI.toFixed(1)}`
    );
  }


  if (
    sellNotLate
  ) {

    sellScore += 1;

    sellReasons.push(
      "entry not extended"
    );
  }


  /*
    BUY.
  */

  if (
    buyScore >= 7 &&
    buyScore > sellScore
  ) {

    const entry =
      close;


    /*
      Stop below recent liquidity.
    */

    let sl =
      Math.min(
        recentLow,
        low
      );


    /*
      Add a small structural buffer.
    */

    const buffer =
      range * 0.05;


    sl -= buffer;


    const risk =
      entry - sl;


    if (
      risk <= 0
    ) {

      return {

        direction: "NEUTRAL",

        score: 0,

        reason:
          "Invalid BUY risk",

        entry: null,

        stopLoss: null,

        takeProfit: null
      };
    }


    const tp =
      entry +
      risk * 2;


    return {

      direction: "BUY",

      score: buyScore,

      reason:
        buyReasons.join(" ✓ "),

      entry,

      stopLoss: sl,

      takeProfit: tp,

      rsi:
        currentRSI
    };
  }


  /*
    SELL.
  */

  if (
    sellScore >= 7 &&
    sellScore > buyScore
  ) {

    const entry =
      close;


    let sl =
      Math.max(
        recentHigh,
        high
      );


    const buffer =
      range * 0.05;


    sl += buffer;


    const risk =
      sl - entry;


    if (
      risk <= 0
    ) {

      return {

        direction: "NEUTRAL",

        score: 0,

        reason:
          "Invalid SELL risk",

        entry: null,

        stopLoss: null,

        takeProfit: null
      };
    }


    const tp =
      entry -
      risk * 2;


    return {

      direction: "SELL",

      score: sellScore,

      reason:
        sellReasons.join(" ✓ "),

      entry,

      stopLoss: sl,

      takeProfit: tp,

      rsi:
        currentRSI
    };
  }


  return {

    direction: "NEUTRAL",

    score:
      Math.max(
        buyScore,
        sellScore
      ),

    reason:
      `BUY ${buyScore}/10 | SELL ${sellScore}/10`,

    entry: null,

    stopLoss: null,

    takeProfit: null,

    rsi:
      currentRSI
  };
}


/* =========================================================
   FINAL MULTI-TIMEFRAME SIGNAL
========================================================= */

function generateSignal(
  pair,
  h12,
  h1,
  m5
) {

  const structure12 =
    analyzeStructure(h12);

  const structure1 =
    analyzeStructure(h1);


  const entry =
    analyze5MEntry(m5);


  /*
    Start scores with the 5M entry score.

    H12 is context, not an absolute blocker.
  */

  let buyScore =
    entry.direction === "BUY"
      ? entry.score
      : 0;


  let sellScore =
    entry.direction === "SELL"
      ? entry.score
      : 0;


  const buyReasons = [];
  const sellReasons = [];


  /*
    H12 context.

    It contributes points but does not completely block
    a trade when neutral.
  */

  if (
    structure12.bias === "BULLISH"
  ) {

    buyScore += 1;

    buyReasons.push(
      "H12 bullish context"
    );

  } else if (
    structure12.bias === "BEARISH"
  ) {

    sellScore += 1;

    sellReasons.push(
      "H12 bearish context"
    );
  }


  /*
    H1 primary direction.
  */

  if (
    structure1.bias === "BULLISH"
  ) {

    buyScore += 2;

    buyReasons.push(
      "H1 bullish"
    );

  } else if (
    structure1.bias === "BEARISH"
  ) {

    sellScore += 2;

    sellReasons.push(
      "H1 bearish"
    );
  }


  /*
    H12 BOS / sweep adds confirmation.
  */

  if (
    structure12.bos &&
    structure12.bias === "BULLISH"
  ) {

    buyScore += 1;

    buyReasons.push(
      "H12 BOS"
    );
  }


  if (
    structure12.bos &&
    structure12.bias === "BEARISH"
  ) {

    sellScore += 1;

    sellReasons.push(
      "H12 BOS"
    );
  }


  /*
    H1 BOS.
  */

  if (
    structure1.bos &&
    structure1.bias === "BULLISH"
  ) {

    buyScore += 1;

    buyReasons.push(
      "H1 BOS"
    );
  }


  if (
    structure1.bos &&
    structure1.bias === "BEARISH"
  ) {

    sellScore += 1;

    sellReasons.push(
      "H1 BOS"
    );
  }


  /*
    5M entry reason.
  */

  if (
    entry.direction === "BUY"
  ) {

    buyReasons.push(
      `5M ${entry.reason}`
    );
  }


  if (
    entry.direction === "SELL"
  ) {

    sellReasons.push(
      `5M ${entry.reason}`
    );
  }


  /*
    Maximum practical score is around 10.

    We require at least 8 for STRONG.

    This means a neutral H12 does not automatically
    eliminate a strong intraday setup.
  */

  if (
    entry.direction === "BUY" &&
    buyScore >= 8 &&
    buyScore > sellScore
  ) {

    return {

      pair,

      signal:
        "STRONG BUY",

      score:
        Math.min(
          10,
          buyScore
        ),

      entry:
        roundPrice(
          entry.entry,
          pair
        ),

      stopLoss:
        roundPrice(
          entry.stopLoss,
          pair
        ),

      takeProfit:
        roundPrice(
          entry.takeProfit,
          pair
        ),

      rsi:
        entry.rsi,

      h12:
        structure12.bias,

      h1:
        structure1.bias,

      detail:
        buyReasons.join(" | ")
    };
  }


  if (
    entry.direction === "SELL" &&
    sellScore >= 8 &&
    sellScore > buyScore
  ) {

    return {

      pair,

      signal:
        "STRONG SELL",

      score:
        Math.min(
          10,
          sellScore
        ),

      entry:
        roundPrice(
          entry.entry,
          pair
        ),

      stopLoss:
        roundPrice(
          entry.stopLoss,
          pair
        ),

      takeProfit:
        roundPrice(
          entry.takeProfit,
          pair
        ),

      rsi:
        entry.rsi,

      h12:
        structure12.bias,

      h1:
        structure1.bias,

      detail:
        sellReasons.join(" | ")
    };
  }


  /*
    No strong signal.
  */

  return {

    pair,

    signal:
      "WAIT",

    score:
      Math.min(
        10,
        Math.max(
          buyScore,
          sellScore
        )
      ),

    entry: null,

    stopLoss: null,

    takeProfit: null,

    rsi:
      entry.rsi || null,

    h12:
      structure12.bias,

    h1:
      structure1.bias,

    detail:
      `H12 ${structure12.bias} | H1 ${structure1.bias} | 5M ${entry.direction} | BUY ${buyScore}/10 | SELL ${sellScore}/10`
  };
}


/* =========================================================
   TELEGRAM
========================================================= */

async function notifyTelegram(signal) {

  if (
    !TELEGRAM_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {

    return;
  }


  const message =
`🚨 ${signal.signal}: ${signal.pair}

Entry: ${signal.entry}
🛑 Stop Loss: ${signal.stopLoss}
🎯 Take Profit: ${signal.takeProfit}

⭐ Score: ${signal.score}/10
📊 H12: ${signal.h12}
📈 H1: ${signal.h1}
📉 RSI: ${
    signal.rsi !== null &&
    signal.rsi !== undefined
      ? Number(signal.rsi).toFixed(1)
      : "N/A"
  }

${signal.detail}

⚠️ Signal generated by Trading Cloud Monitor.`;


  try {

    const response =
      await fetch(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        {

          method: "POST",

          headers: {
            "content-type":
              "application/json"
          },

          body:
            JSON.stringify({

              chat_id:
                TELEGRAM_CHAT_ID,

              text:
                message
            })
        }
      );


    if (
      !response.ok
    ) {

      throw new Error(
        `Telegram HTTP ${response.status}`
      );
    }

  } catch (error) {

    console.error(
      "Telegram error:",
      error.message
    );
  }
}


/* =========================================================
   DUPLICATE SIGNAL PROTECTION
========================================================= */

function signalKey(signal) {

  return [
    signal.pair,
    signal.signal,
    signal.entry,
    signal.stopLoss,
    signal.takeProfit
  ].join("|");
}


async function sendSignalIfNew(signal) {

  if (
    signal.signal !== "STRONG BUY" &&
    signal.signal !== "STRONG SELL"
  ) {

    return;
  }


  const key =
    signalKey(signal);


  if (
    lastSignal[signal.pair] === key
  ) {

    return;
  }


  lastSignal[signal.pair] =
    key;


  if (
    state.alertsEnabled
  ) {

    await notifyTelegram(
      signal
    );
  }
}


/* =========================================================
   SCAN ONE PAIR
========================================================= */

async function scanPair(pair) {

  try {

    /*
      H1 data.
    */

    const h1 =
      await getCandles(
        pair,
        "1h"
      );


    /*
      Build H12 locally from COMPLETED H1 candles.
    */

    const h12 =
      build12HCandles(h1);


    /*
      5M data.
    */

    const m5 =
      await getCandles(
        pair,
        "5min"
      );


    if (
      h12.length < 25
    ) {

      state.pairs[pair] = {

        pair,

        signal:
          "DATA WAIT",

        score: 0,

        detail:
          "Waiting for enough completed H12 candles",

        updatedAt:
          new Date().toISOString()
      };


      return;
    }


    const signal =
      generateSignal(
        pair,
        h12,
        h1,
        m5
      );


    state.pairs[pair] = {

      ...signal,

      updatedAt:
        new Date().toISOString()
    };


    await sendSignalIfNew(
      signal
    );


  } catch (error) {

    const message =
      error.message ||
      "Unknown error";


    /*
      If API cooldown is active, mark data as waiting
      rather than pretending the market is neutral.
    */

    state.pairs[pair] = {

      pair,

      signal:
        "DATA WAIT",

      score: 0,

      detail:
        message,

      updatedAt:
        new Date().toISOString()
    };


    console.error(
      `${pair}: ${message}`
    );
  }
}


/* =========================================================
   FULL SCAN
========================================================= */

async function scan() {

  if (
    state.scanning
  ) {

    console.log(
      "Scan already running."
    );

    return;
  }


  state.scanning =
    true;

  state.api.requestsThisScan =
    0;


  try {

    resetDailyCounterIfNeeded();


    /*
      If cooldown is active, don't waste requests.
    */

    if (
      Date.now() <
      apiCooldownUntil
    ) {

      const seconds =
        Math.ceil(
          (
            apiCooldownUntil -
            Date.now()
          ) / 1000
        );


      state.api.status =
        "RATE LIMITED";


      for (
        const pair of pairs
      ) {

        state.pairs[pair] = {

          pair,

          signal:
            "DATA WAIT",

          score: 0,

          detail:
            `Twelve Data cooldown (${seconds}s)`,

          updatedAt:
            new Date().toISOString()
        };
      }


      return;
    }


    console.log(
      "Starting market scan..."
    );


    for (
      const pair of pairs
    ) {

      /*
        Stop early if a rate limit appears.
      */

      if (
        Date.now() <
        apiCooldownUntil
      ) {

        break;
      }


      await scanPair(pair);
    }


    state.lastScan =
      new Date().toISOString();


    state.nextScan =
      new Date(
        Date.now() +
        POLL_MS
      ).toISOString();


    console.log(
      "Market scan completed."
    );


  } catch (error) {

    console.error(
      "Scan error:",
      error.message
    );

  } finally {

    state.scanning =
      false;
  }
}


/* =========================================================
   API ROUTES
========================================================= */

app.get(
  "/api/status",
  (req, res) => {

    resetDailyCounterIfNeeded();


    res.json({

      system:
        "Online",

      monitoredPairs:
        pairs.length,

      alerts:
        state.alertsEnabled,

      lastScan:
        state.lastScan,

      nextScan:
        state.nextScan,

      timeframe:
        ENTRY_INTERVAL,

      pollMs:
        POLL_MS,

      pairs:
        state.pairs,

      api:
        {

          status:
            state.api.status,

          lastError:
            state.api.lastError,

          last429:
            state.api.last429,

          cooldownUntil:
            state.api.cooldownUntil,

          requestsThisScan:
            state.api.requestsThisScan,

          totalRequests:
            state.api.totalRequests,

          dailyRequests:
            state.api.dailyRequests
        }
    });
  }
);


/*
   Simple health check.
*/

app.get(
  "/health",
  (req, res) => {

    res.json({

      status:
        "ok",

      time:
        new Date().toISOString()
    });
  }
);


/*
   Root fallback.
*/

app.get(
  "/",
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);


/* =========================================================
   ALERT CONTROL
========================================================= */

app.post(
  "/api/alerts",
  (req, res) => {

    if (
      typeof req.body.enabled ===
      "boolean"
    ) {

      state.alertsEnabled =
        req.body.enabled;
    }


    res.json({

      enabled:
        state.alertsEnabled
    });
  }
);


/* =========================================================
   SERVER START
========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      "=========================================="
    );

    console.log(
      "Trading Cloud Monitor started"
    );

    console.log(
      "Port:",
      PORT
    );

    console.log(
      "Pairs:",
      pairs.length
    );

    console.log(
      "Entry timeframe:",
      ENTRY_INTERVAL
    );

    console.log(
      "Scan interval:",
      POLL_MS / 60000,
      "minutes"
    );

    console.log(
      "API:",
      API_KEY
        ? "Configured"
        : "NOT CONFIGURED"
    );

    console.log(
      "Telegram:",
      TELEGRAM_TOKEN &&
      TELEGRAM_CHAT_ID
        ? "Configured"
        : "NOT CONFIGURED"
    );

    console.log(
      "=========================================="
    );


    /*
      Initial scan.

      We wait 5 seconds after startup so Railway has
      time to finish initializing.
    */

    setTimeout(
      () => {

        scan();

      },
      5000
    );


    /*
      Continuous scanner.
    */

    setInterval(
      () => {

        scan();

      },
      POLL_MS
    );
  }
);
