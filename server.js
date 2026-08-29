const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/*
===========================================================
TRADING CLOUD MONITOR
12H + 1H + 5M
SMC + RSI + EMA + ATR
MARKET CLOSED PROTECTION
LATE ENTRY PROTECTION
===========================================================
*/

const PORT = process.env.PORT || 3000;

const API_KEY = process.env.TWELVE_DATA_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/* =========================================================
   CONFIG
========================================================= */

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
   Keep requests separated.
*/
const REQUEST_GAP_MS = Math.max(
  3000,
  Number(process.env.REQUEST_GAP_MS || 9500)
);

/*
   Cache.
*/
const M5_CACHE_MS = 5 * 60 * 1000;

/*
   H1 cache is shorter because H1 data
   needs to update regularly.
*/
const H1_CACHE_MS = 60 * 60 * 1000;

/*
   API cooldown after rate limit.
*/
const API_COOLDOWN_MS = 5 * 60 * 1000;

let apiCooldownUntil = 0;
let lastApiRequest = 0;

/* =========================================================
   STATE
========================================================= */

const state = {
  online: true,

  alerts: true,

  marketOpen: false,

  lastScan: null,

  scanning: false,

  scanStarted: null,

  scanFinished: null,

  pairs: {},

  api: {
    configured: Boolean(API_KEY),

    status: API_KEY
      ? "READY"
      : "NOT CONFIGURED",

    lastError: null,

    last429: null,

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

    price: null,

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

    analysis: {}
  };
}

/* =========================================================
   BASIC HELPERS
========================================================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isoNow() {
  return new Date().toISOString();
}

function roundPrice(value, digits = 5) {
  if (!Number.isFinite(value)) {
    return null;
  }

  return Number(value.toFixed(digits));
}

function priceDigits(pair) {
  if (pair === "XAU/USD") {
    return 2;
  }

  if (pair.includes("JPY")) {
    return 3;
  }

  return 5;
}

/* =========================================================
   MARKET OPEN / CLOSED
========================================================= */

/*
   Forex and XAU/USD are normally closed over the weekend.

   We use UTC because the server may be running in Railway
   with a different timezone.

   Friday after 22:00 UTC -> CLOSED
   Saturday               -> CLOSED
   Sunday before 22:00 UTC -> CLOSED
   Sunday 22:00 UTC onward -> OPEN

   This is a practical filter, not an exchange calendar.
*/

function isMarketOpen() {
  const now = new Date();

  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();

  const totalMinutes =
    hour * 60 + minute;

  /*
     Saturday
  */
  if (day === 6) {
    return false;
  }

  /*
     Sunday before 22:00 UTC
  */
  if (
    day === 0 &&
    totalMinutes < 22 * 60
  ) {
    return false;
  }

  /*
     Friday after 22:00 UTC
  */
  if (
    day === 5 &&
    totalMinutes >= 22 * 60
  ) {
    return false;
  }

  return true;
}

function marketStatusMessage() {
  if (isMarketOpen()) {
    return "MARKET OPEN";
  }

  return "MARKET CLOSED";
}

/* =========================================================
   API RATE LIMITER
========================================================= */

async function waitForApiSlot() {
  const elapsed =
    Date.now() - lastApiRequest;

  if (
    elapsed < REQUEST_GAP_MS
  ) {
    await sleep(
      REQUEST_GAP_MS - elapsed
    );
  }

  lastApiRequest = Date.now();
}

/* =========================================================
   TWELVE DATA
========================================================= */

