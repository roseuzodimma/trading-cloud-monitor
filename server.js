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
=========================================================
TRADING SETTINGS
=========================================================
*/

const TIMEFRAME = "5min";

const POLL_MS = Math.max(
  300000,
  Number(process.env.POLL_MS || 300000)
);

const REQUEST_DELAY_MS = 1500;

const API_COOLDOWN_MS = 60000;

/*
=========================================================
PAIRS
=========================================================
*/

const PAIRS = [
  "XAU/USD",
  "GBP/JPY"
];

/*
=========================================================
SIGNAL SETTINGS
=========================================================
*/

const MIN_SCORE = 4;

/*
A signal is NOT allowed simply because
all timeframes agree.

It must also have fresh confirmation.
*/

const MAX_EXTENSION_ATR = 1.8;

const MAX_ENTRY_DISTANCE_ATR = 1.5;

const PULLBACK_LOOKBACK = 8;

const CONFIRMATION_LOOKBACK = 5;

/*
=========================================================
CACHE
=========================================================
*/

const H1_REFRESH_MS =
  60 * 60 * 1000;

const h1Cache = {};

for (const pair of PAIRS) {
  h1Cache[pair] = {
    candles: null,
    updated: null
  };
}

/*
=========================================================
STATE
=========================================================
*/

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
    status: API_KEY
      ? "CONFIGURED"
      : "MISSING_API_KEY",

    totalRequests: 0,

    requestsThisScan: 0,

    lastError: null,

    cooldownUntil: null
  }
};

/*
=========================================================
PAIR STATE
=========================================================
*/

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
        rsi: null,
        previous: "UNKNOWN",
        current: "UNKNOWN",
        previousCandle: null,
        currentCandle: null
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

      pullback: false,

      confirmation: false,

      location: "—",

      extended: false,

      lateEntry: false,

      structure: "—",

      bos: "—",

      choch: "—",

      liquidity: "—"
    }
  };
}

/*
=========================================================
MARKET HOURS
=========================================================
*/

function isMarketOpen() {
  const now = new Date();

  const day = now.getUTCDay();

  const hour = now.getUTCHours();

  const minute = now.getUTCMinutes();

  const minutes =
    hour * 60 + minute;

  if (day === 6) {
    return false;
  }

  if (
    day === 0 &&
    minutes < 22 * 60
  ) {
    return false;
  }

  if (
    day === 5 &&
    minutes >= 22 * 60
  ) {
    return false;
  }

  return true;
}

/*
=========================================================
HELPERS
=========================================================
*/

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}

function num(value) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}

function average(values) {
  const clean =
    values.filter(
      Number.isFinite
    );

  if (!clean.length) {
    return null;
  }

  return (
    clean.reduce(
      (a, b) => a + b,
      0
    ) / clean.length
  );
}

function roundPrice(value, pair) {
  if (!Number.isFinite(value)) {
    return null;
  }

  let decimals = 5;

  if (pair === "XAU/USD") {
    decimals = 2;
  }

  if (pair.includes("JPY")) {
    decimals = 3;
  }

  return Number(
    value.toFixed(decimals)
  );
}

/*
=========================================================
TWELVE DATA
=========================================================
*/

