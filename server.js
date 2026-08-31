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
FREE PLAN CONFIGURATION
=========================================================
*/

const POLL_MS = Math.max(
  300000,
  Number(process.env.POLL_MS || 300000)
);

/*
  Start with only 3 instruments.

  You can add the others later when the API is stable.
*/
const PAIRS = [
  "XAU/USD",
  "EUR/USD",
  "GBP/USD"
];

/*
  API cooldown after HTTP 429.

  The bot will NOT continue hammering Twelve Data.
*/
const RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;

/*
  Small delay between successful requests.
*/
const REQUEST_DELAY_MS = 2500;

let alertsEnabled = true;

let apiCooldownUntil = 0;

const state = {
  online: true,

  lastScan: null,

  timeframe: "5min",

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
INITIAL PAIR STATE
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
        previousCandle: null
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

      liquidity: "—",

      confirmation: "WAITING"
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
    minutes < 22 * 60
  ) {
    return false;
  }

  /*
    Friday after 22:00 UTC
  */

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
  return new Promise(resolve =>
    setTimeout(resolve, ms)
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
    values.filter(Number.isFinite);

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
API COOLDOWN
=========================================================
*/

function isApiCoolingDown() {
  return Date.now() < apiCooldownUntil;
}

function startApiCooldown() {
  apiCooldownUntil =
    Date.now() +
    RATE_LIMIT_COOLDOWN_MS;

  state.api.cooldownUntil =
    new Date(
      apiCooldownUntil
    ).toISOString();

  state.api.status =
    "RATE_LIMIT_COOLDOWN";

  console.log(
    `[API] Rate-limit cooldown until ${state.api.cooldownUntil}`
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

  if (isApiCoolingDown()) {
    const remaining =
      Math.ceil(
        (apiCooldownUntil -
          Date.now()) /
          1000
      );

    throw new Error(
      `Twelve Data cooldown active (${remaining}s remaining)`
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

  let data = null;

  try {
    data =
      await response.json();
  } catch {
    data = null;
  }

  /*
    HTTP 429
  */

  if (response.status === 429) {
    startApiCooldown();

    throw new Error(
      "Twelve Data HTTP 429 - rate limit exceeded"
    );
  }

  if (!response.ok) {
    throw new Error(
      `Twelve Data HTTP ${response.status}`
    );
  }

  /*
    Twelve Data can sometimes return
    an error inside a HTTP 200 response.
  */

  if (
    data &&
    data.status === "error"
  ) {
    const message =
      data.message ||
      "Twelve Data error";

    if (
      /rate|limit|credit|quota/i.test(
        message
      )
    ) {
      startApiCooldown();
    }

    throw new Error(message);
  }

  if (
    !data ||
    !Array.isArray(data.values)
  ) {
    throw new Error(
      "No candle data returned"
    );
  }

  state.api.status =
    "CONNECTED";

  state.api.lastError =
    null;

  return data.values
    .map(candle => ({
      datetime:
        new Date(
          candle.datetime
        ),

      open:
        num(candle.open),

      high:
        num(candle.high),

      low:
        num(candle.low),

      close:
        num(candle.close),

      volume:
        num(candle.volume)
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
12H AGGREGATION
=========================================================
*/

function aggregate12HCandles(
  hourlyCandles
) {
  if (
    !hourlyCandles ||
    hourlyCandles.length < 12
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
    const candles of
      groups.values()
  ) {
    candles.sort(
      (a, b) =>
        a.datetime.getTime() -
        b.datetime.getTime()
    );

    /*
      Only complete 12H candles.
    */

    if (
      candles.length < 12
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
        )
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
    100 /
      (1 + rs)
  );
}

/*
=========================================================
TREND
=========================================================
*/

function getTrend(
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
    i < candles.length - 2;
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

  let liquidity = "—";

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

  /*
    Better rejection rule.

    A wick must be significantly larger
    than the candle body.
  */

  const minimum =
    Math.max(
      body * 1.5,
      0.0000001
    );

  return {
    bullish:
      lowerWick >
        minimum &&
      candle.close >
        candle.open,

    bearish:
      upperWick >
        minimum &&
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
12H ANALYSIS
=========================================================
*/

function get12HAnalysis(
  candles
) {
  if (
    !candles ||
    candles.length < 20
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

  /*
    Ignore the currently forming
    12H candle when determining
    the primary bias.
  */

  const completed =
    candles.slice(
      0,
      candles.length - 1
    );

  const previous =
    completed[
      completed.length - 1
    ];

  const current =
    candles[
      candles.length - 1
    ];

  const previousTrend =
    getTrend(completed);

  const currentTrend =
    getTrend(candles);

  const previousRSI =
    calculateRSI(
      completed
    );

  const currentRSI =
    calculateRSI(
      candles
    );

  let bias =
    previousTrend;

  /*
    Completed candle direction
    helps stabilize the bias.
  */

  if (
    previous.close >
      previous.open
  ) {
    if (
      previousTrend !==
      "BEARISH"
    ) {
      bias =
        "BULLISH";
    }
  }

  if (
    previous.close <
      previous.open
  ) {
    if (
      previousTrend !==
      "BULLISH"
    ) {
      bias =
        "BEARISH";
    }
  }

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

    bias,

    previousCandle:
      previous,

    currentCandle:
      current
  };
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

  const h12Structure =
    getStructure(
      h12.slice(0, -1)
    );

  const h1Structure =
    getStructure(h1);

  const m5Structure =
    getStructure(m5);

  const rejection =
    rejectionSignal(
      latest
    );

  const breakout =
    breakoutSignal(m5);

  let buyScore = 0;

  let sellScore = 0;

  /*
  ========================================================
  12H
  ========================================================
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
  ========================================================
  1H
  ========================================================
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
  ========================================================
  5M
  ========================================================

  IMPORTANT:

  5M direction is now REQUIRED.

  5M NEUTRAL cannot produce a trade.
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
  ========================================================
  RSI
  ========================================================
  */

  if (
    m5RSI !== null &&
    m5RSI >= 50 &&
    m5RSI <= 70
  ) {
    buyScore++;
  }

  if (
    m5RSI !== null &&
    m5RSI >= 30 &&
    m5RSI < 50
  ) {
    sellScore++;
  }

  /*
  ========================================================
  SMC
  ========================================================
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
  DEFAULT
  ========================================================
  */

  let status =
    "WAIT";

  let score =
    Math.max(
      buyScore,
      sellScore
    );

  let confirmation =
    "WAITING";

  /*
  ========================================================
  STRICT BUY CONFIRMATION
  ========================================================
  */

  const bullishMTF =
    h12Analysis.bias ===
      "BULLISH" &&
    h1Trend ===
      "BULLISH" &&
    m5Trend ===
      "BULLISH";

  /*
  ========================================================
  STRICT SELL CONFIRMATION
  ========================================================
  */

  const bearishMTF =
    h12Analysis.bias ===
      "BEARISH" &&
    h1Trend ===
      "BEARISH" &&
    m5Trend ===
      "BEARISH";

  /*
  ========================================================
  SMC CONFIRMATION
  ========================================================
  */

  const bullishStructure =
    m5Structure.bos ===
      "BULLISH" ||

    m5Structure.choch ===
      "BULLISH" ||

    breakout.bullish ||

    rejection.bullish;

  const bearishStructure =
    m5Structure.bos ===
      "BEARISH" ||

    m5Structure.choch ===
      "BEARISH" ||

    breakout.bearish ||

    rejection.bearish;

  /*
  ========================================================
  BUY
  ========================================================
  */

  if (
    bullishMTF &&
    bullishStructure &&
    buyScore >= 4
  ) {
    status =
      "BUY";

    confirmation =
      "CONFIRMED";
  }

  /*
  ========================================================
  SELL
  ========================================================
  */

  if (
    bearishMTF &&
    bearishStructure &&
    sellScore >= 4
  ) {
    status =
      "SELL";

    confirmation =
      "CONFIRMED";
  }

  /*
  ========================================================
  EXPLICIT 5M NEUTRAL PROTECTION
  ========================================================
  */

  if (
    m5Trend ===
    "NEUTRAL"
  ) {
    status =
      "WAIT";

    confirmation =
      "5M NEUTRAL — WAITING";

    score =
      Math.max(
        buyScore,
        sellScore
      );
  }

  /*
  ========================================================
  5M OPPOSITE DIRECTION PROTECTION
  ========================================================
  */

  if (
    h12Analysis.bias ===
      "BEARISH" &&
    h1Trend ===
      "BEARISH" &&
    m5Trend ===
      "BULLISH"
  ) {
    status =
      "WAIT";

    confirmation =
      "5M BULLISH AGAINST HTF";
  }

  if (
    h12Analysis.bias ===
      "BULLISH" &&
    h1Trend ===
      "BULLISH" &&
    m5Trend ===
      "BEARISH"
  ) {
    status =
      "WAIT";

    confirmation =
      "5M BEARISH AGAINST HTF";
  }

  /*
  ========================================================
  ATR
  ========================================================
  */

  const atr =
    calculateATR(m5);

  let extended =
    false;

  if (
    atr !== null
  ) {
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

    /*
      Prevent chasing a move.
    */

    if (
      distance >
      atr * 2.5
    ) {
      extended =
        true;

      status =
        "WAIT";

      confirmation =
        "MOVE EXTENDED — WAIT FOR PULLBACK";
    }
  }

  /*
  ========================================================
  ENTRY / SL / TP
  ========================================================
  */

  let entry =
    null;

  let stopLoss =
    null;

  let takeProfit =
    null;

  if (
    status ===
      "BUY" &&
    atr !== null
  ) {
    entry =
      price;

    stopLoss =
      Math.min(
        latest.low,
        price -
          atr * 1.2
      );

    const risk =
      entry -
      stopLoss;

    if (
      risk > 0
    ) {
      takeProfit =
        entry +
        risk * 2;
    }
  }

  if (
    status ===
      "SELL" &&
    atr !== null
  ) {
    entry =
      price;

    stopLoss =
      Math.max(
        latest.high,
        price +
          atr * 1.2
      );

    const risk =
      stopLoss -
      entry;

    if (
      risk > 0
    ) {
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
    "NEUTRAL";

  if (
    status ===
    "BUY"
  ) {
    if (
      rejection.bullish
    ) {
      location =
        "BULLISH REJECTION";
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
    status ===
    "SELL"
  ) {
    if (
      rejection.bearish
    ) {
      location =
        "BEARISH REJECTION";
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

  message +=
    ` | ${confirmation}`;

  if (
    extended
  ) {
    message =
      "Move extended — waiting for pullback/confirmation";
  }

  /*
  ========================================================
  RESULT
  ========================================================
  */

  return {
    symbol: pair,

    status,

    score,

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
          h12Analysis.previousRSI,

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

      location,

      extended,

      structure:
        m5Structure.structure,

      bos:
        m5Structure.bos,

      choch:
        m5Structure.choch,

      liquidity:
        m5Structure.liquidity,

      confirmation
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

  /*
    Never send an incomplete signal.
  */

  if (
    signal.entry === null ||
    signal.stopLoss === null ||
    signal.takeProfit === null
  ) {
    return;
  }

  const emoji =
    signal.status ===
      "BUY"
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

✅ 12H + 1H + 5M CONFIRMED
💰 Risk/Reward: 1:2

⚠️ Always confirm price action before entering.`;

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

    if (
      !response.ok
    ) {
      console.error(
        "Telegram HTTP error:",
        response.status
      );
    }
  } catch (
    error
  ) {
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

  result.price =
    null;

  result.entry =
    null;

  result.stopLoss =
    null;

  result.takeProfit =
    null;

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

    location:
      "MARKET CLOSED",

    extended:
      false,

    structure:
      "—",

    bos:
      "—",

    choch:
      "—",

    liquidity:
      "—",

    confirmation:
      "MARKET CLOSED"
  };
}

/*
=========================================================
OFFLINE STATE
=========================================================
*/

function setOffline(
  pair,
  message
) {
  const result =
    state.pairs[pair];

  result.status =
    "OFFLINE";

  result.score =
    0;

  result.message =
    message;

  result.price =
    null;

  result.entry =
    null;

  result.stopLoss =
    null;

  result.takeProfit =
    null;

  result.updated =
    new Date().toISOString();

  result.timeframes = {
    h12: {
      trend:
        "UNKNOWN",
      rsi: null,
      previous:
        "UNKNOWN",
      current:
        "UNKNOWN",
      previousCandle:
        null
    },

    h1: {
      trend:
        "UNKNOWN",
      rsi: null
    },

    m5: {
      trend:
        "UNKNOWN",
      rsi: null
    }
  };

  result.analysis = {
    direction:
      "WAIT",

    h12SMC:
      "UNKNOWN",

    h1SMC:
      "UNKNOWN",

    breakout:
      false,

    rejection:
      false,

    location:
      "—",

    extended:
      false,

    structure:
      "—",

    bos:
      "—",

    choch:
      "—",

    liquidity:
      "—",

    confirmation:
      "WAITING"
  };
}

/*
=========================================================
SCAN ONE PAIR
=========================================================
*/

async function scanPair(
  pair
) {
  const result =
    state.pairs[pair];

  if (
    !isMarketOpen()
  ) {
    setMarketClosed(pair);
    return;
  }

  if (
    isApiCoolingDown()
  ) {
    setOffline(
      pair,
      "Twelve Data rate-limit cooldown active"
    );

    return;
  }

  try {
    /*
      ONE 1H request.

      This data is used for BOTH:
      - 1H analysis
      - locally constructed 12H candles
    */

    const hourly =
      await twelveData(
        pair,
        "1h",
        120
      );

    state.api.requestsThisScan++;

    await sleep(
      REQUEST_DELAY_MS
    );

    /*
      Build 12H.
    */

    const h12 =
      aggregate12HCandles(
        hourly
      );

    /*
      1H.
    */

    const h1 =
      hourly.slice(-100);

    /*
      5M.
    */

    if (
      isApiCoolingDown()
    ) {
      setOffline(
        pair,
        "Rate limit reached before 5M request"
      );

      return;
    }

    const m5 =
      await twelveData(
        pair,
        "5min",
        100
      );

    state.api.requestsThisScan++;

    if (
      h12.length < 20
    ) {
      throw new Error(
        "Not enough completed 12H candles"
      );
    }

    if (
      h1.length < 20
    ) {
      throw new Error(
        "Not enough 1H candles"
      );
    }

    if (
      m5.length < 20
    ) {
      throw new Error(
        "Not enough 5M candles"
      );
    }

    const signal =
      analyzePair(
        pair,
        h12,
        h1,
        m5
      );

    const oldStatus =
      result.status;

    /*
      Telegram only for NEW signals.
    */

    if (
      signal.status ===
        "BUY" &&
      oldStatus !==
        "BUY"
    ) {
      state.performance
        .totalSignals++;

      state.performance
        .buys++;

      await sendTelegramSignal(
        signal
      );
    }

    if (
      signal.status ===
        "SELL" &&
      oldStatus !==
        "SELL"
    ) {
      state.performance
        .totalSignals++;

      state.performance
        .sells++;

      await sendTelegramSignal(
        signal
      );
    }

    state.pairs[pair] =
      signal;

  } catch (
    error
  ) {
    console.error(
      `[${pair}] ${error.message}`
    );

    /*
      If API is rate-limited,
      don't continue attacking it.
    */

    if (
      /429|rate limit|quota|credit/i.test(
        error.message
      )
    ) {
      startApiCooldown();
    }

    setOffline(
      pair,
      error.message
    );

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

  if (
    isApiCoolingDown()
  ) {
    console.log(
      "[SCAN] API cooldown active — skipping scan"
    );

    state.lastScan =
      new Date().toISOString();

    for (
      const pair of PAIRS
    ) {
      setOffline(
        pair,
        "Twelve Data rate-limit cooldown active"
      );
    }

    return;
  }

  const marketOpen =
    isMarketOpen();

  state.online =
    true;

  console.log(
    `[SCAN] Market ${
      marketOpen
        ? "OPEN"
        : "CLOSED"
    }`
  );

  if (
    !marketOpen
  ) {
    for (
      const pair of PAIRS
    ) {
      setMarketClosed(pair);
    }

    state.lastScan =
      new Date().toISOString();

    return;
  }

  /*
    Sequential scanning.
  */

  for (
    const pair of PAIRS
  ) {
    if (
      isApiCoolingDown()
    ) {
      break;
    }

    await scanPair(pair);

    /*
      Larger delay between pairs.
    */

    await sleep(
      REQUEST_DELAY_MS
    );
  }

  state.lastScan =
    new Date().toISOString();

  console.log(
    `[SCAN COMPLETE] Requests this scan: ${state.api.requestsThisScan}`
  );
}

/*
=========================================================
STATUS
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

      api: {
        ...state.api,

        cooldownActive:
          isApiCoolingDown()
      }
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
    res.json({
      ok: true,

      marketOpen:
        isMarketOpen(),

      marketStatus:
        isMarketOpen()
          ? "OPEN"
          : "CLOSED",

      apiConfigured:
        Boolean(API_KEY),

      apiCooldown:
        isApiCoolingDown(),

      time:
        new Date().toISOString()
    });
  }
);

/*
=========================================================
ROOT
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

      smc:
        true,

      confirmation:
        "12H + 1H + 5M + SMC",

      message:
        "Trading signal engine running"
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
      "Trading Cloud Monitor"
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
      "Pairs: XAU/USD, EUR/USD, GBP/USD"
    );

    console.log(
      "12H: BUILT FROM 1H"
    );

    console.log(
      "1H: Twelve Data"
    );

    console.log(
      "5M: Twelve Data"
    );

    console.log(
      "SMC: ENABLED"
    );

    console.log(
      "5M NEUTRAL: NO TRADE"
    );

    console.log(
      "12H + 1H + 5M: REQUIRED"
    );

    console.log(
      "API RATE LIMIT PROTECTION: ENABLED"
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

    /*
      Initial scan.
    */

    try {
      await scanAll();
    } catch (
      error
    ) {
      console.error(
        "Initial scan error:",
        error.message
      );
    }

    /*
      Continue scanning.
    */

    setInterval(
      async () => {
        try {
          await scanAll();
        } catch (
          error
        ) {
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
