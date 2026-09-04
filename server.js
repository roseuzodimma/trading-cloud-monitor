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
TRADING CLOUD MONITOR
=========================================================

ENGINE:

12H + 1H + 5M

PAIRS:

XAU/USD
GBP/JPY

5M:
Fresh every 5 minutes

1H:
Cached for 60 minutes

12H:
Built from 1H candles

SIGNAL:
Requires:

12H confirmation
+
1H confirmation
+
5M confirmation

SMC:
BOS
CHoCH
Liquidity
Breakout
Rejection
FVG
Retracement

NEWS PROTECTION:

Before high-impact news
        ↓
WAIT

Immediately after news
        ↓
WAIT

After market settles
        ↓
5M liquidity sweep
        ↓
BOS / CHoCH
        ↓
Retracement / FVG
        ↓
ENTRY

RISK:
1:2

=========================================================
*/

/*
=========================================================
SETTINGS
=========================================================
*/

const TIMEFRAME = "5min";

const POLL_MS = Math.max(
  300000,
  Number(process.env.POLL_MS || 300000)
);

const H1_REFRESH_MS = 60 * 60 * 1000;

const API_DELAY_MS = 1200;

const RATE_LIMIT_COOLDOWN_MS = 60000;

/*
=========================================================
NEWS SETTINGS
=========================================================

These settings only affect periods around
HIGH-IMPACT economic events.

Normal trading outside the news window
continues using the existing strategy.

=========================================================
*/

/*
How long before a high-impact event to WAIT.
*/

const NEWS_BEFORE_MINUTES = 15;

/*
Immediately after news, remain WAIT.
*/

const NEWS_AFTER_MINUTES = 15;

/*
Additional settlement period.

This gives the first news spike time to calm down.
*/

const NEWS_SETTLE_MINUTES = 15;

/*
Refresh Biquote calendar every 5 minutes.

This does NOT consume Twelve Data credits.
*/

const NEWS_REFRESH_MS = 5 * 60 * 1000;

/*
Biquote calendar endpoint.
*/

const NEWS_CALENDAR_URL =
  "https://biquote.io/api/calendar";

/*
=========================================================
ONLY 2 PAIRS
=========================================================
*/

const PAIRS = [
  "XAU/USD",
  "GBP/JPY"
];

/*
=========================================================
ALERT SETTINGS
=========================================================
*/

let alertsEnabled = true;

/*
=========================================================
STATE
=========================================================
*/

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
  },

  newsProtection: {
    enabled: true,

    source: "Biquote",

    lastRefresh: null,

    status: "WAITING",

    events: [],

    error: null
  }
};

/*
=========================================================
H1 CACHE
=========================================================
*/

const h1Cache = {};

for (const pair of PAIRS) {
  h1Cache[pair] = {
    candles: null,
    updated: null
  };
}

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

    message:
      "Waiting for market data...",

    price: null,

    entry: null,

    stopLoss: null,

    takeProfit: null,

    updated: null,

    newsProtection: {
      active: false,
      phase: "CLEAR",
      event: null,
      message: "No high-impact news protection active."
    },

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

      location: "NEUTRAL",

      extended: false,

      structure: "—",

      bos: "—",

      choch: "—",

      liquidity: "—",

      fvg: "—",

      retracement: false,

      newsConfirmed: false
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
NEWS HELPERS
=========================================================
*/

/*
Normalize a country/currency/event string.
*/

function normalizeNewsText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value)
    .trim()
    .toUpperCase();
}

/*
Convert many possible date formats to a Date.
*/

function parseNewsDate(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : value;
  }

  const date = new Date(value);

  if (!Number.isNaN(date.getTime())) {
    return date;
  }

  return null;
}

/*
Extract the event datetime from different possible
Biquote calendar field names.

The calendar format can evolve, so this keeps the
news layer tolerant without affecting the trading engine.
*/

function getNewsEventDate(event) {
  const candidates = [
    event.datetime,
    event.dateTime,
    event.datetime_utc,
    event.dateTimeUTC,
    event.timestamp,
    event.time,
    event.date
  ];

  for (const candidate of candidates) {
    const parsed = parseNewsDate(candidate);

    if (parsed) {
      return parsed;
    }
  }

  return null;
}

/*
Extract importance.
*/

function getNewsImportance(event) {
  const values = [
    event.importance,
    event.impact,
    event.priority
  ];

  for (const value of values) {
    const text =
      normalizeNewsText(value);

    if (text) {
      return text;
    }
  }

  return "";
}

/*
Extract country.
*/

function getNewsCountry(event) {
  const values = [
    event.country,
    event.country_code,
    event.countryCode,
    event.currency
  ];

  for (const value of values) {
    const text =
      normalizeNewsText(value);

    if (text) {
      return text;
    }
  }

  return "";
}

/*
Extract title/name.
*/