async function twelveData(
  symbol,
  interval,
  outputsize = 100
) {
  if (!API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY is missing"
    );
  }

  if (
    state.api.cooldownUntil &&
    Date.now() <
      state.api.cooldownUntil
  ) {
    throw new Error(
      "Twelve Data cooldown active"
    );
  }

  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${outputsize}` +
    `&apikey=${encodeURIComponent(API_KEY)}`;

  state.api.totalRequests++;

  const response =
    await fetch(url);

  const data =
    await response
      .json()
      .catch(() => null);

  if (response.status === 429) {
    state.api.cooldownUntil =
      Date.now() +
      API_COOLDOWN_MS;

    throw new Error(
      "Twelve Data HTTP 429 - rate limit exceeded"
    );
  }

  if (!response.ok) {
    throw new Error(
      `Twelve Data HTTP ${response.status}`
    );
  }

  if (
    data &&
    data.status === "error"
  ) {
    throw new Error(
      data.message ||
      "Twelve Data error"
    );
  }

  if (
    !data ||
    !Array.isArray(data.values)
  ) {
    throw new Error(
      "No candle data returned"
    );
  }

  return data.values
    .map(candle => ({
      datetime:
        new Date(
          candle.datetime
        ),

      open: num(candle.open),

      high: num(candle.high),

      low: num(candle.low),

      close: num(candle.close),

      volume: num(candle.volume)
    }))
    .filter(candle =>
      Number.isFinite(
        candle.open
      ) &&
      Number.isFinite(
        candle.high
      ) &&
      Number.isFinite(
        candle.low
      ) &&
      Number.isFinite(
        candle.close
      )
    )
    .sort(
      (a, b) =>
        a.datetime.getTime() -
        b.datetime.getTime()
    );
}

/*
=========================================================
CLOSED HOURLY
=========================================================
*/

function getClosedHourlyCandles(candles) {
  if (
    !candles ||
    !candles.length
  ) {
    return [];
  }

  const now = new Date();

  const currentHourStart =
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      0,
      0
    );

  return candles.filter(
    candle =>
      candle.datetime.getTime() <
      currentHourStart
  );
}

/*
=========================================================
12H AGGREGATION
=========================================================
*/

function aggregate12HCandles(
  hourlyCandles
) {
  if (
    !hourlyCandles ||
    hourlyCandles.length < 24
  ) {
    return [];
  }

  const groups = new Map();

  for (
    const candle of hourlyCandles
  ) {
    const date =
      candle.datetime;

    const year =
      date.getUTCFullYear();

    const month =
      date.getUTCMonth();

    const day =
      date.getUTCDate();

    const hour =
      date.getUTCHours();

    const half =
      hour < 12
        ? 0
        : 12;

    const key =
      `${year}-${month}-${day}-${half}`;

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups
      .get(key)
      .push(candle);
  }

  const result = [];

  for (
    const [
      key,
      candles
    ] of groups
  ) {
    candles.sort(
      (a, b) =>
        a.datetime.getTime() -
        b.datetime.getTime()
    );

    /*
    Require at least 10 candles.
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
      datetime:
        first.datetime,

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
            (c.volume || 0),
          0
        ),

      candleCount:
        candles.length
    });
  }

  return result.sort(
    (a, b) =>
      a.datetime.getTime() -
      b.datetime.getTime()
  );
}

/*
=========================================================
CLOSED 12H
=========================================================
*/

function getClosed12HCandles(
  candles
) {
  if (
    !candles ||
    !candles.length
  ) {
    return [];
  }

  const now = new Date();

  const currentHour =
    now.getUTCHours();

  const sessionStart =
    currentHour < 12
      ? 0
      : 12;

  const sessionTime =
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      sessionStart,
      0,
      0
    );

  return candles.filter(
    candle =>
      candle.datetime.getTime() <
      sessionTime
  );
}

/*
=========================================================
RSI
=========================================================
*/

function calculateRSI(
  candles,
  period = 14
) {
  if (
    !candles ||
    candles.length <
      period + 1
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
      candles[i].close -
      candles[i - 1].close;

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
    i < candles.length;
    i++
  ) {
    const change =
      candles[i].close -
      candles[i - 1].close;

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
    avgGain /
    avgLoss;

  return (
    100 -
    100 / (1 + rs)
  );
}

/*
=========================================================
TREND
=========================================================
*/

function getTrend(candles) {
  if (
    !candles ||
    candles.length < 20
  ) {
    return "UNKNOWN";
  }

  const recent =
    candles.slice(-20);

  const fast =
    average(
      recent
        .slice(-5)
        .map(
          c => c.close
        )
    );

  const slow =
    average(
      recent.map(
        c => c.close
      )
    );

  const first =
    recent[0].close;

  const last =
    recent[
      recent.length - 1
    ].close;

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

/*
=========================================================
SWINGS
=========================================================
*/

function findSwingHigh(
  candles,
  index
) {
  if (
    index < 2 ||
    index >=
      candles.length - 2
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

function findSwingLow(
  candles,
  index
) {
  if (
    index < 2 ||
    index >=
      candles.length - 2
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

/*
=========================================================
12H TREND
=========================================================
*/

function get12HTrend(
  candles
) {
  if (
    !candles ||
    candles.length < 20
  ) {
    return "UNKNOWN";
  }

  const recent =
    candles.slice(-20);

  const fast =
    average(
      recent
        .slice(-5)
        .map(
          c => c.close
        )
    );

  const slow =
    average(
      recent.map(
        c => c.close
      )
    );

  const first =
    recent[0].close;

  const last =
    recent[
      recent.length - 1
    ].close;

  const highs = [];

  const lows = [];

  for (
    let i = 2;
    i <
      recent.length - 2;
    i++
  ) {
    if (
      findSwingHigh(
        recent,
        i
      )
    ) {
      highs.push(
        recent[i].high
      );
    }

    if (
      findSwingLow(
        recent,
        i
      )
    ) {
      lows.push(
        recent[i].low
      );
    }
  }

  let bullishStructure =
    false;

  let bearishStructure =
    false;

  if (
    highs.length >= 2 &&
    lows.length >= 2
  ) {
    const ph =
      highs[
        highs.length - 2
      ];

    const lh =
      highs[
        highs.length - 1
      ];

    const pl =
      lows[
        lows.length - 2
      ];

    const ll =
      lows[
        lows.length - 1
      ];

    bullishStructure =
      lh > ph &&
      ll > pl;

    bearishStructure =
      lh < ph &&
      ll < pl;
  }

  const bullish =
    last > first &&
    fast > slow &&
    (
      bullishStructure ||
      highs.length < 2
    );

  const bearish =
    last < first &&
    fast < slow &&
    (
      bearishStructure ||
      lows.length < 2
    );

  if (bullish) {
    return "BULLISH";
  }

  if (bearish) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

/*
=========================================================
12H ANALYSIS
=========================================================
*/

function get12HAnalysis(
  candles
) {
  const closed =
    getClosed12HCandles(
      candles
    );

  if (
    closed.length < 20
  ) {
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
    closed[
      closed.length - 1
    ];

  const previous =
    closed[
      closed.length - 2
    ];

  const previousSet =
    closed.slice(
      0,
      closed.length - 1
    );

  const previousTrend =
    get12HTrend(
      previousSet
    );

  const currentTrend =
    get12HTrend(
      closed
    );

  const previousRSI =
    calculateRSI(
      previousSet
    );

  const currentRSI =
    calculateRSI(
      closed
    );

  return {
    previousTrend,

    currentTrend,

    previousRSI:
      previousRSI !== null
        ? Number(
            previousRSI.toFixed(1)
          )
        : null,

    currentRSI:
      currentRSI !== null
        ? Number(
            currentRSI.toFixed(1)
          )
        : null,

    bias:
      currentTrend,

    previousCandle:
      previous,

    currentCandle:
      current
  };
}

/*
=========================================================
SMC STRUCTURE
=========================================================
*/

function getStructure(
  candles
) {
  if (
    !candles ||
    candles.length < 15
  ) {
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
    i <
      candles.length - 2;
    i++
  ) {
    if (
      findSwingHigh(
        candles,
        i
      )
    ) {
      highs.push(
        candles[i]
      );
    }

    if (
      findSwingLow(
        candles,
        i
      )
    ) {
      lows.push(
        candles[i]
      );
    }
  }

  const last =
    candles[
      candles.length - 1
    ];

  const previousHigh =
    highs.length
      ? highs[
          highs.length - 1
        ].high
      : null;

  const previousLow =
    lows.length
      ? lows[
          lows.length - 1
        ].low
      : null;

  let structure =
    "RANGE";

  let bos = "—";

  let choch = "—";

  if (
    previousHigh !== null &&
    last.close >
      previousHigh
  ) {
    structure =
      "BULLISH";

    bos =
      "BULLISH";
  }

  if (
    previousLow !== null &&
    last.close <
      previousLow
  ) {
    structure =
      "BEARISH";

    bos =
      "BEARISH";
  }

  const previous =
    candles[
      candles.length - 2
    ];

  if (
    previousHigh !== null &&
    previous.close <=
      previousHigh &&
    last.close >
      previousHigh
  ) {
    choch =
      "BULLISH";
  }

  if (
    previousLow !== null &&
    previous.close >=
      previousLow &&
    last.close <
      previousLow
  ) {
    choch =
      "BEARISH";
  }

  let liquidity =
    "—";

  if (
    previousHigh !== null &&
    last.high >
      previousHigh &&
    last.close <
      previousHigh
  ) {
    liquidity =
      "BUY-SIDE SWEPT";
  }

  if (
    previousLow !== null &&
    last.low <
      previousLow &&
    last.close >
      previousLow
  ) {
    liquidity =
      "SELL-SIDE SWEPT";
  }

  return {
    structure,
    bos,
    choch,
    liquidity
  };
}

/*
=========================================================
REJECTION
=========================================================
*/

function rejectionSignal(
  candle
) {
  if (!candle) {
    return {
      bullish: false,
      bearish: false
    };
  }

  const body =
    Math.abs(
      candle.close -
      candle.open
    );

  const upperWick =
    candle.high -
    Math.max(
      candle.open,
      candle.close
    );

  const lowerWick =
    Math.min(
      candle.open,
      candle.close
    ) -
    candle.low;

  const minimum =
    Math.max(
      body * 1.5,
      0.0000001
    );

  return {
    bullish:
      lowerWick > minimum &&
      candle.close >
        candle.open,

    bearish:
      upperWick > minimum &&
      candle.close <
        candle.open
  };
}

/*
=========================================================
BREAKOUT
=========================================================
*/

function breakoutSignal(
  candles
) {
  if (
    !candles ||
    candles.length < 10
  ) {
    return {
      bullish: false,
      bearish: false
    };
  }

  const current =
    candles[
      candles.length - 1
    ];

  const previous =
    candles.slice(
      -6,
      -1
    );

  const highest =
    Math.max(
      ...previous.map(
        c => c.high
      )
    );

  const lowest =
    Math.min(
      ...previous.map(
        c => c.low
      )
    );

  return {
    bullish:
      current.close >
      highest,

    bearish:
      current.close <
      lowest
  };
}

/*
=========================================================
ATR
=========================================================
*/

function calculateATR(
  candles,
  period = 14
) {
  if (
    !candles ||
    candles.length <
      period + 1
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

    trs.push(tr);
  }

  return average(
    trs.slice(-period)
  );
}

/*
=========================================================
NEW:
PULLBACK DETECTION
=========================================================
*/

function detectPullback(
  candles,
  direction,
  atr
) {
  if (
    !candles ||
    candles.length <
      PULLBACK_LOOKBACK + 3 ||
    !atr
  ) {
    return false;
  }

  const recent =
    candles.slice(
      -PULLBACK_LOOKBACK
    );

  const current =
    recent[
      recent.length - 1
    ];

  const previous =
    recent[
      recent.length - 2
    ];

  if (
    direction === "SELL"
  ) {
    /*
    For a SELL:

    Price should have moved lower,
    then retraced upward.

    Current candle should show
    rejection of the retracement.
    */

    const lowest =
      Math.min(
        ...recent
          .slice(0, -2)
          .map(
            c => c.low
          )
      );

    const retracement =
      current.high -
      lowest;

    const bearishClose =
      current.close <
      current.open;

    return (
      retracement >=
        atr * 0.35 &&
      bearishClose &&
      current.close <
        previous.close
    );
  }

  if (
    direction === "BUY"
  ) {
    const highest =
      Math.max(
        ...recent
          .slice(0, -2)
          .map(
            c => c.high
          )
      );

    const retracement =
      highest -
      current.low;

    const bullishClose =
      current.close >
      current.open;

    return (
      retracement >=
        atr * 0.35 &&
      bullishClose &&
      current.close >
        previous.close
    );
  }

  return false;
}

/*
=========================================================
NEW:
FRESH CONTINUATION CONFIRMATION
=========================================================
*/

function freshConfirmation(
  candles,
  direction
) {
  if (
    !candles ||
    candles.length <
      CONFIRMATION_LOOKBACK + 2
  ) {
    return false;
  }

  const current =
    candles[
      candles.length - 1
    ];

  const previous =
    candles[
      candles.length - 2
    ];

  const recent =
    candles.slice(
      -CONFIRMATION_LOOKBACK - 1,
      -1
    );

  if (
    direction === "SELL"
  ) {
    const previousLow =
      Math.min(
        ...recent.map(
          c => c.low
        )
      );

    return (
      current.close <
        current.open &&
      current.close <
        previous.close &&
      current.close <
        previousLow
    );
  }

  if (
    direction === "BUY"
  ) {
    const previousHigh =
      Math.max(
        ...recent.map(
          c => c.high
        )
      );

    return (
      current.close >
        current.open &&
      current.close >
        previous.close &&
      current.close >
        previousHigh
    );
  }

  return false;
}

/*
=========================================================
NEW:
LATE ENTRY PROTECTION
=========================================================
*/

function isLateEntry(
  candles,
  price,
  atr,
  direction
) {
  if (
    !candles ||
    !candles.length ||
    !atr
  ) {
    return false;
  }

  const lookback =
    candles.slice(
      -PULLBACK_LOOKBACK
    );

  const highest =
    Math.max(
      ...lookback.map(
        c => c.high
      )
    );

  const lowest =
    Math.min(
      ...lookback.map(
        c => c.low
      )
    );

  if (
    direction === "SELL"
  ) {
    /*
    SELL near the bottom after a
    large downward move = late.
    */

    const distanceFromLow =
      price - lowest;

    const move =
      highest - lowest;

    if (
      move >= atr * 2 &&
      distanceFromLow <
        atr * 0.35
    ) {
      return true;
    }
  }

  if (
    direction === "BUY"
  ) {
    /*
    BUY near the top after a
    large upward move = late.
    */

    const distanceFromHigh =
      highest - price;

    const move =
      highest - lowest;

    if (
      move >= atr * 2 &&
      distanceFromHigh <
        atr * 0.35
    ) {
      return true;
    }
  }

  return false;
}

/*
=========================================================
NEW:
DISTANCE FROM RECENT EXTREME
=========================================================
*/

function tooFarFromPullback(
  candles,
  price,
  atr,
  direction
) {
  if (!atr) {
    return true;
  }

  const recent =
    candles.slice(
      -PULLBACK_LOOKBACK
    );

  const high =
    Math.max(
      ...recent.map(
        c => c.high
      )
    );

  const low =
    Math.min(
      ...recent.map(
        c => c.low
      )
    );

  if (
    direction === "SELL"
  ) {
    const distance =
      price - low;

    return (
      distance >
      atr * MAX_ENTRY_DISTANCE_ATR
    );
  }

  if (
    direction === "BUY"
  ) {
    const distance =
      high - price;

    return (
      distance >
      atr * MAX_ENTRY_DISTANCE_ATR
    );
  }

  return true;
}

/*
=========================================================
ANALYZE PAIR
=========================================================
*/

function analyzePair(
  pair,
  h12,
  h1,
  m5
) {
  if (
    !h12.length ||
    !h1.length ||
    !m5.length
  ) {
    throw new Error(
      "Insufficient candle data"
    );
  }

  const latest =
    m5[
      m5.length - 1
    ];

  const price =
    latest.close;

  /*
  ========================================================
  12H
  ========================================================
  */

  const h12Analysis =
    get12HAnalysis(
      h12
    );

  /*
  ========================================================
  1H
  ========================================================
  */

  const h1Trend =
    getTrend(h1);

  const h1RSI =
    calculateRSI(h1);

  /*
  ========================================================
  5M
  ========================================================
  */

  const m5Trend =
    getTrend(m5);

  const m5RSI =
    calculateRSI(m5);

  /*
  ========================================================
  SMC
  ========================================================
  */

  const closed12H =
    getClosed12HCandles(
      h12
    );

  const h12Structure =
    getStructure(
      closed12H
    );

  const h1Structure =
    getStructure(h1);

  const m5Structure =
    getStructure(m5);

  /*
  ========================================================
  CANDLE
  ========================================================
  */

  const rejection =
    rejectionSignal(
      latest
    );

  const breakout =
    breakoutSignal(
      m5
    );

  /*
  ========================================================
  ATR
  ========================================================
  */

  const atr =
    calculateATR(m5);

  /*
  ========================================================
  SCORES
  ========================================================
  */

  let buyScore = 0;

  let sellScore = 0;

  /*
  12H
  */

  if (
    h12Analysis.bias ===
    "BULLISH"
  ) {
    buyScore++;
  }

  if (
    h12Analysis.bias ===
    "BEARISH"
  ) {
    sellScore++;
  }

  /*
  1H
  */

  if (
    h1Trend ===
    "BULLISH"
  ) {
    buyScore++;
  }

  if (
    h1Trend ===
    "BEARISH"
  ) {
    sellScore++;
  }

  /*
  5M
  */

  if (
    m5Trend ===
    "BULLISH"
  ) {
    buyScore++;
  }

  if (
    m5Trend ===
    "BEARISH"
  ) {
    sellScore++;
  }

  /*
  RSI
  */

  if (
    m5RSI !== null &&
    m5RSI >= 50 &&
    m5RSI <= 68
  ) {
    buyScore++;
  }

  if (
    m5RSI !== null &&
    m5RSI >= 32 &&
    m5RSI < 50
  ) {
    sellScore++;
  }

  /*
  SMC
  */

  const bullishSMC =
    m5Structure.bos ===
      "BULLISH" ||
    m5Structure.choch ===
      "BULLISH" ||
    breakout.bullish ||
    rejection.bullish;

  const bearishSMC =
    m5Structure.bos ===
      "BEARISH" ||
    m5Structure.choch ===
      "BEARISH" ||
    breakout.bearish ||
    rejection.bearish;

  if (bullishSMC) {
    buyScore++;
  }

  if (bearishSMC) {
    sellScore++;
  }

  buyScore =
    Math.min(
      5,
      buyScore
    );

  sellScore =
    Math.min(
      5,
      sellScore
    );

  /*
  ========================================================
  NEW ENTRY FILTERS
  ========================================================
  */

  const bearishPullback =
    detectPullback(
      m5,
      "SELL",
      atr
    );

  const bullishPullback =
    detectPullback(
      m5,
      "BUY",
      atr
    );

  const bearishConfirmation =
    freshConfirmation(
      m5,
      "SELL"
    );

  const bullishConfirmation =
    freshConfirmation(
      m5,
      "BUY"
    );

  const lateSell =
    isLateEntry(
      m5,
      price,
      atr,
      "SELL"
    );

  const lateBuy =
    isLateEntry(
      m5,
      price,
      atr,
      "BUY"
    );

  const sellTooFar =
    tooFarFromPullback(
      m5,
      price,
      atr,
      "SELL"
    );

  const buyTooFar =
    tooFarFromPullback(
      m5,
      price,
      atr,
      "BUY"
    );

  /*
  ========================================================
  STATUS
  ========================================================
  */

  let status =
    "WAIT";

  /*
  BUY REQUIREMENTS

  1. 12H bullish
  2. 1H bullish
  3. 5M bullish
  4. score >= 4
  5. pullback exists
  6. fresh continuation exists
  7. not late
  8. not too far
  */

  if (
    buyScore >= MIN_SCORE &&
    h12Analysis.bias ===
      "BULLISH" &&
    h1Trend ===
      "BULLISH" &&
    m5Trend ===
      "BULLISH" &&
    bullishPullback &&
    bullishConfirmation &&
    !lateBuy &&
    !buyTooFar
  ) {
    status =
      "BUY";
  }

  /*
  SELL REQUIREMENTS
  */

  if (
    sellScore >= MIN_SCORE &&
    h12Analysis.bias ===
      "BEARISH" &&
    h1Trend ===
      "BEARISH" &&
    m5Trend ===
      "BEARISH" &&
    bearishPullback &&
    bearishConfirmation &&
    !lateSell &&
    !sellTooFar
  ) {
    status =
      "SELL";
  }

  /*
  ========================================================
  EXTENSION PROTECTION
  ========================================================
  */

  let extended =
    false;

  if (atr !== null) {
    const reference =
      m5[
        Math.max(
          0,
          m5.length - 6
        )
      ];

    const distance =
      Math.abs(
        price -
          reference.open
      );

    if (
      distance >
      atr * MAX_EXTENSION_ATR
    ) {
      extended =
        true;

      status =
        "WAIT";
    }
  }

  /*
  ========================================================
  ENTRY
  ========================================================
  */

  let entry = null;

  let stopLoss = null;

  let takeProfit = null;

  if (
    status === "BUY" &&
    atr !== null
  ) {
    entry =
      price;

    /*
    Put SL below the recent
    pullback low with ATR buffer.
    */

    const recent =
      m5.slice(
        -PULLBACK_LOOKBACK
      );

    const recentLow =
      Math.min(
        ...recent.map(
          c => c.low
        )
      );

    stopLoss =
      Math.min(
        recentLow,
        price -
          atr * 1.1
      );

    const risk =
      entry -
      stopLoss;

    if (risk > 0) {
      takeProfit =
        entry +
        risk * 2;
    }
  }

  if (
    status === "SELL" &&
    atr !== null
  ) {
    entry =
      price;

    /*
    Put SL above the recent
    pullback high with ATR buffer.
    */

    const recent =
      m5.slice(
        -PULLBACK_LOOKBACK
      );

    const recentHigh =
      Math.max(
        ...recent.map(
          c => c.high
        )
      );

    stopLoss =
      Math.max(
        recentHigh,
        price +
          atr * 1.1
      );

    const risk =
      stopLoss -
      entry;

    if (risk > 0) {
      takeProfit =
        entry -
        risk * 2;
    }
  }

  /*
  ========================================================
  LOCATION
  ========================================================
  */

  let location =
    "WAITING FOR SETUP";

  if (
    status === "BUY"
  ) {
    if (
      bullishPullback
    ) {
      location =
        "BUY PULLBACK + CONFIRMATION";
    } else if (
      breakout.bullish
    ) {
      location =
        "BULLISH BREAKOUT";
    } else {
      location =
        "BULLISH STRUCTURE";
    }
  }

  if (
    status === "SELL"
  ) {
    if (
      bearishPullback
    ) {
      location =
        "SELL PULLBACK + CONFIRMATION";
    } else if (
      breakout.bearish
    ) {
      location =
        "BEARISH BREAKOUT";
    } else {
      location =
        "BEARISH STRUCTURE";
    }
  }

  if (
    lateSell ||
    lateBuy
  ) {
    location =
      "LATE ENTRY BLOCKED";
  }

  if (
    extended
  ) {
    location =
      "MOVE EXTENDED";
  }

  /*
  ========================================================
  MESSAGE
  ========================================================
  */

  let message =
    `12H ${h12Analysis.bias} | ` +
    `1H ${h1Trend} | ` +
    `5M ${m5Trend} | ` +
    `RSI ${
      m5RSI !== null
        ? m5RSI.toFixed(1)
        : "—"
    }`;

  if (
    status === "WAIT"
  ) {
    if (
      lateSell ||
      lateBuy
    ) {
      message +=
        " | Late entry blocked";
    } else if (
      extended
    ) {
      message +=
        " | Move extended — waiting";
    } else if (
      (
        bearishPullback &&
        !bearishConfirmation
      ) ||
      (
        bullishPullback &&
        !bullishConfirmation
      )
    ) {
      message +=
        " | Pullback detected — waiting for fresh confirmation";
    } else {
      message +=
        " | Waiting for fresh setup";
    }
  }

  if (
    status === "BUY"
  ) {
    message +=
      " | Fresh BUY confirmation";
  }

  if (
    status === "SELL"
  ) {
    message +=
      " | Fresh SELL confirmation";
  }

  /*
  ========================================================
  RETURN
  ========================================================
  */

  return {
    symbol:
      pair,

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

    message,

    price:
      roundPrice(
        price,
        pair
      ),

    entry:
      roundPrice(
        entry,
        pair
      ),

    stopLoss:
      roundPrice(
        stopLoss,
        pair
      ),

    takeProfit:
      roundPrice(
        takeProfit,
        pair
      ),

    updated:
      new Date().toISOString(),

    timeframes: {
      h12: {
        trend:
          h12Analysis.bias,

        rsi:
          h12Analysis.currentRSI,

        previous:
          h12Analysis.previousTrend,

        current:
          h12Analysis.currentTrend,

        previousCandle:
          h12Analysis.previousCandle
            ? {
                open:
                  h12Analysis
                    .previousCandle
                    .open,

                high:
                  h12Analysis
                    .previousCandle
                    .high,

                low:
                  h12Analysis
                    .previousCandle
                    .low,

                close:
                  h12Analysis
                    .previousCandle
                    .close
              }
            : null,

        currentCandle:
          h12Analysis.currentCandle
            ? {
                open:
                  h12Analysis
                    .currentCandle
                    .open,

                high:
                  h12Analysis
                    .currentCandle
                    .high,

                low:
                  h12Analysis
                    .currentCandle
                    .low,

                close:
                  h12Analysis
                    .currentCandle
                    .close
              }
            : null
      },

      h1: {
        trend:
          h1Trend,

        rsi:
          h1RSI !== null
            ? Number(
                h1RSI.toFixed(1)
              )
            : null
      },

      m5: {
        trend:
          m5Trend,

        rsi:
          m5RSI !== null
            ? Number(
                m5RSI.toFixed(1)
              )
            : null
      }
    },

    analysis: {
      direction:
        status,

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

      pullback:
        bullishPullback ||
        bearishPullback,

      confirmation:
        bullishConfirmation ||
        bearishConfirmation,

      location,

      extended,

      lateEntry:
        lateBuy ||
        lateSell,

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

/*
=========================================================
TELEGRAM
=========================================================
*/

async function sendTelegramSignal(
  signal
) {
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

📊 12H ${signal.timeframes.h12.trend}
📊 1H ${signal.timeframes.h1.trend}
📊 5M ${signal.timeframes.m5.trend}

RSI: ${signal.timeframes.m5.rsi ?? "—"}

🔎 SMC: ${signal.analysis.location}
📈 Structure: ${signal.analysis.structure}
💥 BOS: ${signal.analysis.bos}
🔄 CHoCH: ${signal.analysis.choch}
💧 Liquidity: ${signal.analysis.liquidity}

↩️ Pullback: ${
  signal.analysis.pullback
    ? "YES"
    : "NO"
}

✅ Fresh Confirmation: ${
  signal.analysis.confirmation
    ? "YES"
    : "NO"
}

⏱ Entry TF: 5M
🔎 Confirmation: 12H + 1H + 5M
💰 Risk/Reward: 1:2

⚠️ Fresh confirmation required.`;

  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  try {
    const response =
      await fetch(
        url,
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

    if (!response.ok) {
      console.error(
        "Telegram HTTP error:",
        response.status
      );
    }
  } catch (error) {
    console.error(
      "Telegram error:",
      error.message
    );
  }
}

