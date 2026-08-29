const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/*
===========================================================
TRADING CLOUD MONITOR
12H + 1H + 5M
SMC + EMA + RSI + ATR
Pullback + Rejection Confirmation
Late Entry Protection
Telegram Alerts
===========================================================
*/

const PORT = process.env.PORT || 3000;

const API_KEY = process.env.TWELVE_DATA_API_KEY;
const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID =
  process.env.TELEGRAM_CHAT_ID;

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

const POLL_MS = Math.max(
  900000,
  Number(process.env.POLL_MS || 900000)
);

const REQUEST_GAP_MS = Math.max(
  9500,
  Number(process.env.REQUEST_GAP_MS || 9500)
);

const M5_CACHE_MS =
  4 * 60 * 1000;

const H1_CACHE_MS =
  55 * 60 * 1000;

const API_COOLDOWN_MS =
  5 * 60 * 1000;

/*
   Signal quality.
*/
const MIN_SIGNAL_SCORE = 4;

/*
   Risk/reward.
*/
const RISK_REWARD = 2;

/*
   Late-entry protection.
*/
const MAX_EMA_DISTANCE_ATR = 1.25;
const MAX_CANDLE_ATR = 1.60;

/* =========================================================
   GLOBAL API STATE
========================================================= */

let apiCooldownUntil = 0;
let lastApiRequest = 0;

/* =========================================================
   STATE
========================================================= */

const state = {
  online: true,

  alerts: true,

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

/* =========================================================
   INITIALIZE PAIRS
========================================================= */

for (const pair of PAIRS) {
  state.pairs[pair] = {
    symbol: pair,

    status: "WAIT",

    score: 0,

    maxScore: 5,

    entry: null,

    stopLoss: null,

    takeProfit: null,

    message:
      "Waiting for market data...",

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
   HELPERS
========================================================= */

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

function isoNow() {
  return new Date().toISOString();
}

function roundPrice(
  value,
  digits = 5
) {
  if (!Number.isFinite(value)) {
    return null;
  }

  return Number(
    value.toFixed(digits)
  );
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

function clamp(
  value,
  min,
  max
) {
  return Math.min(
    Math.max(value, min),
    max
  );
}

/* =========================================================
   API RATE LIMIT
========================================================= */

async function waitForApiSlot() {
  const elapsed =
    Date.now() - lastApiRequest;

  if (
    elapsed <
    REQUEST_GAP_MS
  ) {
    await sleep(
      REQUEST_GAP_MS - elapsed
    );
  }

  lastApiRequest =
    Date.now();
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
  } catch {
    state.api.status =
      "INVALID RESPONSE";

    state.api.lastError =
      "Invalid JSON from Twelve Data";

    throw new Error(
      "Invalid response from Twelve Data"
    );
  }

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
      "Twelve Data HTTP 429";

    throw new Error(
      "Twelve Data HTTP 429 - API limit reached"
    );
  }

  if (!response.ok) {
    state.api.status =
      "API ERROR";

    state.api.lastError =
      `Twelve Data HTTP ${response.status}`;

    throw new Error(
      `Twelve Data HTTP ${response.status}`
    );
  }

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
        isoNow();

      state.api.cooldownUntil =
        new Date(
          apiCooldownUntil
        ).toISOString();
    }

    state.api.lastError =
      message;

    throw new Error(
      `Twelve Data ${
        data.code || ""
      } ${message}`.trim()
    );
  }

  if (
    !data ||
    !Array.isArray(
      data.values
    )
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
        Number.isFinite(
          c.open
        ) &&
        Number.isFinite(
          c.high
        ) &&
        Number.isFinite(
          c.low
        ) &&
        Number.isFinite(
          c.close
        )
      )
      .reverse();

  if (
    candles.length < 60
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
  const item =
    cache.get(
      cacheKey(
        pair,
        timeframe
      )
    );

  if (!item) {
    return null;
  }

  if (
    Date.now() - item.time >
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

    if (change >= 0) {
      gains += change;
    } else {
      losses +=
        Math.abs(change);
    }
  }

  let avgGain =
    gains / period;

  let avgLoss =
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
      Math.max(change, 0);

    const loss =
      Math.max(-change, 0);

    avgGain =
      (
        avgGain *
          (period - 1) +
        gain
      ) / period;

    avgLoss =
      (
        avgLoss *
          (period - 1) +
        loss
      ) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

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

  const trs = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const current =
      candles[i];

    const previous =
      candles[i - 1];

    trs.push(
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
      )
    );
  }

  let value =
    trs
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;

  for (
    let i = period;
    i < trs.length;
    i++
  ) {
    value =
      (
        value *
          (period - 1) +
        trs[i]
      ) / period;
  }

  return value;
}