async function getCandles(
  symbol,
  interval,
  outputsize = 100
) {
  if (!API_KEY) {
    state.api.configured = false;
    state.api.status =
      "NOT CONFIGURED";

    throw new Error(
      "TWELVE_DATA_API_KEY is not configured"
    );
  }

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
      `Twelve Data rate-limit cooldown (${seconds}s)`
    );
  }

  await waitForApiSlot();

  state.api.requestsThisScan++;
  state.api.totalRequests++;

  const url =
    "https://api.twelvedata.com/time_series" +
    "?symbol=" +
    encodeURIComponent(symbol) +
    "&interval=" +
    encodeURIComponent(interval) +
    "&outputsize=" +
    outputsize +
    "&apikey=" +
    encodeURIComponent(API_KEY);

  let response;

  try {
    response =
      await fetch(url);
  } catch (error) {
    state.api.status =
      "CONNECTION ERROR";

    state.api.lastError =
      error.message;

    throw new Error(
      `Twelve Data connection error: ${error.message}`
    );
  }

  let data;

  try {
    data =
      await response.json();
  } catch (error) {
    state.api.status =
      "INVALID RESPONSE";

    state.api.lastError =
      "Invalid JSON from Twelve Data";

    throw new Error(
      "Invalid response from Twelve Data"
    );
  }

  /*
     HTTP 429
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
      isoNow();

    state.api.cooldownUntil =
      new Date(
        apiCooldownUntil
      ).toISOString();

    state.api.lastError =
      "Twelve Data HTTP 429 - API limit reached";

    throw new Error(
      "Twelve Data HTTP 429 - API limit reached"
    );
  }

  /*
     Other HTTP errors.
  */
  if (!response.ok) {
    state.api.status =
      "API ERROR";

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
    data &&
    (
      data.status === "error" ||
      data.code
    )
  ) {
    const message =
      data.message ||
      "Twelve Data error";

    if (
      /limit|credit|rate/i
        .test(message)
    ) {
      apiCooldownUntil =
        Date.now() +
        API_COOLDOWN_MS;

      state.api.status =
        "RATE LIMITED";

      state.api.last429 =
        isoNow();

      state.api.cooldownUntil =
        new Date(
          apiCooldownUntil
        ).toISOString();
    }

    state.api.lastError =
      message;

    throw new Error(
      `Twelve Data ${data.code || ""} ${message}`.trim()
    );
  }

  /*
     Validate candle response.
  */
  if (
    !data ||
    !Array.isArray(data.values)
  ) {
    state.api.status =
      "NO DATA";

    state.api.lastError =
      "No candle data returned";

    throw new Error(
      "No candle data returned"
    );
  }

  const candles =
    data.values
      .map(c => ({
        datetime:
          c.datetime,

        open:
          Number(c.open),

        high:
          Number(c.high),

        low:
          Number(c.low),

        close:
          Number(c.close),

        volume:
          c.volume !== undefined
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

  if (
    candles.length < 30
  ) {
    throw new Error(
      "Insufficient candle data"
    );
  }

  state.api.status =
    "CONNECTED";

  state.api.lastError =
    null;

  state.api.cooldownUntil =
    null;

  return candles;
}

/* =========================================================
   CACHE
========================================================= */

const cache = new Map();

function cacheKey(
  pair,
  timeframe
) {
  return `${pair}:${timeframe}`;
}

function getCache(
  pair,
  timeframe,
  maxAge
) {
  const key =
    cacheKey(
      pair,
      timeframe
    );

  const item =
    cache.get(key);

  if (!item) {
    return null;
  }

  if (
    Date.now() -
      item.time >
    maxAge
  ) {
    return null;
  }

  return item.data;
}

function setCache(
  pair,
  timeframe,
  data
) {
  cache.set(
    cacheKey(
      pair,
      timeframe
    ),
    {
      time: Date.now(),
      data
    }
  );
}

/* =========================================================
   EMA
========================================================= */

function ema(
  values,
  period
) {
  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return null;
  }

  const multiplier =
    2 / (period + 1);

  let result =
    values
      .slice(0, period)
      .reduce(
        (sum, value) =>
          sum + value,
        0
      ) / period;

  for (
    let i = period;
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

function rsi(
  values,
  period = 14
) {
  if (
    !Array.isArray(values) ||
    values.length <= period
  ) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    const change =
      values[i] -
      values[i - 1];

    if (
      change >= 0
    ) {
      gains += change;
    } else {
      losses +=
        Math.abs(change);
    }
  }

  let averageGain =
    gains / period;

  let averageLoss =
    losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const change =
      values[i] -
      values[i - 1];

    const gain =
      Math.max(
        change,
        0
      );

    const loss =
      Math.max(
        -change,
        0
      );

    averageGain =
      (
        averageGain *
          (period - 1) +
        gain
      ) / period;

    averageLoss =
      (
        averageLoss *
          (period - 1) +
        loss
      ) / period;
  }

  if (
    averageLoss === 0
  ) {
    return 100;
  }

  const rs =
    averageGain /
    averageLoss;

  return (
    100 -
    100 / (1 + rs)
  );
}

/* =========================================================
   ATR
========================================================= */

function atr(
  candles,
  period = 14
) {
  if (
    !Array.isArray(candles) ||
    candles.length <= period
  ) {
    return null;
  }

  const trueRanges = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const current =
      candles[i];

    const previous =
      candles[i - 1];

    const tr =
      Math.max(
        current.high -
          current.low,

        Math.abs(
          current.high -
          previous.close
        ),

        Math.abs(
          current.low -
          previous.close
        )
      );

    trueRanges.push(tr);
  }

  if (
    trueRanges.length <
    period
  ) {
    return null;
  }

  let value =
    trueRanges
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;

  for (
    let i = period;
    i < trueRanges.length;
    i++
  ) {
    value =
      (
        value *
          (period - 1) +
        trueRanges[i]
      ) / period;
  }

  return value;
}

/* =========================================================
   HIGHEST / LOWEST
========================================================= */

function highest(
  candles,
  count,
  excludeLast = 1
) {
  if (
    !Array.isArray(candles) ||
    candles.length === 0
  ) {
    return null;
  }

  const end =
    candles.length -
    excludeLast;

  const start =
    Math.max(
      0,
      end - count
    );

  let result =
    -Infinity;

  for (
    let i = start;
    i < end;
    i++
  ) {
    result =
      Math.max(
        result,
        candles[i].high
      );
  }

  return Number.isFinite(result)
    ? result
    : null;
}