/*
=========================================================
MARKET CLOSED
=========================================================
*/

function setMarketClosed(
  pair
) {
  const result =
    state.pairs[pair];

  result.status =
    "WAIT";

  result.score =
    0;

  result.message =
    "Market closed — monitoring will resume when the market opens.";

  result.price = null;

  result.entry = null;

  result.stopLoss = null;

  result.takeProfit = null;

  result.updated =
    new Date().toISOString();

  result.timeframes = {
    h12: {
      trend:
        "MARKET CLOSED",

      rsi: null,

      previous:
        "UNKNOWN",

      current:
        "UNKNOWN",

      previousCandle:
        null,

      currentCandle:
        null
    },

    h1: {
      trend:
        "MARKET CLOSED",

      rsi: null
    },

    m5: {
      trend:
        "MARKET CLOSED",

      rsi: null
    }
  };

  result.analysis = {
    direction:
      "WAIT",

    h12SMC:
      "MARKET CLOSED",

    h1SMC:
      "MARKET CLOSED",

    breakout:
      false,

    rejection:
      false,

    pullback:
      false,

    confirmation:
      false,

    location:
      "MARKET CLOSED",

    extended:
      false,

    lateEntry:
      false,

    structure:
      "—",

    bos:
      "—",

    choch:
      "—",

    liquidity:
      "—"
  };
}