function getNewsTitle(event) {
  const values = [
    event.title,
    event.name,
    event.event,
    event.description
  ];

  for (const value of values) {
    if (value !== undefined && value !== null) {
      const text = String(value).trim();

      if (text) {
        return text;
      }
    }
  }

  return "High-impact economic event";
}

/*
Determine whether an event is high impact.

*/

function isHighImpactEvent(event) {
  const importance =
    getNewsImportance(event);

  return (
    importance === "HIGH" ||
    importance === "3" ||
    importance === "HIGH IMPACT" ||
    importance === "RED"
  );
}

/*
=========================================================
PAIR NEWS MAPPING
=========================================================
*/

function getNewsCountriesForPair(pair) {
  if (pair === "GBP/JPY") {
    return ["GB", "JP", "GBP", "JPY"];
  }

  if (pair === "XAU/USD") {
    return ["US", "USD"];
  }

  return [];
}

/*
Determine whether a news event belongs to the pair.
*/

function newsEventAffectsPair(
  event,
  pair
) {
  const country =
    getNewsCountry(event);

  if (!country) {
    return false;
  }

  const allowed =
    getNewsCountriesForPair(pair);

  return allowed.includes(country);
}

/*
=========================================================
FETCH BIQUOTE NEWS
=========================================================
*/

async function refreshNewsCalendar() {
  if (!state.newsProtection.enabled) {
    return;
  }

  const now = Date.now();

  /*
  Do not refresh more often than configured.
  */

  if (
    state.newsProtection.lastRefresh &&
    now -
      state.newsProtection.lastRefresh <
      NEWS_REFRESH_MS
  ) {
    return;
  }

  const from =
    new Date(
      now -
      24 * 60 * 60 * 1000
    ).toISOString();

  const to =
    new Date(
      now +
      48 * 60 * 60 * 1000
    ).toISOString();

  const params =
    new URLSearchParams({
      from,
      to,
      countries: "GB,JP,US",
      importance: "high",
      type: "event",
      limit: "100"
    });

  const url =
    `${NEWS_CALENDAR_URL}?${params.toString()}`;

  try {
    console.log(
      "[NEWS] Refreshing Biquote calendar..."
    );

    const response =
      await fetch(url);

    const data =
      await response.json().catch(
        () => null
      );

    if (!response.ok) {
      throw new Error(
        `Biquote HTTP ${response.status}`
      );
    }

    /*
    Biquote may return an array directly
    or wrap it inside common fields.
    */

    let events = [];

    if (Array.isArray(data)) {
      events = data;
    } else if (
      data &&
      Array.isArray(data.data)
    ) {
      events = data.data;
    } else if (
      data &&
      Array.isArray(data.events)
    ) {
      events = data.events;
    } else if (
      data &&
      Array.isArray(data.results)
    ) {
      events = data.results;
    }

    /*
    Normalize and retain useful events.
    */

    const normalized = events
      .map(event => {
        const datetime =
          getNewsEventDate(event);

        return {
          datetime:
            datetime
              ? datetime.toISOString()
              : null,

          timestamp:
            datetime
              ? datetime.getTime()
              : null,

          country:
            getNewsCountry(event),

          importance:
            getNewsImportance(event),

          title:
            getNewsTitle(event)
        };
      })
      .filter(event =>
        event.timestamp !== null
      )
      .filter(event =>
        isHighImpactEvent(event)
      )
      .sort(
        (a, b) =>
          a.timestamp -
          b.timestamp
      );

    state.newsProtection.events =
      normalized;

    state.newsProtection.lastRefresh =
      now;

    state.newsProtection.error =
      null;

    state.newsProtection.status =
      "READY";

    console.log(
      `[NEWS] Loaded ${normalized.length} high-impact events`
    );

  } catch (error) {
    /*
    IMPORTANT:

    News failure must NOT crash the trading engine.

    Existing cached events are retained.
    */

    state.newsProtection.error =
      error.message;

    console.error(
      "[NEWS] Calendar error:",
      error.message
    );

    /*
    If we have never received news data,
    fail open and allow the normal strategy.
    */

    if (
      !state.newsProtection.lastRefresh
    ) {
      state.newsProtection.status =
        "UNAVAILABLE";
    }
  }
}

/*
=========================================================
NEWS PROTECTION STATUS
=========================================================
*/