function lowest(
  candles,
  count,
  excludeLast = 1
) {
  if (
    !Array.isArray(candles) ||
    candles.length === 0
  ) {
    return null;
  }

  const end =
    candles.length -
    excludeLast;

  const start =
    Math.max(
      0,
      end - count
    );

  let result =
    Infinity;

  for (
    let i = start;
    i < end;
    i++
  ) {
    result =
      Math.min(
        result,
        candles[i].low
      );
  }

  return Number.isFinite(result)
    ? result
    : null;
}

/* =========================================================
   CANDLE HELPERS
========================================================= */

function candleBody(
  candle
) {
  return Math.abs(
    candle.close -
    candle.open
  );
}

function candleRange(
  candle
) {
  return (
    candle.high -
    candle.low
  );
}

function bullishCandle(
  candle
) {
  return (
    candle.close >
    candle.open
  );
}

function bearishCandle(
  candle
) {
  return (
    candle.close <
    candle.open
  );
}

function upperWick(
  candle
) {
  return (
    candle.high -
    Math.max(
      candle.open,
      candle.close
    )
  );
}

function lowerWick(
  candle
) {
  return (
    Math.min(
      candle.open,
      candle.close
    ) -
    candle.low
  );
}

/* =========================================================
   REJECTION
========================================================= */

function bullishRejection(
  candle
) {
  const range =
    candleRange(candle);

  if (
    range <= 0
  ) {
    return false;
  }

  const body =
    candleBody(candle);

  const lower =
    lowerWick(candle);

  return (
    lower >= body * 1.5 &&
    lower >= range * 0.30 &&
    candle.close >
      candle.low +
      range * 0.55
  );
}

function bearishRejection(
  candle
) {
  const range =
    candleRange(candle);

  if (
    range <= 0
  ) {
    return false;
  }

  const body =
    candleBody(candle);

  const upper =
    upperWick(candle);

  return (
    upper >= body * 1.5 &&
    upper >= range * 0.30 &&
    candle.close <
      candle.high -
      range * 0.55
  );
}

/* =========================================================
   TREND
========================================================= */

function analyzeTrend(
  candles
) {
  if (
    !Array.isArray(candles) ||
    candles.length < 50
  ) {
    return {
      trend: "NEUTRAL",

      rsi: null,

      ema20: null,

      ema50: null
    };
  }

  const closes =
    candles.map(
      c => c.close
    );

  const current =
    closes[
      closes.length - 1
    ];

  const ema20Value =
    ema(
      closes,
      20
    );

  const ema50Value =
    ema(
      closes,
      50
    );

  const rsiValue =
    rsi(
      closes,
      14
    );

  if (
    ema20Value === null ||
    ema50Value === null ||
    rsiValue === null
  ) {
    return {
      trend: "NEUTRAL",

      rsi: null,

      ema20:
        ema20Value,

      ema50:
        ema50Value
    };
  }

  let trend =
    "NEUTRAL";

  if (
    current >
      ema20Value &&
    ema20Value >
      ema50Value
  ) {
    trend =
      "BULLISH";
  }

  if (
    current <
      ema20Value &&
    ema20Value <
      ema50Value
  ) {
    trend =
      "BEARISH";
  }

  return {
    trend,

    rsi:
      Number(
        rsiValue.toFixed(1)
      ),

    ema20:
      ema20Value,

    ema50:
      ema50Value
  };
}

/* =========================================================
   BUILD REAL 12H CANDLES
========================================================= */

/*
   FIX FOR THE OLD 12H PROBLEM:

   The old code used only 300 H1 candles.
   That can produce fewer than 50 valid 12H candles.

   We now request 1000 H1 candles and construct
   12H candles from them.

   We also only accept a 12H block when it has
   enough H1 candles.

   A 12H candle must contain at least 10 H1 candles
   to be considered valid.

   This reduces incomplete/partial 12H candles.
*/

