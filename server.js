const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/*
===========================================================
TRADING CLOUD MONITOR
12H CLOSED BIAS + DEVELOPING 12H STRENGTH
1H + 5M CONFIRMATION
SMC + RSI + EMA + ATR
TELEGRAM ALERTS
MARKET HOURS PROTECTION
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
  3000,
  Number(process.env.REQUEST_GAP_MS || 9500)
);

const M5_CACHE_MS =
  5 * 60 * 1000;

const H1_CACHE_MS =
  2 * 60 * 60 * 1000;

const API_COOLDOWN_MS =
  5 * 60 * 1000;

/*
===========================================================
12H LOGIC

The bot builds 12H candles from 1H candles.

IMPORTANT:

Previous closed 12H candle:
    Main reliable higher-timeframe bias.

Current 12H candle:
    Monitored but NOT treated as fully confirmed.

Current candle age:

0 - 4 hours:
    Ignore developing 12H direction.

4 - 8 hours:
    Weak developing confirmation.

8 - 9 hours:
    Moderate confirmation.

9 - 12 hours:
    Strong developing confirmation.

Even at 9+ hours, the candle is NOT considered closed.
===========================================================
*/

const TWELVE_HOURS_MS =
  12 * 60 * 60 * 1000;

const TWELVE_STRONG_HOURS = 9;