function getNewsProtection(
  pair
) {
  const now = Date.now();

  const events =
    state.newsProtection.events || [];

  const relevantEvents =
    events.filter(event =>
      newsEventAffectsPair(
        event,
        pair
      )
    );

  let nearest = null;

  let nearestDistance =
    Infinity;

  for (
    const event of relevantEvents
  ) {
    const distance =
      Math.abs(
        event.timestamp -
        now
      );

    if (
      distance <
      nearestDistance
    ) {
      nearest =
        event;

      nearestDistance =
        distance;
    }
  }

  if (!nearest) {
    return {
      active: false,
      phase: "CLEAR",
      event: null,
      message:
        "No high-impact news protection active."
    };
  }

  const eventTime =
    nearest.timestamp;

  const beforeStart =
    eventTime -
    NEWS_BEFORE_MINUTES *
      60 *
      1000;

  const afterStart =
    eventTime;

  const afterEnd =
    eventTime +
    (
      NEWS_AFTER_MINUTES +
      NEWS_SETTLE_MINUTES
    ) *
    60 *
    1000;

  /*
  BEFORE NEWS
  */

  if (
    now >= beforeStart &&
    now < afterStart
  ) {
    return {
      active: true,

      phase: "BEFORE_NEWS",

      event: nearest,

      message:
        `High-impact news approaching: ${nearest.title}. Waiting before news.`
    };
  }

  /*
  IMMEDIATELY AFTER NEWS
  */

  if (
    now >= afterStart &&
    now <
      eventTime +
      NEWS_AFTER_MINUTES *
        60 *
        1000
  ) {
    return {
      active: true,

      phase: "AFTER_NEWS",

      event: nearest,

      message:
        `High-impact news just released: ${nearest.title}. Waiting for the first move to settle.`
    };
  }

  /*
  SETTLEMENT PERIOD
  */

  if (
    now >=
      eventTime +
      NEWS_AFTER_MINUTES *
        60 *
        1000 &&
    now < afterEnd
  ) {
    return {
      active: true,

      phase: "SETTLING",

      event: nearest,

      message:
        `Post-news settlement: ${nearest.title}. Waiting for 5M structure, liquidity sweep and retracement.`
    };
  }

  return {
    active: false,

    phase: "CLEAR",

    event: null,

    message:
      "No high-impact news protection active."
  };
}

/*
=========================================================
FVG DETECTION
=========================================================
*/

/*
Bullish FVG:

Current candle low is above
the high of the candle two positions back.

Bearish FVG:

Current candle high is below
the low of the candle two positions back.
*/

function detectFVG(candles) {
  if (
    !candles ||
    candles.length < 3
  ) {
    return {
      bullish: false,
      bearish: false,
      type: "—",
      high: null,
      low: null
    };
  }

  const a =
    candles[
      candles.length - 3
    ];

  const b =
    candles[
      candles.length - 2
    ];

  const c =
    candles[
      candles.length - 1
    ];

  /*
  Bullish imbalance.
  */

  if (
    c.low > a.high
  ) {
    return {
      bullish: true,
      bearish: false,
      type: "BULLISH FVG",
      high: c.low,
      low: a.high
    };
  }

  /*
  Bearish imbalance.
  */

  if (
    c.high < a.low
  ) {
    return {
      bullish: false,
      bearish: true,
      type: "BEARISH FVG",
      high: a.low,
      low: c.high
    };
  }

  return {
    bullish: false,
    bearish: false,
    type: "—",
    high: null,
    low: null
  };
}

/*
=========================================================
RECENT FVG
=========================================================
*/

function findRecentFVG(
  candles,
  direction
) {
  if (
    !candles ||
    candles.length < 3
  ) {
    return null;
  }

  /*
  Search backwards for a recent FVG.
  */

  for (
    let i =
      candles.length - 1;
    i >= 2;
    i--
  ) {
    const a =
      candles[i - 2];

    const c =
      candles[i];

    if (
      direction === "BUY" &&
      c.low > a.high
    ) {
      return {
        type: "BULLISH FVG",

        low: a.high,

        high: c.low,

        index: i
      };
    }

    if (
      direction === "SELL" &&
      c.high < a.low
    ) {
      return {
        type: "BEARISH FVG",

        low: c.high,

        high: a.low,

        index: i
      };
    }
  }

  return null;
}

/*
=========================================================
RETRACEMENT DETECTION
=========================================================
*/

/*
We do not force retracement during normal trading.

This is primarily used after news.

The purpose is to avoid entering the initial
news spike.

BUY:
Price should move away from the recent low
and then come back toward the recent structure/FVG.

SELL:
Price should move away from recent high
and then retrace toward structure/FVG.
*/

function detectRetracement(
  candles,
  direction
) {
  if (
    !candles ||
    candles.length < 8
  ) {
    return false;
  }

  const recent =
    candles.slice(-8);

  const current =
    recent[
      recent.length - 1
    ];

  const midpoint =
    Math.floor(
      recent.length / 2
    );

  const firstHalf =
    recent.slice(
      0,
      midpoint
    );

  const secondHalf =
    recent.slice(
      midpoint
    );

  if (
    direction === "BUY"
  ) {
    const firstLow =
      Math.min(
        ...firstHalf.map(
          c => c.low
        )
      );

    const firstHigh =
      Math.max(
        ...firstHalf.map(
          c => c.high
        )
      );

    const secondHigh =
      Math.max(
        ...secondHalf.map(
          c => c.high
        )
      );

    /*
    Market moved up first,
    then current candle has pulled
    back from the recent high.
    */

    return (
      secondHigh >
        firstHigh &&
      current.close <
        secondHigh &&
      current.close >
        firstLow
    );
  }

  if (
    direction === "SELL"
  ) {
    const firstLow =
      Math.min(
        ...firstHalf.map(
          c => c.low
        )
      );

    const firstHigh =
      Math.max(
        ...firstHalf.map(
          c => c.high
        )
      );

    const secondLow =
      Math.min(
        ...secondHalf.map(
          c => c.low
        )
      );

    return (
      secondLow <
        firstLow &&
      current.close >
        secondLow &&
      current.close <
        firstHigh
    );
  }

  return false;
}