/* =========================================================
   STRUCTURE
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

  return Number.isFinite(
    result
  )
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

  return Number.isFinite(
    result
  )
    ? result
    : null;
}

/* =========================================================
   CANDLE FUNCTIONS
========================================================= */

function candleBody(c) {
  return Math.abs(
    c.close - c.open
  );
}

function candleRange(c) {
  return c.high - c.low;
}

function bullishCandle(c) {
  return c.close > c.open;
}

function bearishCandle(c) {
  return c.close < c.open;
}

function upperWick(c) {
  return (
    c.high -
    Math.max(
      c.open,
      c.close
    )
  );
}

function lowerWick(c) {
  return (
    Math.min(
      c.open,
      c.close
    ) - c.low
  );
}

/* =========================================================
   REJECTION
========================================================= */

function bullishRejection(c) {
  const range =
    candleRange(c);

  if (range <= 0) {
    return false;
  }

  const body =
    candleBody(c);

  const lower =
    lowerWick(c);

  return (
    lower >=
      body * 1.5 &&
    lower >=
      range * 0.30 &&
    c.close >
      c.low +
        range * 0.55
  );
}

function bearishRejection(c) {
  const range =
    candleRange(c);

  if (range <= 0) {
    return false;
  }

  const body =
    candleBody(c);

  const upper =
    upperWick(c);

  return (
    upper >=
      body * 1.5 &&
    upper >=
      range * 0.30 &&
    c.close <
      c.high -
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
    ema(closes, 20);

  const ema50Value =
    ema(closes, 50);

  const rsiValue =
    rsi(closes, 14);

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
   BUILD 12H
========================================================= */

function build12HCandles(
  hourly
) {
  const groups =
    new Map();

  for (
    const candle of hourly
  ) {
    const d =
      new Date(
        candle.datetime
      );

    if (
      Number.isNaN(
        d.getTime()
      )
    ) {
      continue;
    }

    const year =
      d.getUTCFullYear();

    const month =
      String(
        d.getUTCMonth() + 1
      ).padStart(2, "0");

    const day =
      String(
        d.getUTCDate()
      ).padStart(2, "0");

    const hour =
      d.getUTCHours();

    const bucket =
      hour < 12
        ? 0
        : 12;

    const key =
      `${year}-${month}-${day} ${String(
        bucket
      ).padStart(2, "0")}:00:00`;

    if (!groups.has(key)) {
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
    if (
      candles.length < 10
    ) {
      continue;
    }

    candles.sort(
      (a, b) =>
        new Date(
          a.datetime
        ) -
        new Date(
          b.datetime
        )
    );

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
              Number(
                c.volume
              ) || 0
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
      sweep: false
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
      sweep: bullishSweep
    };
  }

  if (
    bearishBOS &&
    bearish
  ) {
    return {
      bias: "BEARISH",
      bos: true,
      sweep: bearishSweep
    };
  }

  if (
    bullishSweep &&
    bullish
  ) {
    return {
      bias: "BULLISH",
      bos: false,
      sweep: true
    };
  }

  if (
    bearishSweep &&
    bearish
  ) {
    return {
      bias: "BEARISH",
      bos: false,
      sweep: true
    };
  }

  return {
    bias: "NEUTRAL",
    bos: false,
    sweep: false
  };
}

/* =========================================================
   PULLBACK DETECTION
========================================================= */

function detectPullback(
  candles,
  direction,
  ema20Value
) {
  if (
    candles.length < 8
  ) {
    return false;
  }

  const recent =
    candles.slice(-8);

  if (
    direction === "BUY"
  ) {
    const touchedEMA =
      recent.some(
        c =>
          c.low <=
          ema20Value
      );

    const bearishCandleSeen =
      recent.some(
        c =>
          bearishCandle(c)
      );

    return (
      touchedEMA &&
      bearishCandleSeen
    );
  }

  const touchedEMA =
    recent.some(
      c =>
        c.high >=
        ema20Value
    );

  const bullishCandleSeen =
    recent.some(
      c =>
        bullishCandle(c)
    );

  return (
    touchedEMA &&
    bullishCandleSeen
  );
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
  const digits =
    priceDigits(pair);

  if (
    m5.length < 80 ||
    h1.length < 60 ||
    h12.length < 20
  ) {
    return {
      status: "WAIT",
      score: 0,
      message:
        "Waiting for sufficient market data",
      analysis: {}
    };
  }

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

  const price =
    current.close;

  const ema20Value =
    ema(closes, 20);

  const ema50Value =
    ema(closes, 50);

  const rsiValue =
    rsi(closes, 14);

  const atrValue =
    atr(m5, 14);

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
        "Indicators calculating...",
      analysis: {}
    };
  }

  const h12Trend =
    analyzeTrend(h12);

  const h1Trend =
    analyzeTrend(h1);

  const h12SMC =
    analyzeSMC(h12);

  const h1SMC =
    analyzeSMC(h1);

  /* =======================================================
     5M TREND
  ======================================================= */

  const bullish5 =
    price >
      ema20Value &&
    ema20Value >
      ema50Value;

  const bearish5 =
    price <
      ema20Value &&
    ema20Value <
      ema50Value;

  /* =======================================================
     5M STRUCTURE
  ======================================================= */

  const previousHigh =
    highest(
      m5,
      12,
      2
    );

  const previousLow =
    lowest(
      m5,
      12,
      2
    );

  const bullishBreak =
    price >
      previousHigh &&
    bullishCandle(current);

  const bearishBreak =
    price <
      previousLow &&
    bearishCandle(current);

  /* =======================================================
     REJECTION
  ======================================================= */

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
     PULLBACK
  ======================================================= */

  const bullPullback =
    detectPullback(
      m5,
      "BUY",
      ema20Value
    );

  const bearPullback =
    detectPullback(
      m5,
      "SELL",
      ema20Value
    );

  /* =======================================================
     LOCATION
  ======================================================= */

  const recentHigh =
    highest(
      m5,
      24,
      1
    );

  const recentLow =
    lowest(
      m5,
      24,
      1
    );

  const range =
    recentHigh -
    recentLow;

  let location =
    "MID";

  let rangePosition =
    0.5;

  if (range > 0) {
    rangePosition =
      (
        price -
        recentLow
      ) / range;

    if (
      rangePosition <=
      0.35
    ) {
      location =
        "LOWER RANGE";
    } else if (
      rangePosition >=
      0.65
    ) {
      location =
        "UPPER RANGE";
    }
  }

  /* =======================================================
     LATE ENTRY PROTECTION
  ======================================================= */

  const emaDistance =
    Math.abs(
      price -
      ema20Value
    );

  const extended =
    emaDistance >
    atrValue *
      MAX_EMA_DISTANCE_ATR;

  const candleTooLarge =
    candleRange(current) >
    atrValue *
      MAX_CANDLE_ATR;

  const buyLate =
    (
      location ===
        "UPPER RANGE"
    ) ||
    extended ||
    candleTooLarge;

  const sellLate =
    (
      location ===
        "LOWER RANGE"
    ) ||
    extended ||
    candleTooLarge;

  /* =======================================================
     HIGHER-TIMEFRAME BIAS
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

  /* =======================================================
     SCORE
  ======================================================= */

  let buyScore = 0;
  let sellScore = 0;

  const buyReasons = [];
  const sellReasons = [];

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
    h1Trend.trend ===
    "BULLISH"
  ) {
    buyScore++;
    buyReasons.push(
      "1H bullish"
    );
  }

  if (bullish5) {
    buyScore++;
    buyReasons.push(
      "5M bullish"
    );
  }

  if (
    bullReject ||
    bullishBreak
  ) {
    buyScore++;
    buyReasons.push(
      bullReject
        ? "bullish rejection"
        : "5M BOS"
    );
  }

  if (
    rsiValue >= 50 &&
    rsiValue <= 67
  ) {
    buyScore++;
    buyReasons.push(
      `RSI ${rsiValue.toFixed(1)}`
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

  if (
    h1Trend.trend ===
    "BEARISH"
  ) {
    sellScore++;
    sellReasons.push(
      "1H bearish"
    );
  }

  if (bearish5) {
    sellScore++;
    sellReasons.push(
      "5M bearish"
    );
  }

  if (
    bearReject ||
    bearishBreak
  ) {
    sellScore++;
    sellReasons.push(
      bearReject
        ? "bearish rejection"
        : "5M BOS"
    );
  }

  if (
    rsiValue >= 33 &&
    rsiValue <= 50
  ) {
    sellScore++;
    sellReasons.push(
      `RSI ${rsiValue.toFixed(1)}`
    );
  }

  /* =======================================================
     ENTRY CONFIRMATION
  ======================================================= */

  const buyConfirmation =
    bullish5 &&
    bullPullback &&
    (
      bullReject ||
      bullishBreak
    );

  const sellConfirmation =
    bearish5 &&
    bearPullback &&
    (
      bearReject ||
      bearishBreak
    );

  /* =======================================================
     BUY
  ======================================================= */

  if (
    buyScore >=
      MIN_SIGNAL_SCORE &&
    buyHigherTF &&
    buyConfirmation &&
    !buyLate
  ) {
    let sl =
      lowest(
        m5,
        12,
        1
      );

    if (
      !Number.isFinite(sl) ||
      sl >= price
    ) {
      sl =
        price -
        atrValue * 1.2;
    }

    sl -=
      atrValue * 0.15;

    const risk =
      price - sl;

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
      price +
      risk *
        RISK_REWARD;

    return {
      status: "BUY",

      score:
        clamp(
          buyScore,
          0,
          5
        ),

      entry:
        roundPrice(
          price,
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
        direction: "BUY",

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

        pullback:
          bullPullback,

        rejection:
          bullReject,

        breakout:
          bullishBreak,

        location,

        extended: false,

        lateEntry: false
      }
    };
  }

  /* =======================================================
     SELL
  ======================================================= */

  if (
    sellScore >=
      MIN_SIGNAL_SCORE &&
    sellHigherTF &&
    sellConfirmation &&
    !sellLate
  ) {
    let sl =
      highest(
        m5,
        12,
        1
      );

    if (
      !Number.isFinite(sl) ||
      sl <= price
    ) {
      sl =
        price +
        atrValue * 1.2;
    }

    sl +=
      atrValue * 0.15;

    const risk =
      sl - price;

    if (
      risk <= 0
    ) {
      return {
        status: "WAIT",
        score: sellScore,
        message:
          "Invalid SELL risk",
        analysis: {}
      };
    }

    const tp =
      price -
      risk *
        RISK_REWARD;

    return {
      status: "SELL",

      score:
        clamp(
          sellScore,
          0,
          5
        ),

      entry:
        roundPrice(
          price,
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
        direction: "SELL",

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

        pullback:
          bearPullback,

        rejection:
          bearReject,

        breakout:
          bearishBreak,

        location,

        extended: false,

        lateEntry: false
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
    buyLate ||
    sellLate
  ) {
    reason +=
      " | Late-entry protection active";
  } else if (
    !buyHigherTF &&
    !sellHigherTF
  ) {
    reason +=
      " | Waiting for higher-timeframe alignment";
  } else if (
    !bullPullback &&
    !bearPullback
  ) {
    reason +=
      " | Waiting for pullback";
  } else {
    reason +=
      " | Waiting for 5M confirmation";
  }

  return {
    status: "WAIT",

    score:
      clamp(
        Math.max(
          buyScore,
          sellScore
        ),
        0,
        5
      ),

    message: reason,

    analysis: {
      h12:
        h12Trend.trend,

      h1:
        h1Trend.trend,

      h12SMC:
        h12SMC.bias,

      h1SMC:
        h1SMC.bias,

      m5Trend:
        bullish5
          ? "BULLISH"
          : bearish5
            ? "BEARISH"
            : "NEUTRAL",

      rsi:
        Number(
          rsiValue.toFixed(1)
        ),

      buyScore,

      sellScore,

      pullback:
        bullPullback ||
        bearPullback,

      rejection:
        bullReject ||
        bearReject,

      breakout:
        bullishBreak ||
        bearishBreak,

      location,

      extended:
        extended,

      lateEntry:
        buyLate ||
        sellLate
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

⏱ Entry: 5M
🔎 Confirmation: 12H + 1H + 5M
💰 Risk/Reward: 1:2

✅ Pullback confirmed
✅ Entry confirmation confirmed
🛡️ Late-entry filter passed

⚠️ Always confirm the setup before entering.`;

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
      "Telegram error:",
      error.message
    );

    return false;
  }
}

/* =========================================================
   DUPLICATE SIGNAL
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
   M5
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

  if (cached) {
    return cached;
  }

  const candles =
    await getCandles(
      pair,
      ENTRY_TIMEFRAME,
      150
    );

  setCache(
    pair,
    "m5",
    candles
  );

  return candles;
}

/* =========================================================
   H1
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

  if (cached) {
    return cached;
  }

  const candles =
    await getCandles(
      pair,
      HIGHER_TIMEFRAME,
      300
    );

  setCache(
    pair,
    "h1",
    candles
  );

  return candles;
}

/* =========================================================
   SCAN PAIR
========================================================= */

async function scanPair(
  pair
) {
  const item =
    state.pairs[pair];

  try {
    const m5 =
      await getM5(pair);

    const h1 =
      await getH1(pair);

    const h12 =
      build12HCandles(h1);

    if (
      m5.length < 80 ||
      h1.length < 60 ||
      h12.length < 20
    ) {
      item.status =
        "WAIT";

      item.score = 0;

      item.message =
        "Waiting for sufficient timeframe data";

      item.updated =
        Date.now();

      return;
    }

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
          signal.analysis
            ?.m5Trend ||
          "UNKNOWN",

        rsi:
          signal.analysis
            ?.rsi ||
          null
      }
    };

    item.analysis =
      signal.analysis || {};

    if (
      (
        signal.status ===
          "BUY" ||
        signal.status ===
          "SELL"
      ) &&
      signal.score >=
        MIN_SIGNAL_SCORE &&
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

        if (sent) {
          state.performance
            .totalSignals++;

          if (
            signal.status ===
            "BUY"
          ) {
            state.performance
              .buys++;
          }

          if (
            signal.status ===
            "SELL"
          ) {
            state.performance
              .sells++;
          }
        }
      }
    }

  } catch (error) {
    console.error(
      `${pair} scan error:`,
      error.message
    );

    item.status =
      "OFFLINE";

    item.score = 0;

    item.entry = null;

    item.stopLoss = null;

    item.takeProfit = null;

    item.message =
      error.message;

    item.updated =
      Date.now();

    if (
      /429|rate.limit|credit|cooldown/i
        .test(
          error.message
        )
    ) {
      throw error;
    }
  }
}

/* =========================================================
   FULL SCAN
========================================================= */

async function scan() {
  if (state.scanning) {
    console.log(
      "Scan already running."
    );

    return;
  }

  state.scanning =
    true;

  state.scanStarted =
    isoNow();

  state.api.requestsThisScan =
    0;

  try {
    if (!API_KEY) {
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
          `Twelve Data cooldown (${seconds}s)`;

        state.pairs[pair].updated =
          Date.now();
      }

      return;
    }

    /*
      IMPORTANT:
      Process pairs sequentially.
    */

    for (
      const pair of PAIRS
    ) {
      try {
        await scanPair(pair);
      } catch (error) {
        console.error(
          `Stopping scan after ${pair}:`,
          error.message
        );

        if (
          /429|rate.limit|credit|cooldown/i
            .test(
              error.message
            )
        ) {
          break;
        }
      }
    }

    state.lastScan =
      isoNow();

  } catch (error) {
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
   STATUS API
========================================================= */

app.get(
  "/api/status",
  (req, res) => {
    res.json({
      ok: true,

      online:
        state.online,

      alerts:
        state.alerts,

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
   PAIRS API
========================================================= */

app.get(
  "/api/pairs",
  (req, res) => {
    res.json({
      ok: true,

      count:
        PAIRS.length,

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
      status: "ok",

      online: true,

      timestamp:
        isoNow(),

      apiConfigured:
        Boolean(API_KEY),

      pairs:
        PAIRS.length,

      scanning:
        state.scanning
    });
  }
);

/* =========================================================
   MANUAL SCAN
========================================================= */

app.post(
  "/api/scan",
  async (req, res) => {
    if (state.scanning) {
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
   ALERTS
========================================================= */

app.post(
  "/api/alerts",
  (req, res) => {
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
  }
);

/* =========================================================
   ROOT
========================================================= */

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
   404
========================================================= */

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,

      error:
        "Route not found"
    });
  }
);

/* =========================================================
   ERROR
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
   START
========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      "========================================"
    );

    console.log(
      "TRADING CLOUD MONITOR"
    );

    console.log(
      "========================================"
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
      `API configured: ${Boolean(
        API_KEY
      )}`
    );

    console.log(
      `Telegram configured: ${Boolean(
        TELEGRAM_BOT_TOKEN &&
        TELEGRAM_CHAT_ID
      )}`
    );

    console.log(
      "========================================"
    );

    /*
      Initial scan.
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
      Automatic scans.
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