/*
Minimum number of completed 1H candles required
to build useful 12H history.
*/
const MIN_H1_CANDLES = 300;

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

    status:
      API_KEY
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

    message:
      "Waiting for market data...",

    updated: null,

    price: null,

    timeframes: {
      h12: {
        trend: "UNKNOWN",
        rsi: null,
        currentTrend: "UNKNOWN",
        currentAgeHours: null,
        currentStrength: "UNKNOWN"
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

/* =========================================================
   MARKET HOURS
=========================================================

Forex is normally closed from Friday evening until
Sunday evening in New York.

Gold/CFD availability can differ by broker.

This prevents the bot from sending signals during the
main weekly forex closure.
========================================================= */

function isForexMarketOpen() {
  const now = new Date();

  const day =
    now.getUTCDay();

  const hour =
    now.getUTCHours();

  /*
    Saturday = completely closed.
  */
  if (day === 6) {
    return false;
  }

  /*
    Sunday:
    Wait until approximately 22:00 UTC.
  */
  if (day === 0 && hour < 22) {
    return false;
  }

  /*
    Friday:
    Stop after approximately 21:00 UTC.
  */
  if (day === 5 && hour >= 21) {
    return false;
  }

  return true;
}

function marketStatus() {
  if (isForexMarketOpen()) {
    return {
      open: true,
      message: "Market appears open"
    };
  }

  return {
    open: false,
    message:
      "Forex market is currently closed"
  };
}

/* =========================================================
   API RATE LIMITER
========================================================= */

async function waitForApiSlot() {
  const elapsed =
    Date.now() -
    lastApiRequest;

  if (
    elapsed <
    REQUEST_GAP_MS
  ) {
    await sleep(
      REQUEST_GAP_MS -
      elapsed
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
    state.api.configured =
      false;

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
      `Twelve Data ${data.code || ""} ${message}`.trim()
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

    if (change >= 0) {
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
        (a, b) =>
          a + b,
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
   CANDLE HELPERS
========================================================= */

function candleBody(candle) {
  return Math.abs(
    candle.close -
      candle.open
  );
}

function candleRange(candle) {
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

function upperWick(candle) {
  return (
    candle.high -
    Math.max(
      candle.open,
      candle.close
    )
  );
}

function lowerWick(candle) {
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

  if (range <= 0) {
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

  if (range <= 0) {
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

  const ema20 =
    ema(
      closes,
      20
    );

  const ema50 =
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

  let trend =
    "NEUTRAL";

  if (
    current > ema20 &&
    ema20 > ema50
  ) {
    trend =
      "BULLISH";
  }

  if (
    current < ema20 &&
    ema20 < ema50
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

    ema20,

    ema50
  };
}

/* =========================================================
   BUILD 12H CANDLES
=========================================================

Returns:

{
   candles: completed 12H candles,
   current: developing 12H candle,
   currentAgeHours: number,
   currentStrength: ...
}

The completed candle is used as the reliable bias.

The developing candle is separately monitored.
========================================================= */

function build12HData(
  hourly
) {
  if (
    !Array.isArray(hourly) ||
    hourly.length < 24
  ) {
    return {
      closed: [],
      current: null,
      currentAgeHours: null,
      currentStrength:
        "UNKNOWN"
    };
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

  const grouped =
    [];

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

    grouped.push({
      datetime,
      candles
    });
  }

  grouped.sort(
    (a, b) =>
      new Date(
        a.datetime
      ) -
      new Date(
        b.datetime
      )
  );

  const closed =
    [];

  let current =
    null;

  for (
    const group of grouped
  ) {
    const candles =
      group.candles;

    const first =
      candles[0];

    const last =
      candles[
        candles.length - 1
      ];

    const aggregate = {
      datetime:
        group.datetime,

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
          (
            sum,
            c
          ) =>
            sum +
            (Number(c.volume) || 0),
          0
        ),

      candleCount:
        candles.length
    };

    /*
      A normal 12H candle should have around
      12 hourly candles.

      If it has fewer than 12 and it is the newest
      group, treat it as developing.
    */
    if (
      candles.length < 12
    ) {
      current =
        aggregate;
    } else {
      closed.push(
        aggregate
      );
    }
  }

  /*
    If Twelve Data only supplied a partial latest
    group, it becomes the current candle.
  */
  if (
    !current &&
    grouped.length
  ) {
    const latest =
      grouped[
        grouped.length - 1
      ];

    const latestCandles =
      latest.candles;

    const latestAggregate = {
      datetime:
        latest.datetime,

      open:
        latestCandles[0].open,

      high:
        Math.max(
          ...latestCandles.map(
            c => c.high
          )
        ),

      low:
        Math.min(
          ...latestCandles.map(
            c => c.low
          )
        ),

      close:
        latestCandles[
          latestCandles.length - 1
        ].close,

      volume:
        latestCandles.reduce(
          (
            sum,
            c
          ) =>
            sum +
            (Number(c.volume) || 0),
          0
        ),

      candleCount:
        latestCandles.length
    };

    /*
      Determine whether the latest 12H candle is
      still forming by checking the 12H bucket start.
    */
    const start =
      new Date(
        latest.datetime
      );

    const ageMs =
      Date.now() -
      start.getTime();

    if (
      ageMs <
      TWELVE_HOURS_MS
    ) {
      current =
        latestAggregate;

      /*
        Remove it from closed if it was added.
      */
      if (
        closed.length &&
        closed[
          closed.length - 1
        ].datetime ===
          latest.datetime
      ) {
        closed.pop();
      }
    }
  }

  let currentAgeHours =
    null;

  let currentStrength =
    "UNKNOWN";

  if (current) {
    const start =
      new Date(
        current.datetime
      );

    const ageMs =
      Math.max(
        0,
        Date.now() -
          start.getTime()
      );

    currentAgeHours =
      Number(
        (
          ageMs /
          3600000
        ).toFixed(1)
      );

    if (
      currentAgeHours < 4
    ) {
      currentStrength =
        "IGNORE";
    } else if (
      currentAgeHours < 8
    ) {
      currentStrength =
        "WEAK";
    } else if (
      currentAgeHours < 9
    ) {
      currentStrength =
        "MODERATE";
    } else {
      currentStrength =
        "STRONG DEVELOPING";
    }
  }

  return {
    closed,
    current,
    currentAgeHours,
    currentStrength
  };
}

/* =========================================================
   12H BIAS
========================================================= */

function analyze12H(
  data
) {
  const closed =
    data.closed || [];

  const current =
    data.current;

  /*
    Previous completed 12H candle.
  */
  const previousClosed =
    closed[
      closed.length - 1
    ];

  const previousAnalysis =
    previousClosed
      ? analyzeTrend(
          closed
        )
      : {
          trend: "NEUTRAL",
          rsi: null
        };

  let currentTrend =
    "UNKNOWN";

  let currentRSI =
    null;

  if (current) {
    /*
      Use previous closed candles plus the
      developing candle for a view of current
      direction.
    */
    const temporary =
      [
        ...closed,
        current
      ];

    const currentAnalysis =
      analyzeTrend(
        temporary
      );

    currentTrend =
      currentAnalysis.trend;

    currentRSI =
      currentAnalysis.rsi;
  }

  return {
    previousBias:
      previousAnalysis.trend,

    previousRSI:
      previousAnalysis.rsi,

    currentTrend,

    currentRSI,

    currentAgeHours:
      data.currentAgeHours,

    currentStrength:
      data.currentStrength
  };
}

/* =========================================================
   SIMPLE SMC
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
      recentHigh &&
    last.close >
      last.open;

  const bearishBOS =
    last.close <
      recentLow &&
    last.close <
      last.open;

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
      sweep: bullishSweep,
      strength: "STRONG"
    };
  }

  if (
    bearishBOS &&
    bearish
  ) {
    return {
      bias: "BEARISH",
      bos: true,
      sweep: bearishSweep,
      strength: "STRONG"
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
      strength: "CONFIRMED"
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
      strength: "CONFIRMED"
    };
  }

  return {
    bias: "NEUTRAL",
    bos: false,
    sweep: false,
    strength: "WEAK"
  };
}

/* =========================================================
   DEVELOPING 12H SUPPORT
========================================================= */

function developing12HSupportsBuy(
  h12
) {
  if (
    h12.previousBias !==
    "BULLISH"
  ) {
    return false;
  }

  /*
    If current candle isn't developed enough,
    previous closed candle remains the authority.
  */
  if (
    h12.currentStrength ===
    "IGNORE" ||
    h12.currentStrength ===
    "UNKNOWN"
  ) {
    return true;
  }

  /*
    Once current candle reaches 4+ hours,
    don't allow an obvious opposite direction
    to confirm a BUY.
  */
  if (
    (
      h12.currentStrength ===
      "WEAK" ||
      h12.currentStrength ===
      "MODERATE" ||
      h12.currentStrength ===
      "STRONG DEVELOPING"
    ) &&
    h12.currentTrend ===
      "BEARISH"
  ) {
    return false;
  }

  return true;
}

function developing12HSupportsSell(
  h12
) {
  if (
    h12.previousBias !==
    "BEARISH"
  ) {
    return false;
  }

  if (
    h12.currentStrength ===
    "IGNORE" ||
    h12.currentStrength ===
    "UNKNOWN"
  ) {
    return true;
  }

  if (
    (
      h12.currentStrength ===
      "WEAK" ||
      h12.currentStrength ===
      "MODERATE" ||
      h12.currentStrength ===
      "STRONG DEVELOPING"
    ) &&
    h12.currentTrend ===
      "BULLISH"
  ) {
    return false;
  }

  return true;
}

/* =========================================================
   ENTRY ENGINE
========================================================= */

function analyzeEntry(
  pair,
  m5,
  h1,
  h12Data
) {
  const h12 =
    analyze12H(
      h12Data
    );

  if (
    m5.length < 60 ||
    h1.length < 50 ||
    h12Data.closed.length < 20
  ) {
    return {
      status: "WAIT",
      score: 0,
      message:
        "Waiting for enough timeframe data",
      analysis: {
        h12
      }
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

  const ema20 =
    ema(
      closes,
      20
    );

  const ema50 =
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
    ema20 === null ||
    ema50 === null ||
    rsiValue === null ||
    atrValue === null
  ) {
    return {
      status: "WAIT",
      score: 0,
      message:
        "Calculating indicators...",
      analysis: {
        h12
      }
    };
  }

  const h1Trend =
    analyzeTrend(
      h1
    );

  const h12ClosedCandles =
    h12Data.closed;

  const h12Trend =
    analyzeTrend(
      h12ClosedCandles
    );

  const h1SMC =
    analyzeSMC(
      h1
    );

  const h12SMC =
    analyzeSMC(
      h12ClosedCandles
    );

  /* -------------------------------------------------------
     5M STRUCTURE
  ------------------------------------------------------- */

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

  /* -------------------------------------------------------
     5M TREND
  ------------------------------------------------------- */

  const bullish5 =
    currentPrice >
      ema20 &&
    ema20 >
      ema50;

  const bearish5 =
    currentPrice <
      ema20 &&
    ema20 <
      ema50;

  /* -------------------------------------------------------
     RANGE / LOCATION
  ------------------------------------------------------- */

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
      ) /
      range;

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

  /* -------------------------------------------------------
     LATE ENTRY PROTECTION
  ------------------------------------------------------- */

  const distanceFromEMA =
    Math.abs(
      currentPrice -
        ema20
    );

  const tooFarFromEMA =
    distanceFromEMA >
    atrValue * 1.5;

  const hugeBull =
    bullishCandle(
      current
    ) &&
    candleRange(
      current
    ) >
      atrValue * 1.8;

  const hugeBear =
    bearishCandle(
      current
    ) &&
    candleRange(
      current
    ) >
      atrValue * 1.8;

  const buyBadLocation =
    location ===
      "UPPER RANGE" &&
    bullishBreak;

  const sellBadLocation =
    location ===
      "LOWER RANGE" &&
    bearishBreak;

  /* -------------------------------------------------------
     SCORES
  ------------------------------------------------------- */

  let buyScore = 0;
  let sellScore = 0;

  const buyReasons = [];
  const sellReasons = [];

  /*
    12H PREVIOUS CLOSED CANDLE

    This is the most important higher-timeframe
    confirmation.
  */

  if (
    h12.previousBias ===
    "BULLISH"
  ) {
    buyScore++;

    buyReasons.push(
      "12H bullish"
    );
  }

  if (
    h12.previousBias ===
    "BEARISH"
  ) {
    sellScore++;

    sellReasons.push(
      "12H bearish"
    );
  }

  /*
    1H
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
    5M
  */

  if (bullish5) {
    buyScore++;

    buyReasons.push(
      "5M trend"
    );
  }

  if (bearish5) {
    sellScore++;

    sellReasons.push(
      "5M trend"
    );
  }

  /*
    SMC / STRUCTURE
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

  /* -------------------------------------------------------
     HIGHER-TIMEFRAME CONDITIONS
  ------------------------------------------------------- */

  const buyHigherTF =
    h12.previousBias ===
      "BULLISH" &&
    (
      h1Trend.trend ===
        "BULLISH" ||
      h1SMC.bias ===
        "BULLISH"
    ) &&
    developing12HSupportsBuy(
      h12
    );

  const sellHigherTF =
    h12.previousBias ===
      "BEARISH" &&
    (
      h1Trend.trend ===
        "BEARISH" ||
      h1SMC.bias ===
        "BEARISH"
    ) &&
    developing12HSupportsSell(
      h12
    );

  /*
    5M must provide an actual trigger.
  */

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

  /* -------------------------------------------------------
     BUY
  ------------------------------------------------------- */

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
        analysis: {
          h12
        }
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
        `12H ${h12.previousBias} | ` +
        `12H current ${h12.currentTrend} ` +
        `(${h12.currentAgeHours ?? "?"}h) | ` +
        `1H ${h1Trend.trend} | ` +
        `RSI ${rsiValue.toFixed(1)} | ` +
        buyReasons.join(
          " | "
        ),

      analysis: {
        direction: "BUY",

        h12:
          h12.previousBias,

        h12Current:
          h12.currentTrend,

        h12AgeHours:
          h12.currentAgeHours,

        h12Strength:
          h12.currentStrength,

        h1:
          h1Trend.trend,

        h12SMC:
          h12SMC.bias,

        h1SMC:
          h1SMC.bias,

        m5Trend:
          bullish5
            ? "BULLISH"
            : "NEUTRAL",

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

  /* -------------------------------------------------------
     SELL
  ------------------------------------------------------- */

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
        score: sellScore,
        message:
          "Invalid SELL risk",
        analysis: {
          h12
        }
      };
    }

    const tp =
      currentPrice -
      risk * 2;

    return {
      status: "SELL",

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
        `12H ${h12.previousBias} | ` +
        `12H current ${h12.currentTrend} ` +
        `(${h12.currentAgeHours ?? "?"}h) | ` +
        `1H ${h1Trend.trend} | ` +
        `RSI ${rsiValue.toFixed(1)} | ` +
        sellReasons.join(
          " | "
        ),

      analysis: {
        direction: "SELL",

        h12:
          h12.previousBias,

        h12Current:
          h12.currentTrend,

        h12AgeHours:
          h12.currentAgeHours,

        h12Strength:
          h12.currentStrength,

        h1:
          h1Trend.trend,

        h12SMC:
          h12SMC.bias,

        h1SMC:
          h1SMC.bias,

        m5Trend:
          bearish5
            ? "BEARISH"
            : "NEUTRAL",

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

  /* -------------------------------------------------------
     WAIT
  ------------------------------------------------------- */

  let reason =
    `12H closed ${h12.previousBias} | ` +
    `12H current ${h12.currentTrend} ` +
    `(${h12.currentAgeHours ?? "?"}h) | ` +
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
    h12.currentTrend ===
      "BEARISH" &&
    h12.previousBias ===
      "BULLISH"
  ) {
    reason +=
      " | 12H developing candle turning bearish";
  } else if (
    h12.currentTrend ===
      "BULLISH" &&
    h12.previousBias ===
      "BEARISH"
  ) {
    reason +=
      " | 12H developing candle turning bullish";
  } else if (
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
  } else if (
    h12.currentStrength ===
    "IGNORE"
  ) {
    reason +=
      " | Current 12H candle too young";
  } else {
    reason +=
      " | Waiting for 5M confirmation";
  }

  return {
    status: "WAIT",

    score:
      Math.min(
        Math.max(
          buyScore,
          sellScore
        ),
        5
      ),

    message: reason,

    analysis: {
      h12:
        h12.previousBias,

      h12Current:
        h12.currentTrend,

      h12AgeHours:
        h12.currentAgeHours,

      h12Strength:
        h12.currentStrength,

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
🔎 Confirmation: Previous 12H + 1H + 5M
🕘 12H Current Age: ${
    signal.analysis?.h12AgeHours ?? "N/A"
  } hours
📈 12H Developing Strength: ${
    signal.analysis?.h12Strength ?? "N/A"
  }

💰 Risk/Reward: 1:2

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
   M5
========================================================= */

async function getM5(pair) {
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
   H1
========================================================= */

async function getH1(pair) {
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
      MIN_H1_CANDLES
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
    const m5 =
      await getM5(pair);

    const h1 =
      await getH1(pair);

    const h12Data =
      build12HData(
        h1
      );

    if (
      m5.length < 60 ||
      h1.length < 50 ||
      h12Data.closed.length < 20
    ) {
      item.status =
        "WAIT";

      item.score =
        0;

      item.message =
        "Waiting for enough timeframe data";

      item.updated =
        Date.now();

      return;
    }

    const signal =
      analyzeEntry(
        pair,
        m5,
        h1,
        h12Data
      );

    const h1Analysis =
      analyzeTrend(
        h1
      );

    const h12Analysis =
      analyze12H(
        h12Data
      );

    item.status =
      signal.status;

    item.score =
      signal.score || 0;

    item.entry =
      signal.entry ||
      null;

    item.stopLoss =
      signal.stopLoss ||
      null;

    item.takeProfit =
      signal.takeProfit ||
      null;

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
          h12Analysis.previousBias,

        rsi:
          h12Analysis.previousRSI,

        currentTrend:
          h12Analysis.currentTrend,

        currentAgeHours:
          h12Analysis.currentAgeHours,

        currentStrength:
          h12Analysis.currentStrength
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
      signal.analysis ||
      {};

    /*
      ONLY send BUY/SELL >= 4/5
      AND only when market is open.
    */

    const market =
      marketStatus();

    if (
      (
        signal.status === "BUY" ||
        signal.status === "SELL"
      ) &&
      signal.score >= 4 &&
      state.alerts &&
      market.open
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
          state.performance.totalSignals++;

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

    /*
      If market is closed, make sure the dashboard
      explains why an otherwise valid signal wasn't sent.
    */

    if (
      (
        signal.status === "BUY" ||
        signal.status === "SELL"
      ) &&
      signal.score >= 4 &&
      !market.open
    ) {
      item.message =
        `${signal.message} | MARKET CLOSED - Telegram alert blocked`;
    }

  } catch (error) {
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
          `Twelve Data rate-limit cooldown (${seconds}s)`;

        state.pairs[pair].updated =
          Date.now();
      }

      return;
    }

    const market =
      marketStatus();

    /*
      Do not scan/send trading alerts when
      weekly forex market is closed.
    */

    if (
      !market.open
    ) {
      state.api.status =
        "MARKET CLOSED";

      for (
        const pair of PAIRS
      ) {
        state.pairs[pair].status =
          "WAIT";

        state.pairs[pair].score =
          0;

        state.pairs[pair].message =
          "Forex market closed - waiting for market open";

        state.pairs[pair].updated =
          Date.now();
      }

      state.lastScan =
        isoNow();

      return;
    }

    /*
      Process pairs ONE AT A TIME.
    */

    for (
      const pair of PAIRS
    ) {
      try {
        await scanPair(
          pair
        );
      } catch (error) {
        console.error(
          `Stopping scan after API problem on ${pair}:`,
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

      market:
        marketStatus(),

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
      status: "ok",

      online:
        true,

      timestamp:
        isoNow(),

      apiConfigured:
        Boolean(API_KEY),

      scanning:
        state.scanning,

      market:
        marketStatus()
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
  async (req, res) => {
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

      enabled:
        state.alerts,

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
   EXPRESS ERROR HANDLER
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
      "12H mode: Previous CLOSED candle + developing candle"
    );

    console.log(
      "12H strong developing threshold: 9 hours"
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
      Initial scan after 3 seconds.
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