/*
=========================================================
GET CACHED 1H
=========================================================
*/

async function getHourlyData(
  pair
) {
  const cached =
    h1Cache[pair];

  const now =
    Date.now();

  if (
    cached.candles &&
    cached.updated &&
    now -
      cached.updated <
      H1_REFRESH_MS
  ) {
    console.log(
      `[${pair}] Using cached 1H data`
    );

    return cached.candles;
  }

  console.log(
    `[${pair}] Refreshing 1H data`
  );

  const hourly =
    await twelveData(
      pair,
      "1h",
      300
    );

  state.api.requestsThisScan++;

  cached.candles =
    hourly;

  cached.updated =
    Date.now();

  return hourly;
}

/*
=========================================================
SCAN ONE PAIR
=========================================================
*/

async function scanPair(
  pair
) {
  const oldResult =
    state.pairs[pair];

  if (
    !isMarketOpen()
  ) {
    setMarketClosed(pair);
    return;
  }

  try {
    /*
    1H
    */

    const hourly =
      await getHourlyData(
        pair
      );

    /*
    CLOSED 1H
    */

    const closedHourly =
      getClosedHourlyCandles(
        hourly
      );

    /*
    12H
    */

    const h12 =
      aggregate12HCandles(
        closedHourly
      );

    /*
    1H
    */

    const h1 =
      closedHourly.slice(
        -150
      );

    /*
    5M
    */

    const m5 =
      await twelveData(
        pair,
        "5min",
        150
      );

    state.api.requestsThisScan++;

    /*
    VALIDATION
    */

    if (
      h12.length < 20
    ) {
      throw new Error(
        `Not enough closed 12H candles: ${h12.length}`
      );
    }

    if (
      h1.length < 20
    ) {
      throw new Error(
        "Not enough closed 1H candles"
      );
    }

    if (
      m5.length < 20
    ) {
      throw new Error(
        "Not enough 5M candles"
      );
    }

    /*
    ANALYZE
    */

    const signal =
      analyzePair(
        pair,
        h12,
        h1,
        m5
      );

    /*
    ====================================================
    ONLY SEND NEW SIGNAL
    ====================================================
    */

    if (
      signal.status === "BUY" &&
      oldResult.status !== "BUY"
    ) {
      state.performance.totalSignals++;

      state.performance.buys++;

      await sendTelegramSignal(
        signal
      );
    }

    if (
      signal.status === "SELL" &&
      oldResult.status !== "SELL"
    ) {
      state.performance.totalSignals++;

      state.performance.sells++;

      await sendTelegramSignal(
        signal
      );
    }

    /*
    SAVE
    */

    state.pairs[pair] =
      signal;

    console.log(
      `[${pair}] ${signal.status} ${signal.score}/5 | ${signal.message}`
    );

  } catch (error) {
    console.error(
      `[${pair}]`,
      error.message
    );

    oldResult.status =
      "OFFLINE";

    oldResult.score =
      0;

    oldResult.message =
      error.message;

    oldResult.price =
      null;

    oldResult.entry =
      null;

    oldResult.stopLoss =
      null;

    oldResult.takeProfit =
      null;

    oldResult.updated =
      new Date().toISOString();

    state.api.lastError =
      `${pair}: ${error.message}`;
  }
}