/*
=========================================================
NEWS POST-SETTLEMENT CONFIRMATION
=========================================================

This is intentionally NOT applied during normal
market conditions.

It only becomes active during SETTLING.

Required sequence:

5M liquidity sweep
+
BOS/CHoCH
+
retracement/FVG
+
normal 12H/1H confirmation

=========================================================
*/

function getNewsSetupConfirmation(
  m5,
  direction
) {
  const structure =
    getStructure(m5);

  const fvg =
    findRecentFVG(
      m5,
      direction
    );

  const retracement =
    detectRetracement(
      m5,
      direction
    );

  let liquiditySweep =
    false;

  if (
    direction === "BUY"
  ) {
    liquiditySweep =
      structure.liquidity ===
      "SELL-SIDE SWEPT";
  }

  if (
    direction === "SELL"
  ) {
    liquiditySweep =
      structure.liquidity ===
      "BUY-SIDE SWEPT";
  }

  let bosOrChoch =
    false;

  if (
    direction === "BUY"
  ) {
    bosOrChoch =
      structure.bos ===
        "BULLISH" ||
      structure.choch ===
        "BULLISH";
  }

  if (
    direction === "SELL"
  ) {
    bosOrChoch =
      structure.bos ===
        "BEARISH" ||
      structure.choch ===
        "BEARISH";
  }

  const fvgConfirmed =
    direction === "BUY"
      ? Boolean(
          fvg &&
          fvg.type ===
            "BULLISH FVG"
        )
      : Boolean(
          fvg &&
          fvg.type ===
            "BEARISH FVG"
        );

  /*
  We accept either retracement OR a valid FVG
  after the liquidity/structure event.

  This avoids making the filter unnecessarily strict.
  */

  const retracementOrFVG =
    retracement ||
    fvgConfirmed;

  const confirmed =
    liquiditySweep &&
    bosOrChoch &&
    retracementOrFVG;

  return {
    confirmed,

    liquiditySweep,

    bosOrChoch,

    retracement,

    fvg: fvgConfirmed,

    fvgType:
      fvg
        ? fvg.type
        : "—",

    structure
  };
}