function build12HCandles(
  hourly
) {
  if (
    !Array.isArray(hourly) ||
    hourly.length < 100
  ) {
    return [];
  }

  const groups =
    new Map();

  for (
    const candle of hourly
  ) {
    const date =
      new Date(
        candle.datetime
      );

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

    const bucket =
      hour < 12
        ? 0
        : 12;

    const key =
      `${year}-${month}-${day} ${String(
        bucket
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
    candles.sort(
      (a, b) =>
        new Date(
          a.datetime
        ) -
        new Date(
          b.datetime
        )
    );

    /*
       Require at least 10 hourly candles.
    */
    if (
      candles.length < 10
    ) {
      continue;
    }

    const first =
      candles[0];

    const last =
      candles[
        candles.length - 1
      ];

    result.push({
      datetime,

      open:
        first.open,

      high:
        Math.max(
          ...candles.map(
            c => c.high
          )
        ),

      low:
        Math.min(
          ...candles.map(
            c => c.low
          )
        ),

      close:
        last.close,

      volume:
        candles.reduce(
          (sum, c) =>
            sum +
            (
              Number(c.volume) ||
              0
            ),
          0
        )
    });
  }

  return result.sort(
    (a, b) =>
      new Date(
        a.datetime
      ) -
      new Date(
        b.datetime
      )
  );
}

/* =========================================================
   SMC
========================================================= */

function analyzeSMC(
  candles
) {
  if (
    !Array.isArray(candles) ||
    candles.length < 20
  ) {
    return {
      bias: "NEUTRAL",

      bos: false,

      sweep: false,

      strength: "WEAK"
    };
  }

  const last =
    candles[
      candles.length - 1
    ];

  const previous =
    candles[
      candles.length - 2
    ];

  const recentHigh =
    highest(
      candles,
      15,
      2
    );

  const recentLow =
    lowest(
      candles,
      15,
      2
    );

  const bullishBOS =
    last.close >
      recentHigh;

  const bearishBOS =
    last.close <
      recentLow;

  const bullishSweep =
    last.low <
      recentLow &&
    last.close >
      recentLow;

  const bearishSweep =
    last.high >
      recentHigh &&
    last.close <
      recentHigh;

  const bullish =
    bullishCandle(last) ||
    bullishCandle(previous);

  const bearish =
    bearishCandle(last) ||
    bearishCandle(previous);

  if (
    bullishBOS &&
    bullish
  ) {
    return {
      bias: "BULLISH",

      bos: true,

      sweep:
        bullishSweep,

      strength:
        "STRONG"
    };
  }

  if (
    bearishBOS &&
    bearish
  ) {
    return {
      bias: "BEARISH",

      bos: true,

      sweep:
        bearishSweep,

      strength:
        "STRONG"
    };
  }

  if (
    bullishSweep &&
    bullish
  ) {
    return {
      bias: "BULLISH",

      bos: false,

      sweep: true,

      strength:
        "CONFIRMED"
    };
  }

  if (
    bearishSweep &&
    bearish
  ) {
    return {
      bias: "BEARISH",

      bos: false,

      sweep: true,

      strength:
        "CONFIRMED"
    };
  }

  return {
    bias: "NEUTRAL",

    bos: false,

    sweep: false,

    strength:
      "WEAK"
  };
}

/* =========================================================
   ENTRY ENGINE
========================================================= */

function analyzeEntry(
  pair,
  m5,
  h1,
  h12
) {
  if (
    m5.length < 60 ||
    h1.length < 50 ||
    h12.length < 50
  ) {
    return {
      status: "WAIT",

      score: 0,

      message:
        `Waiting for timeframe data: ` +
        `M5=${m5.length}, ` +
        `H1=${h1.length}, ` +
        `12H=${h12.length}`,

      analysis: {}
    };
  }

  const digits =
    priceDigits(pair);

  const current =
    m5[
      m5.length - 1
    ];

  const previous =
    m5[
      m5.length - 2
    ];

  const closes =
    m5.map(
      c => c.close
    );

  const currentPrice =
    current.close;

  const ema20Value =
    ema(
      closes,
      20
    );

  const ema50Value =
    ema(
      closes,
      50
    );

  const rsiValue =
    rsi(
      closes,
      14
    );

  const atrValue =
    atr(
      m5,
      14
    );

  if (
    ema20Value === null ||
    ema50Value === null ||
    rsiValue === null ||
    atrValue === null
  ) {
    return {
      status: "WAIT",

      score: 0,

      message:
        "Calculating indicators...",

      analysis: {}
    };
  }

  const h1Trend =
    analyzeTrend(h1);

  const h12Trend =
    analyzeTrend(h12);

  const h1SMC =
    analyzeSMC(h1);

  const h12SMC =
    analyzeSMC(h12);

  /* =======================================================
     5M STRUCTURE
  ======================================================= */

  const structureHigh =
    highest(
      m5,
      10,
      2
    );

  const structureLow =
    lowest(
      m5,
      10,
      2
    );

  const bullishBreak =
    current.close >
      structureHigh &&
    current.close >
      current.open;

  const bearishBreak =
    current.close <
      structureLow &&
    current.close <
      current.open;

  const bullReject =
    bullishRejection(
      current
    ) ||
    bullishRejection(
      previous
    );

  const bearReject =
    bearishRejection(
      current
    ) ||
    bearishRejection(
      previous
    );

  /* =======================================================
     5M TREND
  ======================================================= */

  const bullish5 =
    currentPrice >
      ema20Value &&
    ema20Value >
      ema50Value;

  const bearish5 =
    currentPrice <
      ema20Value &&
    ema20Value <
      ema50Value;

  /* =======================================================
     LOCATION
  ======================================================= */

  const recentHigh =
    highest(
      m5,
      20,
      1
    );

  const recentLow =
    lowest(
      m5,
      20,
      1
    );

  const range =
    recentHigh -
    recentLow;

  let location =
    "MID";

  if (
    range > 0
  ) {
    const position =
      (
        currentPrice -
        recentLow
      ) / range;

    if (
      position <= 0.40
    ) {
      location =
        "LOWER RANGE";
    }

    if (
      position >= 0.60
    ) {
      location =
        "UPPER RANGE";
    }
  }

  /* =======================================================
     LATE ENTRY PROTECTION
  ======================================================= */

  const distanceFromEMA =
    Math.abs(
      currentPrice -
      ema20Value
    );

  const tooFarFromEMA =
    distanceFromEMA >
    atrValue * 1.5;

  const hugeBull =
    bullishCandle(current) &&
    candleRange(current) >
      atrValue * 1.8;

  const hugeBear =
    bearishCandle(current) &&
    candleRange(current) >
      atrValue * 1.8;

  const buyBadLocation =
    location ===
      "UPPER RANGE" &&
    bullishBreak;

  const sellBadLocation =
    location ===
      "LOWER RANGE" &&
    bearishBreak;

  /* =======================================================
     SCORES
  ======================================================= */

  let buyScore = 0;
  let sellScore = 0;

  const buyReasons = [];
  const sellReasons = [];

  /*
     12H trend
  */

  if (
    h12Trend.trend ===
    "BULLISH"
  ) {
    buyScore++;

    buyReasons.push(
      "12H bullish"
    );
  }

  if (
    h12Trend.trend ===
    "BEARISH"
  ) {
    sellScore++;

    sellReasons.push(
      "12H bearish"
    );
  }

  /*
     1H trend
  */

  if (
    h1Trend.trend ===
    "BULLISH"
  ) {
    buyScore++;

    buyReasons.push(
      "1H bullish"
    );
  }

  if (
    h1Trend.trend ===
    "BEARISH"
  ) {
    sellScore++;

    sellReasons.push(
      "1H bearish"
    );
  }

  /*
     5M trend
  */

  if (
    bullish5
  ) {
    buyScore++;

    buyReasons.push(
      "5M trend"
    );
  }

  if (
    bearish5
  ) {
    sellScore++;

    sellReasons.push(
      "5M trend"
    );
  }

  /*
     SMC
  */

  if (
    bullishBreak ||
    bullReject ||
    h1SMC.bias ===
      "BULLISH"
  ) {
    buyScore++;

    buyReasons.push(
      bullishBreak
        ? "5M breakout"
        : bullReject
          ? "bullish rejection"
          : "SMC bullish"
    );
  }

  if (
    bearishBreak ||
    bearReject ||
    h1SMC.bias ===
      "BEARISH"
  ) {
    sellScore++;

    sellReasons.push(
      bearishBreak
        ? "5M breakout"
        : bearReject
          ? "bearish rejection"
          : "SMC bearish"
    );
  }

  /*
     RSI
  */

  if (
    rsiValue >= 52 &&
    rsiValue <= 68
  ) {
    buyScore++;

    buyReasons.push(
      "RSI confirmation"
    );
  }

  if (
    rsiValue >= 32 &&
    rsiValue <= 48
  ) {
    sellScore++;

    sellReasons.push(
      "RSI confirmation"
    );
  }

  /* =======================================================
     HIGHER TIMEFRAME CONFIRMATION
  ======================================================= */

  const buyHigherTF =
    (
      h12Trend.trend ===
        "BULLISH" ||
      h12SMC.bias ===
        "BULLISH"
    ) &&
    (
      h1Trend.trend ===
        "BULLISH" ||
      h1SMC.bias ===
        "BULLISH"
    );

  const sellHigherTF =
    (
      h12Trend.trend ===
        "BEARISH" ||
      h12SMC.bias ===
        "BEARISH"
    ) &&
    (
      h1Trend.trend ===
        "BEARISH" ||
      h1SMC.bias ===
        "BEARISH"
    );

  const buyConfirmation =
    bullish5 &&
    (
      bullishBreak ||
      bullReject
    );

  const sellConfirmation =
    bearish5 &&
    (
      bearishBreak ||
      bearReject
    );

  /* =======================================================
     BUY
  ======================================================= */

  if (
    buyScore >= 4 &&
    buyHigherTF &&
    buyConfirmation &&
    !tooFarFromEMA &&
    !hugeBull &&
    !buyBadLocation
  ) {
    let sl =
      lowest(
        m5,
        12,
        1
      );

    if (
      !Number.isFinite(sl)
    ) {
      sl =
        currentPrice -
        atrValue * 1.2;
    }

    sl -=
      atrValue * 0.20;

    if (
      sl >= currentPrice
    ) {
      sl =
        currentPrice -
        atrValue * 1.2;
    }

    const risk =
      currentPrice -
      sl;

    if (
      risk <= 0
    ) {
      return {
        status: "WAIT",

        score: buyScore,

        message:
          "Invalid BUY risk",

        analysis: {}
      };
    }

    const tp =
      currentPrice +
      risk * 2;

    return {
      status: "BUY",

      score:
        Math.min(
          buyScore,
          5
        ),

      entry:
        roundPrice(
          currentPrice,
          digits
        ),

      stopLoss:
        roundPrice(
          sl,
          digits
        ),

      takeProfit:
        roundPrice(
          tp,
          digits
        ),

      message:
        `12H ${h12Trend.trend} | ` +
        `1H ${h1Trend.trend} | ` +
        `RSI ${rsiValue.toFixed(1)} | ` +
        buyReasons.join(
          " | "
        ),

      analysis: {
        direction:
          "BUY",

        h12:
          h12Trend.trend,

        h1:
          h1Trend.trend,

        h12SMC:
          h12SMC.bias,

        h1SMC:
          h1SMC.bias,

        m5Trend:
          "BULLISH",

        rsi:
          Number(
            rsiValue.toFixed(1)
          ),

        atr:
          roundPrice(
            atrValue,
            digits
          ),

        breakout:
          bullishBreak,

        rejection:
          bullReject,

        location,

        extended:
          false
      }
    };
  }

  /* =======================================================
     SELL
  ======================================================= */

  if (
    sellScore >= 4 &&
    sellHigherTF &&
    sellConfirmation &&
    !tooFarFromEMA &&
    !hugeBear &&
    !sellBadLocation
  ) {
    let sl =
      highest(
        m5,
        12,
        1
      );

    if (
      !Number.isFinite(sl)
    ) {
      sl =
        currentPrice +
        atrValue * 1.2;
    }

    sl +=
      atrValue * 0.20;

    if (
      sl <= currentPrice
    ) {
      sl =
        currentPrice +
        atrValue * 1.2;
    }

    const risk =
      sl -
      currentPrice;

    if (
      risk <= 0
    ) {
      return {
        status: "WAIT",

        score:
          sellScore,

        message:
          "Invalid SELL risk",

        analysis: {}
      };
    }

    const tp =
      currentPrice -
      risk * 2;

    return {
      status:
        "SELL",

      score:
        Math.min(
          sellScore,
          5
        ),

      entry:
        roundPrice(
          currentPrice,
          digits
        ),

      stopLoss:
        roundPrice(
          sl,
          digits
        ),

      takeProfit:
        roundPrice(
          tp,
          digits
        ),

      message:
        `12H ${h12Trend.trend} | ` +
        `1H ${h1Trend.trend} | ` +
        `RSI ${rsiValue.toFixed(1)} | ` +
        sellReasons.join(
          " | "
        ),

      analysis: {
        direction:
          "SELL",

        h12:
          h12Trend.trend,

        h1:
          h1Trend.trend,

        h12SMC:
          h12SMC.bias,

        h1SMC:
          h1SMC.bias,

        m5Trend:
          "BEARISH",

        rsi:
          Number(
            rsiValue.toFixed(1)
          ),

        atr:
          roundPrice(
            atrValue,
            digits
          ),

        breakout:
          bearishBreak,

        rejection:
          bearReject,

        location,

        extended:
          false
      }
    };
  }

  /* =======================================================
     WAIT
  ======================================================= */

  let reason =
    `12H ${h12Trend.trend} | ` +
    `1H ${h1Trend.trend} | ` +
    `5M ${
      bullish5
        ? "BULLISH"
        : bearish5
          ? "BEARISH"
          : "NEUTRAL"
    } | ` +
    `RSI ${rsiValue.toFixed(1)}`;

  if (
    tooFarFromEMA
  ) {
    reason +=
      " | Price extended - waiting for pullback";
  } else if (
    hugeBull ||
    hugeBear
  ) {
    reason +=
      " | Large candle - avoiding late entry";
  } else if (
    buyBadLocation ||
    sellBadLocation
  ) {
    reason +=
      " | Avoiding late range entry";
  } else {
    reason +=
      " | Waiting for 5M confirmation";
  }

  return {
    status:
      "WAIT",

    score:
      Math.min(
        Math.max(
          buyScore,
          sellScore
        ),
        5
      ),

    message:
      reason,

    analysis: {
      h12:
        h12Trend.trend,

      h1:
        h1Trend.trend,

      h12SMC:
        h12SMC.bias,

      h1SMC:
        h1SMC.bias,

      rsi:
        Number(
          rsiValue.toFixed(1)
        ),

      buyScore,

      sellScore,

      breakout:
        bullishBreak ||
        bearishBreak,

      rejection:
        bullReject ||
        bearReject,

      location,

      extended:
        tooFarFromEMA
    }
  };
}

/* =========================================================
   TELEGRAM
========================================================= */

async function sendTelegramSignal(
  pair,
  signal
) {
  if (
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {
    console.log(
      "Telegram credentials not configured."
    );

    return false;
  }

  /*
     NEVER send while market is closed.
  */
  if (
    !isMarketOpen()
  ) {
    console.log(
      `Telegram blocked: market closed (${pair})`
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

⏱ Entry TF: 5M
🔎 Confirmation: 12H + 1H + 5M
💰 Risk/Reward: 1:2

🛡️ Late-entry protection: ACTIVE
🛡️ Market-hours filter: ACTIVE

⚠️ Signal confirmation required before entry.`;

  try {
    const response =
      await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              chat_id:
                TELEGRAM_CHAT_ID,

              text
            })
        }
      );

    const result =
      await response.json();

    if (
      !result.ok
    ) {
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

/* =========================================================
   DUPLICATE SIGNAL PROTECTION
========================================================= */

function signalKey(
  pair,
  signal
) {
  return [
    pair,
    signal.status,
    signal.entry,
    signal.stopLoss,
    signal.takeProfit
  ].join("|");
}

function shouldSendSignal(
  pair,
  signal
) {
  const key =
    signalKey(
      pair,
      signal
    );

  if (
    state.lastSignalKey[pair] ===
    key
  ) {
    return false;
  }

  state.lastSignalKey[pair] =
    key;

  return true;
}

/* =========================================================
   GET M5
========================================================= */

async function getM5(
  pair
) {
  const cached =
    getCache(
      pair,
      "m5",
      M5_CACHE_MS
    );

  if (
    cached
  ) {
    return cached;
  }

  const candles =
    await getCandles(
      pair,
      ENTRY_TIMEFRAME,
      120
    );

  setCache(
    pair,
    "m5",
    candles
  );

  return candles;
}

/* =========================================================
   GET H1
========================================================= */

async function getH1(
  pair
) {
  const cached =
    getCache(
      pair,
      "h1",
      H1_CACHE_MS
    );

  if (
    cached
  ) {
    return cached;
  }

  /*
     IMPORTANT FIX:

     Old:
     300 H1 candles

     New:
     1000 H1 candles

     This gives enough history to construct
     at least 50 valid 12H candles.
  */

  const candles =
    await getCandles(
      pair,
      HIGHER_TIMEFRAME,
      1000
    );

  setCache(
    pair,
    "h1",
    candles
  );

  return candles;
}

/* =========================================================
   SCAN ONE PAIR
========================================================= */

async function scanPair(
  pair
) {
  const item =
    state.pairs[pair];

  try {
    /*
       M5
    */
    const m5 =
      await getM5(pair);

    /*
       H1
    */
    const h1 =
      await getH1(pair);

    /*
       Build 12H locally.
    */
    const h12 =
      build12HCandles(h1);

    /*
       Update basic market information.
    */
    item.price =
      m5[
        m5.length - 1
      ].close;

    /*
       Not enough history.
    */
    if (
      m5.length < 60 ||
      h1.length < 50 ||
      h12.length < 50
    ) {
      item.status =
        "WAIT";

      item.score =
        0;

      item.message =
        `Waiting for enough timeframe data ` +
        `(M5:${m5.length} H1:${h1.length} 12H:${h12.length})`;

      item.updated =
        Date.now();

      return;
    }

    /*
       Analyze.
    */
    const signal =
      analyzeEntry(
        pair,
        m5,
        h1,
        h12
      );

    const h1Analysis =
      analyzeTrend(h1);

    const h12Analysis =
      analyzeTrend(h12);

    /*
       Update dashboard.
    */
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

    item.price =
      m5[
        m5.length - 1
      ].close;

    item.updated =
      Date.now();

    item.timeframes = {
      h12: {
        trend:
          h12Analysis.trend,

        rsi:
          h12Analysis.rsi
      },

      h1: {
        trend:
          h1Analysis.trend,

        rsi:
          h1Analysis.rsi
      },

      m5: {
        trend:
          signal.analysis?.m5Trend ||
          "UNKNOWN",

        rsi:
          signal.analysis?.rsi ||
          null
      }
    };

    item.analysis =
      signal.analysis || {};

    /*
       If market is closed,
       force dashboard to WAIT.
    */

    if (
      !isMarketOpen()
    ) {
      item.status =
        "WAIT";

      item.entry =
        null;

      item.stopLoss =
        null;

      item.takeProfit =
        null;

      item.message =
        `${marketStatusMessage()} | ` +
        `12H ${h12Analysis.trend} | ` +
        `1H ${h1Analysis.trend}`;

      return;
    }

    /*
       Telegram alert only for
       4/5 or better.
    */

    if (
      (
        signal.status ===
          "BUY" ||
        signal.status ===
          "SELL"
      ) &&
      signal.score >= 4 &&
      state.alerts
    ) {
      if (
        shouldSendSignal(
          pair,
          signal
        )
      ) {
        const sent =
          await sendTelegramSignal(
            pair,
            signal
          );

        if (
          sent
        ) {
          state.performance
            .totalSignals++;

          if (
            signal.status ===
            "BUY"
          ) {
            state.performance.buys++;
          }

          if (
            signal.status ===
            "SELL"
          ) {
            state.performance.sells++;
          }
        }
      }
    }

  } catch (
    error
  ) {
    console.error(
      `${pair} scan error:`,
      error.message
    );

    item.status =
      "OFFLINE";

    item.score =
      0;

    item.entry =
      null;

    item.stopLoss =
      null;

    item.takeProfit =
      null;

    item.message =
      error.message;

    item.updated =
      Date.now();

    /*
       Stop scanning if API
       rate limit occurs.
    */
    if (
      /429|rate.limit|credit|cooldown/i
        .test(error.message)
    ) {
      throw error;
    }
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
      "Scan already running. Skipping."
    );

    return;
  }

  state.scanning =
    true;

  state.scanStarted =
    isoNow();

  state.marketOpen =
    isMarketOpen();

  state.api.requestsThisScan =
    0;

  try {
    /*
       API key check.
    */
    if (
      !API_KEY
    ) {
      state.api.status =
        "NOT CONFIGURED";

      for (
        const pair of PAIRS
      ) {
        state.pairs[pair].status =
          "OFFLINE";

        state.pairs[pair].message =
          "TWELVE_DATA_API_KEY is not configured";

        state.pairs[pair].updated =
          Date.now();
      }

      return;
    }

    /*
       API cooldown.
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
        const pair of PAIRS
      ) {
        state.pairs[pair].status =
          "OFFLINE";

        state.pairs[pair].message =
          `Twelve Data rate-limit cooldown (${seconds}s)`;

        state.pairs[pair].updated =
          Date.now();
      }

      return;
    }

    /*
       If market is closed,
       do not request market data.

       This prevents unnecessary API usage
       during weekends.
    */

    if (
      !isMarketOpen()
    ) {
      state.marketOpen =
        false;

      for (
        const pair of PAIRS
      ) {
        const item =
          state.pairs[pair];

        item.status =
          "WAIT";

        item.entry =
          null;

        item.stopLoss =
          null;

        item.takeProfit =
          null;

        item.message =
          "MARKET CLOSED — No signals will be sent";

        item.updated =
          Date.now();
      }

      state.lastScan =
        isoNow();

      return;
    }

    state.marketOpen =
      true;

    /*
       Scan one pair at a time.
    */

    for (
      const pair of PAIRS
    ) {
      try {
        await scanPair(
          pair
        );
      } catch (
        error
      ) {
        console.error(
          `Stopping scan after API problem on ${pair}:`,
          error.message
        );

        if (
          /429|rate.limit|credit|cooldown/i
            .test(error.message)
        ) {
          break;
        }
      }
    }

    state.lastScan =
      isoNow();

  } catch (
    error
  ) {
    console.error(
      "Global scan error:",
      error.message
    );

    state.api.lastError =
      error.message;

  } finally {
    state.scanFinished =
      isoNow();

    state.scanning =
      false;
  }
}