/*
=========================================================
SCAN ALL
=========================================================
*/

async function scanAll() {
  state.api.requestsThisScan =
    0;

  state.api.lastError =
    null;

  const marketOpen =
    isMarketOpen();

  state.online =
    true;

  console.log(
    "===================================="
  );

  console.log(
    `[SCAN] ${
      new Date().toISOString()
    }`
  );

  console.log(
    `[SCAN] Market: ${
      marketOpen
        ? "OPEN"
        : "CLOSED"
    }`
  );

  if (!marketOpen) {
    for (
      const pair of PAIRS
    ) {
      setMarketClosed(pair);
    }

    state.lastScan =
      new Date().toISOString();

    return;
  }

  for (
    const pair of PAIRS
  ) {
    await scanPair(pair);

    await sleep(
      REQUEST_DELAY_MS
    );
  }

  state.lastScan =
    new Date().toISOString();

  console.log(
    `[SCAN COMPLETE] Requests this scan: ${state.api.requestsThisScan}`
  );

  console.log(
    `[TOTAL API REQUESTS] ${state.api.totalRequests}`
  );

  console.log(
    "===================================="
  );
}

/*
=========================================================
STATUS API
=========================================================
*/

app.get(
  "/api/status",
  (req, res) => {
    const marketOpen =
      isMarketOpen();

    res.json({
      online:
        state.online,

      marketOpen,

      marketStatus:
        marketOpen
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
  }
);

/*
=========================================================
ALERTS
=========================================================
*/

app.get(
  "/api/alerts",
  (req, res) => {
    res.json({
      ok: true,

      enabled:
        alertsEnabled,

      alerts:
        alertsEnabled
    });
  }
);

app.post(
  "/api/alerts",
  (req, res) => {
    alertsEnabled =
      Boolean(
        req.body.enabled
      );

    res.json({
      ok: true,

      enabled:
        alertsEnabled,

      alerts:
        alertsEnabled
    });
  }
);

/*
=========================================================
HEALTH
=========================================================
*/

app.get(
  "/health",
  (req, res) => {
    const marketOpen =
      isMarketOpen();

    res.json({
      ok: true,

      marketOpen,

      marketStatus:
        marketOpen
          ? "OPEN"
          : "CLOSED",

      time:
        new Date().toISOString()
    });
  }
);

/*
=========================================================
ROOT API
=========================================================
*/

app.get(
  "/api",
  (req, res) => {
    res.json({
      name:
        "Trading Cloud Monitor",

      status:
        "online",

      marketOpen:
        isMarketOpen(),

      engine:
        "12H + 1H + 5M",

      pairs:
        PAIRS,

      smc:
        true,

      rsi:
        true,

      pullbackDetection:
        true,

      freshConfirmation:
        true,

      lateEntryProtection:
        true,

      extensionProtection:
        true,

      h1Cache:
        true,

      h1CacheMinutes:
        60,

      fiveMinuteRefresh:
        true,

      riskReward:
        "1:2",

      message:
        "Fresh-entry trading signal engine running"
    });
  }
);

/*
=========================================================
START SERVER
=========================================================
*/

app.listen(
  PORT,
  async () => {
    console.log(
      "===================================="
    );

    console.log(
      "TRADING CLOUD MONITOR"
    );

    console.log(
      `Server running on port ${PORT}`
    );

    console.log(
      `Market: ${
        isMarketOpen()
          ? "OPEN"
          : "CLOSED"
      }`
    );

    console.log(
      `API Key: ${
        API_KEY
          ? "CONFIGURED"
          : "MISSING"
      }`
    );

    console.log(
      "===================================="
    );

    console.log(
      "PAIRS:"
    );

    for (
      const pair of PAIRS
    ) {
      console.log(
        `- ${pair}`
      );
    }

    console.log(
      "===================================="
    );

    console.log(
      "ENGINE: 12H + 1H + 5M"
    );

    console.log(
      "12H: CLOSED CANDLES ONLY"
    );

    console.log(
      "1H: CLOSED CANDLES ONLY"
    );

    console.log(
      "1H: CACHED FOR 60 MINUTES"
    );

    console.log(
      "5M: REFRESHED EVERY 5 MINUTES"
    );

    console.log(
      "SMC: ENABLED"
    );

    console.log(
      "RSI: ENABLED"
    );

    console.log(
      "BREAKOUT: ENABLED"
    );

    console.log(
      "REJECTION: ENABLED"
    );

    console.log(
      "PULLBACK DETECTION: ENABLED"
    );

    console.log(
      "FRESH CONFIRMATION: ENABLED"
    );

    console.log(
      "LATE ENTRY PROTECTION: ENABLED"
    );

    console.log(
      "EXTENSION PROTECTION: ENABLED"
    );

    console.log(
      "RISK/REWARD: 1:2"
    );

    console.log(
      "===================================="
    );

    console.log(
      "Telegram: " +
        (
          TELEGRAM_BOT_TOKEN &&
          TELEGRAM_CHAT_ID
            ? "CONFIGURED"
            : "NOT CONFIGURED"
        )
    );

    console.log(
      "===================================="
    );

    try {
      await scanAll();
    } catch (error) {
      console.error(
        "Initial scan error:",
        error.message
      );
    }

    setInterval(
      async () => {
        try {
          await scanAll();
        } catch (error) {
          console.error(
            "Scan loop error:",
            error.message
          );
        }
      },
      POLL_MS
    );
  }
);