/*
=========================================================
TWELVE DATA
=========================================================
*/

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

  if (
    state.api.cooldownUntil &&
    Date.now() <
      state.api.cooldownUntil
  ) {
    const remaining =
      Math.ceil(
        (
          state.api.cooldownUntil -
          Date.now()
        ) / 1000
      );

    throw new Error(
      `Twelve Data cooldown active (${remaining}s)`
    );
  }

  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${outputsize}` +
    `&apikey=${encodeURIComponent(API_KEY)}`;

  state.api.totalRequests++;

  console.log(
    `[API] ${symbol} ${interval}`
  );

  const response =
    await fetch(url);

  const data =
    await response.json().catch(
      () => null
    );

  if (
    response.status === 429
  ) {
    state.api.cooldownUntil =
      Date.now() +
      RATE_LIMIT_COOLDOWN_MS;

    state.api.lastError =
      "Twelve Data HTTP 429 - rate limit exceeded";

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
      "Twelve Data API error"
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
        new Date(candle.datetime),

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
      Number.isFinite(candle.open) &&
      Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) &&
      Number.isFinite(candle.close)
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

    const blockHour =
      hour < 12 ? 0 : 12;

    const key =
      `${year}-${month}-${day}-${blockHour}`;

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
    const candles of groups.values()
  ) {
    candles.sort(
      (a, b) =>
        a.datetime.getTime() -
        b.datetime.getTime()
    );

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

  if (
    avgLoss === 0
  ) {
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
SWING HIGH
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

/*
=========================================================
SWING LOW
=========================================================
*/

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
12H ANALYSIS
=========================================================
*/

function get12HAnalysis(
  candles
) {
  if (
    !candles ||
    candles.length < 21
  ) {
    return {
      previousTrend:
        "UNKNOWN",

      currentTrend:
        "UNKNOWN",

      previousRSI:
        null,

      currentRSI:
        null,

      bias:
        "UNKNOWN",

      previousCandle:
        null,

      currentCandle:
        null
    };
  }

  const closedCandles =
    candles.slice(
      0,
      candles.length - 1
    );

  const previous =
    closedCandles[
      closedCandles.length - 1
    ];

  const current =
    candles[
      candles.length - 1
    ];

  const previousSet =
    closedCandles.slice(
      0,
      closedCandles.length - 1
    );

  const previousTrend =
    getTrend(
      previousSet
    );

  const currentTrend =
    getTrend(
      closedCandles
    );

  const previousRSI =
    calculateRSI(
      previousSet
    );

  const currentRSI =
    calculateRSI(
      closedCandles
    );

  let bias =
    currentTrend;

  if (
    previous.close >
      previous.open &&
    currentTrend !==
      "BEARISH"
  ) {
    bias =
      "BULLISH";
  }

  if (
    previous.close <
      previous.open &&
    currentTrend !==
      "BULLISH"
  ) {
    bias =
      "BEARISH";
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
  m5,
  newsProtection = null
) {
  if (
    h12.length < 21 ||
    h1.length < 20 ||
    m5.length < 20
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
  ================================================
  TIMEFRAME ANALYSIS
  ================================================
  */

  const h12Analysis =
    get12HAnalysis(h12);

  const h1Trend =
    getTrend(h1);

  const m5Trend =
    getTrend(m5);

  const h12RSI =
    calculateRSI(
      h12.slice(
        0,
        h12.length - 1
      )
    );

  const h1RSI =
    calculateRSI(h1);

  const m5RSI =
    calculateRSI(m5);

  /*
  ================================================
  SMC
  ================================================
  */

  const h12Structure =
    getStructure(
      h12.slice(
        0,
        h12.length - 1
      )
    );

  const h1Structure =
    getStructure(h1);

  const m5Structure =
    getStructure(m5);

  /*
  ================================================
  PRICE ACTION
  ================================================
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
  ================================================
  FVG
  ================================================
  */

  const currentFVG =
    detectFVG(m5);

  /*
  ================================================
  SCORE
  ================================================
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
    m5RSI <= 70
  ) {
    buyScore++;
  }

  if (
    m5RSI !== null &&
    m5RSI >= 30 &&
    m5RSI <= 50
  ) {
    sellScore++;
  }

  /*
  ================================================
  SMC CONFIRMATION
  ================================================
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

  let status =
    "WAIT";

  let score =
    Math.max(
      buyScore,
      sellScore
    );

  /*
  ================================================
  STRONG BUY
  ================================================
  */

  if (
    buyScore >= 4 &&
    h12Analysis.bias ===
      "BULLISH" &&
    h1Trend ===
      "BULLISH"
  ) {
    status =
      "BUY";
  }

  /*
  ================================================
  STRONG SELL
  ================================================
  */

  if (
    sellScore >= 4 &&
    h12Analysis.bias ===
      "BEARISH" &&
    h1Trend ===
      "BEARISH"
  ) {
    status =
      "SELL";
  }

  /*
  ================================================
  NEWS PROTECTION
  ================================================

  IMPORTANT:

  Outside the news window,
  the existing strategy above remains unchanged.

  During news:

  BEFORE_NEWS:
  WAIT

  AFTER_NEWS:
  WAIT

  SETTLING:
  require:

  5M liquidity sweep
  +
  BOS/CHoCH
  +
  retracement OR FVG

  ================================================
  */

  let newsConfirmed =
    false;

  let newsSetup = {
    confirmed: false,
    liquiditySweep: false,
    bosOrChoch: false,
    retracement: false,
    fvg: false,
    fvgType: "—"
  };

  if (
    newsProtection &&
    newsProtection.active
  ) {
    /*
    Before news and immediately after news:
    no trade.
    */

    if (
      newsProtection.phase ===
        "BEFORE_NEWS" ||
      newsProtection.phase ===
        "AFTER_NEWS"
    ) {
      status =
        "WAIT";

      entry = null;
    }

    /*
    During settlement:

    Only allow a normal BUY/SELL signal
    if the post-news SMC sequence appears.
    */

    if (
      newsProtection.phase ===
      "SETTLING"
    ) {
      const candidateDirection =
        status === "BUY"
          ? "BUY"
          : status === "SELL"
            ? "SELL"
            : null;

      if (
        candidateDirection
      ) {
        newsSetup =
          getNewsSetupConfirmation(
            m5,
            candidateDirection
          );

        newsConfirmed =
          newsSetup.confirmed;

        if (
          !newsConfirmed
        ) {
          status =
            "WAIT";
        }
      } else {
        status =
          "WAIT";
      }
    }
  }

  /*
  ================================================
  EXTENSION PROTECTION
  ================================================
  */

  const atr =
    calculateATR(m5);

  let extended = false;

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
      atr * 2.5
    ) {
      extended = true;

      status =
        "WAIT";
    }
  }

  /*
  ================================================
  ENTRY / SL / TP
  ================================================
  */

  let entry = null;

  let stopLoss = null;

  let takeProfit = null;

  /*
  BUY
  */

  if (
    status === "BUY" &&
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

    if (risk > 0) {
      takeProfit =
        entry +
        risk * 2;
    }
  }

  /*
  SELL
  */

  if (
    status === "SELL" &&
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

    if (risk > 0) {
      takeProfit =
        entry -
        risk * 2;
    }
  }

  /*
  ================================================
  LOCATION
  ================================================
  */

  let location =
    "NEUTRAL";

  if (
    status === "BUY"
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
    } else if (
      m5Structure.bos ===
      "BULLISH"
    ) {
      location =
        "BULLISH BOS";
    } else {
      location =
        "BULLISH STRUCTURE";
    }
  }

  if (
    status === "SELL"
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
    } else if (
      m5Structure.bos ===
      "BEARISH"
    ) {
      location =
        "BEARISH BOS";
    } else {
      location =
        "BEARISH STRUCTURE";
    }
  }

  /*
  During post-news settlement,
  make the reason visible.
  */

  if (
    newsProtection &&
    newsProtection.active
  ) {
    if (
      newsProtection.phase ===
        "BEFORE_NEWS" ||
      newsProtection.phase ===
        "AFTER_NEWS"
    ) {
      location =
        "NEWS PROTECTION";
    }

    if (
      newsProtection.phase ===
      "SETTLING"
    ) {
      if (
        newsConfirmed
      ) {
        location =
          "POST-NEWS SMC CONFIRMED";
      } else {
        location =
          "POST-NEWS WAIT";
      }
    }
  }

  /*
  ================================================
  MESSAGE
  ================================================
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
    status === "BUY"
  ) {
    message +=
      " | Bullish confirmation";
  }

  if (
    status === "SELL"
  ) {
    message +=
      " | Bearish confirmation";
  }

  if (
    newsProtection &&
    newsProtection.active
  ) {
    if (
      newsProtection.phase ===
      "BEFORE_NEWS"
    ) {
      message =
        "NEWS WAIT — " +
        newsProtection.message;
    }

    if (
      newsProtection.phase ===
      "AFTER_NEWS"
    ) {
      message =
        "NEWS WAIT — " +
        newsProtection.message;
    }

    if (
      newsProtection.phase ===
      "SETTLING"
    ) {
      if (
        newsConfirmed
      ) {
        message =
          "POST-NEWS SETUP CONFIRMED — 5M liquidity sweep + BOS/CHoCH + retracement/FVG";
      } else {
        message =
          "POST-NEWS WAIT — waiting for 5M liquidity sweep + BOS/CHoCH + retracement/FVG";
      }
    }
  }

  if (extended) {
    message =
      "Move extended — waiting for pullback/confirmation";
  }

  /*
  ================================================
  RETURN
  ================================================
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

    newsProtection: {
      active:
        newsProtection
          ? newsProtection.active
          : false,

      phase:
        newsProtection
          ? newsProtection.phase
          : "CLEAR",

      event:
        newsProtection
          ? newsProtection.event
          : null,

      message:
        newsProtection
          ? newsProtection.message
          : "No high-impact news protection active."
    },

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

      fvg:
        currentFVG.type,

      retracement:
        newsSetup.retracement,

      newsConfirmed
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

  if (
    signal.entry === null ||
    signal.stopLoss === null ||
    signal.takeProfit === null
  ) {
    console.log(
      `[${signal.symbol}] Signal rejected: incomplete Entry/SL/TP`
    );

    return;
  }

  const emoji =
    signal.status === "BUY"
      ? "🟢"
      : "🔴";

  let newsText =
    "";

  if (
    signal.newsProtection &&
    signal.newsProtection.active
  ) {
    newsText =
      `\n📰 News Protection: ${signal.newsProtection.phase}\n`;

    if (
      signal.analysis.newsConfirmed
    ) {
      newsText +=
        "✅ Post-news SMC sequence confirmed\n";
    }
  }

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
📦 FVG: ${signal.analysis.fvg}

⏱ Entry TF: 5M
🔎 Confirmation: 12H + 1H + 5M
💰 Risk/Reward: 1:2
${newsText}
⚠️ Wait for candle confirmation before entry.`;

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

    const data =
      await response.json().catch(
        () => null
      );

    if (!response.ok) {
      console.error(
        "Telegram HTTP error:",
        response.status,
        data
      );

      return;
    }

    console.log(
      `[TELEGRAM] ${signal.status} ${signal.symbol} sent`
    );

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

  result.score = 0;

  result.message =
    "Market closed — monitoring will resume when the market opens.";

  result.price = null;

  result.entry = null;

  result.stopLoss = null;

  result.takeProfit = null;

  result.updated =
    new Date().toISOString();

  result.newsProtection = {
    active: false,
    phase: "MARKET_CLOSED",
    event: null,
    message: "Market closed."
  };

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

    fvg:
      "—",

    retracement:
      false,

    newsConfirmed:
      false
  };
}