/* =========================================================
   STATUS
========================================================= */

app.get(
  "/api/status",
  (req, res) => {
    res.json({
      online:
        state.online,

      alerts:
        state.alerts,

      marketOpen:
        isMarketOpen(),

      marketStatus:
        marketStatusMessage(),

      lastScan:
        state.lastScan,

      scanning:
        state.scanning,

      scanStarted:
        state.scanStarted,

      scanFinished:
        state.scanFinished,

      monitoredPairs:
        PAIRS.length,

      timeframe:
        ENTRY_TIMEFRAME,

      higherTimeframe:
        HIGHER_TIMEFRAME,

      confirmation:
        "12H + 1H + 5M",

      pairs:
        state.pairs,

      api:
        state.api,

      performance:
        state.performance
    });
  }
);

/* =========================================================
   PAIRS
========================================================= */

app.get(
  "/api/pairs",
  (req, res) => {
    res.json({
      pairs:
        state.pairs
    });
  }
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      status:
        "ok",

      online:
        true,

      timestamp:
        isoNow(),

      marketOpen:
        isMarketOpen(),

      apiConfigured:
        Boolean(API_KEY),

      scanning:
        state.scanning
    });
  }
);

/* =========================================================
   ALERT STATUS
========================================================= */

app.get(
  "/api/alerts",
  (req, res) => {
    res.json({
      ok: true,

      enabled:
        state.alerts
    });
  }
);

