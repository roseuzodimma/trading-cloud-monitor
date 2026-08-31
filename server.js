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

/* =========================================================
   INITIAL PAIR STATE
========================================================= */

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
        current: "UNKNOWN"
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
========================================================= */

function isMarketOpen() {
  const now = new Date();

  const day = now.getUTCDay();

  const hour = now.getUTCHours();

  const minute = now.getUTCMinutes();

  const minutes = hour * 60 + minute;

  /*
    Sunday before 22:00 UTC = CLOSED
  */

  if (day === 0 && minutes < 1320) {
    return false;
  }

  /*
    Saturday = CLOSED
  */

  if (day === 6) {
    return false;
  }

  /*
    Friday after 22:00 UTC = CLOSED
  */

  if (day === 5 && minutes >= 1320) {
    return false;
  }

  return true;
}

/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function num(value) {
  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}

function average(values) {
  const clean = values.filter(
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

/* =========================================================
   TWELVE DATA API
========================================================= */

async function twelveData(
  symbol,
  interval,
  outputsize = 200
) {
  if (!API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY is missing"
    );
  }

  /*
    IMPORTANT:
    Twelve Data does NOT support 12h.

    We only request:
    - 1h
    - 5min

    12H is created locally from 1H candles.
  */

  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${outputsize}` +
    `&apikey=${encodeURIComponent(API_KEY)}`;

  state.api.totalRequests++;

  const response = await fetch(url);

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(
      `Twelve Data HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.message ||
      `Twelve Data HTTP ${response.status}`
    );
  }

  if (data.status === "error") {
    throw new Error(
      data.message ||
      "Twelve Data error"
    );
  }

  if (!Array.isArray(data.values)) {
    throw new Error(
      "No candle data returned"
    );
  }

  const candles = data.values
    .map(x => {
      const datetime = new Date(
        x.datetime
      );

      return {
        datetime,

        open: num(x.open),

        high: num(x.high),

        low: num(x.low),

        close: num(x.close),

        volume: num(x.volume)
      };
    })

    .filter(x => {
      return (
        !Number.isNaN(
          x.datetime.getTime()
        ) &&

        Number.isFinite(x.open) &&

        Number.isFinite(x.high) &&

        Number.isFinite(x.low) &&

        Number.isFinite(x.close)
      );
    })

    .sort(
      (a, b) =>
        a.datetime.getTime() -
        b.datetime.getTime()
    );

  if (!candles.length) {
    throw new Error(
      "No valid candles returned"
    );
  }

  return candles;
}

/* =========================================================
   BUILD REAL 12H CANDLES FROM 1H CANDLES
========================================================= */

function build12HCandles(hourlyCandles) {
  if (
    !hourlyCandles ||
    hourlyCandles.length < 12
  ) {
    return [];
  }

  const groups = new Map();

  for (const candle of hourlyCandles) {
    const time =
      candle.datetime.getTime();

    const twelveHours =
      12 * 60 * 60 * 1000;

    const bucket =
      Math.floor(
        time / twelveHours
      ) * twelveHours;

    if (!groups.has(bucket)) {
      groups.set(bucket, []);
    }

    groups
      .get(bucket)
      .push(candle);
  }

  const result = [];

  for (const [
    timestamp,
    candles
  ] of groups.entries()) {
    candles.sort(
      (a, b) =>
        a.datetime.getTime() -
        b.datetime.getTime()
    );

    /*
      We only use complete 12H candles.

      A complete candle needs 12 hourly candles.
    */

    if (candles.length < 12) {
      continue;
    }

    const first =
      candles[0];

    const last =
      candles[candles.length - 1];

    result.push({
      datetime:
        new Date(timestamp),

      open:
        first.open,

      high:
        Math.max(
          ...candles.map(
            x => x.high
          )
        ),

      low:
        Math.min(
          ...candles.map(
            x => x.low
          )
        ),

      close:
        last.close,

      volume:
        average(
          candles
            .map(x => x.volume)
            .filter(
              Number.isFinite
            )
        )
    });
  }

  return result.sort(
    (a, b) =>
      a.datetime.getTime() -
      b.datetime.getTime()
  );
}

/* =========================================================
   RSI
========================================================= */

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
      losses += Math.abs(
        change
      );
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
    100 /
      (1 + rs)
  );
}

/* =========================================================
   TREND
========================================================= */

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
        .map(x => x.close)
    );

  const slow =
    average(
      recent.map(
        x => x.close
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

/* =========================================================
   SWING HIGH
========================================================= */

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

/* =========================================================
   SWING LOW
========================================================= */

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

/* =========================================================
   SMC STRUCTURE
========================================================= */

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
    last.close > previousHigh
  ) {
    structure =
      "BULLISH";

    bos =
      "BULLISH";
  }

  if (
    previousLow !== null &&
    last.close < previousLow
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

/* =========================================================
   REJECTION
========================================================= */

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

/* =========================================================
   BREAKOUT
========================================================= */

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
    candles.slice(-6, -1);

  const highest =
    Math.max(
      ...previous.map(
        x => x.high
      )
    );

  const lowest =
    Math.min(
      ...previous.map(
        x => x.low
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

/* =========================================================
   12H ANALYSIS
========================================================= */

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
    Last candle may still be developing.

    Previous completed 12H candle is used
    as official bias.
  */

  const current =
    candles[
      candles.length - 1
    ];

  const previous =
    candles[
      candles.length - 2
    ];

  const previousClosed =
    candles.slice(
      0,
      candles.length - 1
    );

  const previousTrend =
    getTrend(
      previousClosed
    );

  const currentTrend =
    getTrend(candles);

  const previousRSI =
    calculateRSI(
      previousClosed
    );

  const currentRSI =
    calculateRSI(candles);

  let bias =
    previousTrend;

  /*
    Stable candle direction.
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

/* =========================================================
   ATR
========================================================= */

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

/* =========================================================
   ANALYZE PAIR
========================================================= */

function analyzePair(
  pair,
  h12,
  h1,
  m5
) {
  if (
    h12.length < 20 ||
    h1.length < 20 ||
    m5.length < 20
  ) {
    throw new Error(
      "Not enough candle data"
    );
  }

  const price =
    m5[
      m5.length - 1
    ].close;

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

  const h12Structure =
    getStructure(
      h12.slice(0, -1)
    );

  const rejection =
    rejectionSignal(
      m5[
        m5.length - 1
      ]
    );

  const breakout =
    breakoutSignal(m5);

  let buyScore = 0;

  let sellScore = 0;

  /* =====================================================
     12H
  ===================================================== */

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
   