/*
=========================================================
GET 1H DATA
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
      `[${pair}] 1H CACHE`
    );

    return cached.candles;
  }

  console.log(
    `[${pair}] 1H REFRESH`
  );

  await sleep(
    API_DELAY_MS
  );

  const hourly =
    await twelveData(
      pair,
      "1h",
      500
    );

  state.api.requestsThisScan++;

  cached.candles =
    hourly;

  cached.updated =
    now;

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
  const result =
    state.pairs[pair];

  result.updated =
    new Date().toISOString();

  if (
    !isMarketOpen()
  ) {
    setMarketClosed(pair);

    return;
  }

  try {
    /*
    ================================================
    NEWS REFRESH
    ================================================
    */

    await refreshNewsCalendar();

    const newsProtection =
      getNewsProtection(pair);

    /*
    ================================================
    1H
    ================================================
    */

    const hourly =
      await getHourlyData(
        pair
      );

    /*
    ================================================
    12H
    ================================================
    */

    const h12 =
      aggregate12HCandles(
        hourly
      );

    /*
    ================================================
    1H
    ================================================
    */

    const h1 =
      hourly.slice(-300);

    /*
    ================================================
    5M
    ================================================
    */

    await sleep(
      API_DELAY_MS
    );

    const m5 =
      await twelveData(
        pair,
        "5min",
        200
      );

    state.api.requestsThisScan++;

    console.log(
      `[${pair}] Candles: 12H=${h12.length} 1H=${h1.length} 5M=${m5.length}`
    );

    if (
      h12.length < 21
    ) {
      throw new Error(
        `Not enough 12H candles (${h12.length}/21)`
      );
    }

    if (
      h1.length < 20
    ) {
      throw new Error(
        `Not enough 1H candles (${h1.length}/20)`
      );
    }

    if (
      m5.length < 20
    ) {
      throw new Error(
        `Not enough 5M candles (${m5.length}/20)`
      );
    }

    /*
    ================================================
    ANALYSIS
    ================================================
    */

    const signal =
      analyzePair(
        pair,
        h12,
        h1,
        m5,
        newsProtection
      );

    const oldStatus =
      result.status;

    /*
    ================================================
    LOG NEWS STATUS
    ================================================
    */

    if (
      newsProtection.active
    ) {
      console.log(
        `[${pair}] NEWS ${newsProtection.phase}: ${newsProtection.message}`
      );
    }

    /*
    ================================================
    NEW BUY
    ================================================
    */

    if (
      signal.status === "BUY" &&
      oldStatus !== "BUY"
    ) {
      state.performance.totalSignals++;

      state.performance.buys++;

      await sendTelegramSignal(
        signal
      );
    }

    /*
    ================================================
    NEW SELL
    ================================================
    */

    if (
      signal.status === "SELL" &&
      oldStatus !== "SELL"
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

    /*
    LOG
    */

    console.log(
      `[${pair}] ${signal.status} ${signal.score}/5`
    );

    console.log(
      `[${pair}] 12H=${signal.timeframes.h12.trend} | 1H=${signal.timeframes.h1.trend} | 5M=${signal.timeframes.m5.trend}`
    );

    console.log(
      `[${pair}] Price=${signal.price} Entry=${signal.entry} SL=${signal.stopLoss} TP=${signal.takeProfit}`
    );

    console.log(
      `[${pair}] FVG=${signal.analysis.fvg} | Liquidity=${signal.analysis.liquidity} | NewsConfirmed=${signal.analysis.newsConfirmed}`
    );

  } catch (error) {
    console.error(
      `[${pair}] ERROR:`,
      error.message
    );

    if (
      error.message.includes(
        "429"
      )
    ) {
      state.api.cooldownUntil =
        Date.now() +
        RATE_LIMIT_COOLDOWN_MS;
    }

    /*
    IMPORTANT:

    News API errors do not reach this point
    unless the actual trading data scan fails.

    Biquote failures are handled separately
    and fail open.
    */

    result.status =
      "OFFLINE";

    result.score = 0;

    result.message =
      error.message;

    result.updated =
      new Date().toISOString();

    result.price = null;

    result.entry = null;

    result.stopLoss = null;

    result.takeProfit = null;

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

        rsi:
          null
      },

      m5: {
        trend:
          "UNKNOWN",

        rsi:
          null
      }
    };

    result.newsProtection = {
      active: false,
      phase: "UNKNOWN",
      event: null,
      message: "News protection unavailable."
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

      fvg:
        "—",

      retracement:
        false,

      newsConfirmed:
        false
    };

    state.api.lastError =
      `${pair}: ${error.message}`;
  }
}