/* =========================================================
   MANUAL SCAN
========================================================= */

app.post(
  "/api/scan",
  async (
    req,
    res
  ) => {
    if (
      state.scanning
    ) {
      return res.json({
        ok: false,

        message:
          "A scan is already running."
      });
    }

    scan().catch(
      error => {
        console.error(
          "Manual scan error:",
          error.message
        );
      }
    );

    res.json({
      ok: true,

      message:
        "Scan started."
    });
  }
);

/* =========================================================
   ALERT CONTROL
========================================================= */

app.post(
  "/api/alerts",
  (
    req,
    res
  ) => {
    if (
      typeof req.body.enabled ===
      "boolean"
    ) {
      state.alerts =
        req.body.enabled;
    }

    res.json({
      ok: true,

      enabled:
        state.alerts
    });
  }
);

/* =========================================================
   ROOT
========================================================= */

app.get(
  "/",
  (
    req,
    res
  ) => {
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
   ERROR HANDLER
========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "Express error:",
      error
    );

    res.status(500).json({
      ok: false,

      error:
        error.message ||
        "Internal server error"
    });
  }
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      "========================================"
    );

    console.log(
      "Trading Cloud Monitor started"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Pairs: ${PAIRS.length}`
    );

    console.log(
      `Entry timeframe: ${ENTRY_TIMEFRAME}`
    );

    console.log(
      `Higher timeframe: ${HIGHER_TIMEFRAME}`
    );

    console.log(
      "12H timeframe: BUILT FROM 1000 H1 CANDLES"
    );

    console.log(
      `Market status: ${marketStatusMessage()}`
    );

    console.log(
      `API configured: ${Boolean(API_KEY)}`
    );

    console.log(
      `Alerts enabled: ${state.alerts}`
    );

    console.log(
      "========================================"
    );

    /*
       First scan after startup.
    */
    setTimeout(
      () => {
        scan().catch(
          error => {
            console.error(
              "Initial scan error:",
              error.message
            );
          }
        );
      },
      3000
    );

    /*
       Continue scanning.
    */
    setInterval(
      () => {
        scan().catch(
          error => {
            console.error(
              "Scheduled scan error:",
              error.message
            );
          }
        );
      },
      POLL_MS
    );
  }
);