/*
=========================================================
SCAN ALL PAIRS
=========================================================
*/

let scanRunning = false;

async function scanAll() {
  if (scanRunning) {
    console.log(
      "[SCAN] Previous scan still running. Skipping."
    );

    return;
  }

  scanRunning = true;

  state.api.requestsThisScan =
    0;

  state.api.lastError =
    null;

  const marketOpen =
    isMarketOpen();

  state.online = true;

  console.log(
    "============================================"
  );

  console.log(
    `[SCAN] ${new Date().toISOString()}`
  );

  console.log(
    `[SCAN] Market: ${
      marketOpen
        ? "OPEN"
        : "CLOSED"
    }`
  );

  console.log(
    `[SCAN] Pairs: ${PAIRS.join(", ")}`
  );

  /*
  ================================================
  NEWS
  ================================================
  */

  if (marketOpen) {
    await refreshNewsCalendar();
  }

  /*
  ================================================
  MARKET CLOSED
  ================================================
  */

  if (!marketOpen) {
    for (
      const pair of PAIRS
    ) {
      setMarketClosed(pair);
    }

    state.lastScan =
      new Date().toISOString();

    scanRunning = false;

    return;
  }

  /*
  ================================================
  SCAN ONE AT A TIME
  ================================================
  */

  try {
    for (
      const pair of PAIRS
    ) {
      await scanPair(pair);

      await sleep(
        API_DELAY_MS
      );

      if (
        state.api.cooldownUntil &&
        Date.now() <
          state.api.cooldownUntil
      ) {
        console.log(
          "[SCAN] API cooldown active. Stopping scan."
        );

        break;
      }
    }

    state.lastScan =
      new Date().toISOString();

    console.log(
      `[SCAN COMPLETE] Requests this scan: ${state.api.requestsThisScan}`
    );

    console.log(
      `[TOTAL API REQUESTS] ${state.api.totalRequests}`
    );

  } finally {
    scanRunning = false;
  }

  console.log(
    "============================================"
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

    let cooldownSeconds = 0;

    if (
      state.api.cooldownUntil &&
      state.api.cooldownUntil >
        Date.now()
    ) {
      cooldownSeconds =
        Math.ceil(
          (
            state.api.cooldownUntil -
            Date.now()
          ) / 1000
        );
    }

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

      confirmation:
        "12H + 1H + 5M",

      pairs:
        state.pairs,

      performance:
        state.performance,

      newsProtection:
        state.newsProtection,

      api: {
        ...state.api,

        cooldownSeconds
      }
    });
  }
);

/*
=========================================================
ALERT STATUS
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

/*
=========================================================
TURN ALERTS ON/OFF
=========================================================
*/

app.post(
  "/api/alerts",
  (req, res) => {
    alertsEnabled =
      Boolean(
        req.body.enabled
      );

    console.log(
      `[TELEGRAM ALERTS] ${
        alertsEnabled
          ? "ON"
          : "OFF"
      }`
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
MANUAL SCAN
=========================================================
*/

app.post(
  "/api/scan",
  async (req, res) => {
    try {
      await scanAll();

      res.json({
        ok: true,

        message:
          "Scan completed",

        lastScan:
          state.lastScan
      });

    } catch (error) {
      res.status(500).json({
        ok: false,

        error:
          error.message
      });
    }
  }
);

/*
=========================================================
NEWS STATUS API
=========================================================
*/

app.get(
  "/api/news",
  (req, res) => {
    const pair =
      req.query.pair;

    if (
      pair &&
      PAIRS.includes(pair)
    ) {
      res.json({
        ok: true,

        pair,

        protection:
          getNewsProtection(pair),

        calendar:
          state.newsProtection
      });

      return;
    }

    res.json({
      ok: true,

      calendar:
        state.newsProtection
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

      online:
        state.online,

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

      pairCount:
        PAIRS.length,

      smc:
        true,

      rsi:
        true,

      breakout:
        true,

      rejection:
        true,

      fvg:
        true,

      retracement:
        true,

      extensionProtection:
        true,

      newsProtection:
        true,

      newsSource:
        "Biquote",

      newsBeforeMinutes:
        NEWS_BEFORE_MINUTES,

      newsAfterMinutes:
        NEWS_AFTER_MINUTES,

      newsSettlementMinutes:
        NEWS_SETTLE_MINUTES,

      h1Cache:
        true,

      h1CacheMinutes:
        60,

      riskReward:
        "1:2",

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
      "============================================"
    );

    console.log(
      "TRADING CLOUD MONITOR"
    );

    console.log(
      "============================================"
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
      "============================================"
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
      "============================================"
    );

    console.log(
      "ENGINE: 12H + 1H + 5M"
    );

    console.log(
      "12H: BUILT FROM 1H"
    );

    console.log(
      "12H: CLOSED-CANDLE BIAS"
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
      "FVG: ENABLED"
    );

    console.log(
      "RETRACEMENT: ENABLED"
    );

    console.log(
      "EXTENSION PROTECTION: ENABLED"
    );

    console.log(
      "NEWS PROTECTION: ENABLED"
    );

    console.log(
      `NEWS BEFORE: ${NEWS_BEFORE_MINUTES} MIN`
    );

    console.log(
      `NEWS AFTER: ${NEWS_AFTER_MINUTES} MIN`
    );

    console.log(
      `NEWS SETTLEMENT: ${NEWS_SETTLE_MINUTES} MIN`
    );

    console.log(
      "RISK/REWARD: 1:2"
    );

    console.log(
      "============================================"
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
      "============================================"
    );

    /*
    Initial scan.
    */

    try {
      await scanAll();
    } catch (error) {
      console.error(
        "Initial scan error:",
        error.message
      );
    }

    /*
    Continue every 5 minutes.
    */

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
