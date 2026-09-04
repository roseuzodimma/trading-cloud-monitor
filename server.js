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

PAIRS:
  XAU/USD
  GBP/JPY

ENGINE:
  12H BIAS
      ↓
  1H CONFIRMATION
      ↓
  5M ENTRY
      ↓
  SMC / FVG / RETRACEMENT
      ↓
  BUY / SELL → TELEGRAM

NORMAL STRATEGY:
  - 12H + 1H + 5M confirmation
  - Minimum 4/5 score
  - SMC confirmation
  - Extension protection
  - 1:2 Risk/Reward

HIGH-IMPACT NEWS:
  BEFORE NEWS
      ↓
  WAIT

  IMMEDIATELY AFTER NEWS
      ↓
  WAIT

  MARKET SETTLES
      ↓
  5M LIQUIDITY SWEEP
      ↓
  BOS / CHoCH
      ↓
  RETRACEMENT OR FVG
      ↓
  ENTRY

IMPORTANT:
  News protection only affects the market around
  high-impact events. Normal strategy remains unchanged.
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
*/

const NEWS_BEFORE_MINUTES = 15;
const NEWS_AFTER_MINUTES = 15;
const NEWS_SETTLE_MINUTES = 15;

const NEWS_REFRESH_MS = 5 * 60 * 1000;

const NEWS_CALENDAR_URL =
  "https://biquote.io/api/calendar";

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
PAIR CONFIG
=========================================================
*/

const PAIR_CONFIG = {
  "XAU/USD": {
    decimals: 2,
    atrMultiplier: 2.5,
    slAtrFactor: 1.2,
    label: "XAU/USD",
    emoji: "🥇"
  },

  "GBP/JPY": {
    decimals: 3,
    atrMultiplier: 2.5,
    slAtrFactor: 1.2,
    label: "GBP/JPY",
    emoji: "🇬🇧🇯🇵"
  }
};

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
    status: API_KEY ? "CONFIGURED" : "MISSING_API_KEY",
    totalRequests: 0,
    requestsThisScan: 0,
    lastError: null,
    cooldownUntil: null
  },

  newsProtection: {
    enabled: true,
    source: "Biquote Economic Calendar",
    lastRefresh: null,
    status: "STARTING",
    events: [],
    error: null
  }
};

/*
=========================================================
ALERT SETTINGS
=========================================================
*/

let alertsEnabled = true;

/*
=========================================================
SCAN CONTROL
=========================================================
*/

let scanRunning = false;

/*
=========================================================
SIGNAL STATE
=========================================================
*/

const lastSignalTime = {};

for (const pair of PAIRS) {
  lastSignalTime[pair] = null;
}

/*
=========================================================
1H CACHE
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

    label: PAIR_CONFIG[pair].label,

    emoji: PAIR_CONFIG[pair].emoji,

    status: "WAIT",

    score: 0,

    message: "Waiting for first scan...",

    price: null,

    entry: null,

    stopLoss: null,

    takeProfit: null,

    riskReward: null,

    updated: null,

    newsProtection: {
      active: false,
      phase: "CLEAR",
      event: null,
      message: "No active high-impact news protection"
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

      location: "—",

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
HELPERS
=========================================================
*/

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function num(value) {
  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}

function average(values) {
  const clean = values.filter(Number.isFinite);

  if (!clean.length) return null;

  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

function roundPrice(value, pair) {
  if (!Number.isFinite(value)) return null;

  const decimals =
    PAIR_CONFIG[pair]?.decimals ?? 5;

  return Number(value.toFixed(decimals));
}

/*
=========================================================
MARKET HOURS
=========================================================
*/

function isMarketOpen() {
  const now = new Date();

  const day = now.getUTCDay();

  const minutes =
    now.getUTCHours() * 60 +
    now.getUTCMinutes();

  // Saturday
  if (day === 6) return false;

  // Sunday before 22:00 UTC
  if (day === 0 && minutes < 22 * 60) {
    return false;
  }

  // Friday after 22:00 UTC
  if (day === 5 && minutes >= 22 * 60) {
    return false;
  }

  return true;
}

/*
=========================================================
NEWS HELPERS
=========================================================
*/

function normalizeNewsText(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function parseNewsDate(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isFinite(value.getTime())
      ? value
      : null;
  }

  const text = String(value).trim();

  let date = new Date(text);

  if (Number.isFinite(date.getTime())) {
    return date;
  }

  date = new Date(text.replace(" ", "T"));

  if (Number.isFinite(date.getTime())) {
    return date;
  }

  return null;
}

function getNewsEventDate(event) {
  return (
    parseNewsDate(event.datetime) ||
    parseNewsDate(event.date) ||
    parseNewsDate(event.time) ||
    parseNewsDate(event.timestamp)
  );
}

function getNewsImportance(event) {
  return normalizeNewsText(
    event.importance ||
    event.impact ||
    event.priority ||
    ""
  ).toLowerCase();
}

function getNewsCountry(event) {
  return normalizeNewsText(
    event.country ||
    event.country_code ||
    event.currency ||
    event.currency_code ||
    ""
  ).toUpperCase();
}

function getNewsTitle(event) {
  return normalizeNewsText(
    event.title ||
    event.name ||
    event.event ||
    event.description ||
    "High-impact economic event"
  );
}

function isHighImpactEvent(event) {
  const importance = getNewsImportance(event);

  return (
    importance === "high" ||
    importance === "3" ||
    importance === "high impact" ||
    importance === "red"
  );
}

function getNewsCountriesForPair(pair) {
  if (pair === "GBP/JPY") {
    return ["GB", "JP", "GBP", "JPY"];
  }

  if (pair === "XAU/USD") {
    return ["US", "USD"];
  }

  return [];
}

function newsEventAffectsPair(event, pair) {
  const allowed =
    getNewsCountriesForPair(pair);

  const country = getNewsCountry(event);

  return allowed.includes(country);
}

/*
=========================================================
REFRESH NEWS CALENDAR
=========================================================
*/

async function refreshNewsCalendar() {
  if (!state.newsProtection.enabled) {
    return;
  }

  const now = Date.now();

  if (
    state.newsProtection.lastRefresh &&
    now - state.newsProtection.lastRefresh <
      NEWS_REFRESH_MS
  ) {
    return;
  }

  try {
    const from = new Date(
      now - 24 * 60 * 60 * 1000
    ).toISOString();

    const to = new Date(
      now + 48 * 60 * 60 * 1000
    ).toISOString();

    const url =
      `${NEWS_CALENDAR_URL}` +
      `?from=${encodeURIComponent(from)}` +
      `&to=${encodeURIComponent(to)}` +
      `&countries=GB,JP,US` +
      `&importance=high` +
      `&type=event` +
      `&limit=100` +
      `&timeMode=exact`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Biquote HTTP ${response.status}`
      );
    }

    const data = await response.json();

    let events = [];

    if (Array.isArray(data)) {
      events = data;
    } else if (Array.isArray(data?.data)) {
      events = data.data;
    } else if (Array.isArray(data?.events)) {
      events = data.events;
    } else if (Array.isArray(data?.results)) {
      events = data.results;
    }

    const normalized = events
      .map(event => {
        const datetime =
          getNewsEventDate(event);

        return {
          datetime: datetime
            ? datetime.toISOString()
            : null,

          timestamp: datetime
            ? datetime.getTime()
            : null,

          country: getNewsCountry(event),

          importance: getNewsImportance(event),

          title: getNewsTitle(event)
        };
      })
      .filter(event => {
        return (
          event.timestamp !== null &&
          isHighImpactEvent(event)
        );
      })
      .sort(
        (a, b) =>
          a.timestamp - b.timestamp
      );

    state.newsProtection.events =
      normalized;

    state.newsProtection.lastRefresh =
      now;

    state.newsProtection.status = "READY";

    state.newsProtection.error = null;

    console.log(
      `[NEWS] Calendar refreshed — ${normalized.length} high-impact events`
    );
  } catch (err) {
    state.newsProtection.error =
      err.message;

    console.error(
      "[NEWS] Calendar error:",
      err.message
    );

    /*
      FAIL OPEN:
      Keep cached news events and continue
      normal trading if Biquote temporarily fails.
    */

    if (
      state.newsProtection.events.length
    ) {
      state.newsProtection.status =
        "USING_CACHE";
    } else {
      state.newsProtection.status =
        "UNAVAILABLE";
    }
  }
}

/*
=========================================================
GET NEWS PROTECTION FOR PAIR
=========================================================
*/

function getNewsProtection(pair) {
  const now = Date.now();

  const relevantEvents =
    state.newsProtection.events
      .filter(event =>
        newsEventAffectsPair(event, pair)
      );

  if (!relevantEvents.length) {
    return {
      active: false,
      phase: "CLEAR",
      event: null,
      message:
        "No active high-impact news protection"
    };
  }

  /*
    First check events that are currently
    inside a protection window.
  */

  let activeEvent = null;
  let activePhase = "CLEAR";

  for (const event of relevantEvents) {
    const eventTime = event.timestamp;

    const beforeStart =
      eventTime -
      NEWS_BEFORE_MINUTES * 60 * 1000;

    const afterEnd =
      eventTime +
      (
        NEWS_AFTER_MINUTES +
        NEWS_SETTLE_MINUTES
      ) * 60 * 1000;

    if (
      now >= beforeStart &&
      now <= afterEnd
    ) {
      activeEvent = event;

      if (now < eventTime) {
        activePhase = "BEFORE_NEWS";
      } else if (
        now <=
        eventTime +
        NEWS_AFTER_MINUTES * 60 * 1000
      ) {
        activePhase = "AFTER_NEWS";
      } else {
        activePhase = "SETTLING";
      }

      break;
    }
  }

  if (!activeEvent) {
    return {
      active: false,
      phase: "CLEAR",
      event: null,
      message:
        "No active high-impact news protection"
    };
  }

  let message =
    "High-impact news protection active";

  if (activePhase === "BEFORE_NEWS") {
    message =
      "WAIT — high-impact news approaching";
  }

  if (activePhase === "AFTER_NEWS") {
    message =
      "WAIT — immediate post-news volatility";
  }

  if (activePhase === "SETTLING") {
    message =
      "WAIT — market settling after news";
  }

  return {
    active: true,
    phase: activePhase,

    event: {
      title: activeEvent.title,
      country: activeEvent.country,
      importance: activeEvent.importance,
      datetime: activeEvent.datetime
    },

    message
  };
}

/*
=========================================================
FVG
=========================================================
*/

function detectFVG(candles) {
  if (!candles || candles.length < 3) {
    return {
      type: "NONE",
      bullish: false,
      bearish: false
    };
  }

  const a = candles[candles.length - 3];
  const b = candles[candles.length - 2];
  const c = candles[candles.length - 1];

  /*
    Bullish FVG:
    current low > candle 1 high
  */

  if (c.low > a.high) {
    return {
      type: "BULLISH",
      bullish: true,
      bearish: false,
      high: c.low,
      low: a.high
    };
  }

  /*
    Bearish FVG:
    current high < candle 1 low
  */

  if (c.high < a.low) {
    return {
      type: "BEARISH",
      bullish: false,
      bearish: true,
      high: a.low,
      low: c.high
    };
  }

  return {
    type: "NONE",
    bullish: false,
    bearish: false
  };
}

/*
=========================================================
RECENT FVG
=========================================================
*/

function findRecentFVG(candles, direction) {
  if (!candles || candles.length < 3) {
    return null;
  }

  for (
    let i = candles.length - 1;
    i >= 2;
    i--
  ) {
    const a = candles[i - 2];
    const c = candles[i];

    if (
      direction === "BUY" &&
      c.low > a.high
    ) {
      return {
        type: "BULLISH",
        index: i
      };
    }

    if (
      direction === "SELL" &&
      c.high < a.low
    ) {
      return {
        type: "BEARISH",
        index: i
      };
    }
  }

  return null;
}

/*
=========================================================
RETRACEMENT
=========================================================
*/

function detectRetracement(
  candles,
  direction
) {
  if (!candles || candles.length < 8) {
    return false;
  }

  const recent = candles.slice(-8);

  const firstHalf =
    recent.slice(0, 4);

  const secondHalf =
    recent.slice(4);

  const firstHigh = Math.max(
    ...firstHalf.map(c => c.high)
  );

  const firstLow = Math.min(
    ...firstHalf.map(c => c.low)
  );

  const secondHigh = Math.max(
    ...secondHalf.map(c => c.high)
  );

  const secondLow = Math.min(
    ...secondHalf.map(c => c.low)
  );

  const current =
    recent[recent.length - 1];

  if (direction === "BUY") {
    return (
      secondHigh > firstHigh &&
      current.close < secondHigh &&
      current.close > firstLow
    );
  }

  if (direction === "SELL") {
    return (
      secondLow < firstLow &&
      current.close > secondLow &&
      current.close < firstHigh
    );
  }

  return false;
}

/*
=========================================================
SMC NEWS SETUP CONFIRMATION
=========================================================
*/

function getNewsSetupConfirmation(
  m5,
  direction
) {
  const structure =
    getStructure(m5);

  const fvg =
    findRecentFVG(m5, direction);

  const retracement =
    detectRetracement(
      m5,
      direction
    );

  const liquiditySweep =
    direction === "BUY"
      ? structure.liquidity ===
        "SELL-SIDE SWEPT"
      : structure.liquidity ===
        "BUY-SIDE SWEPT";

  const bosOrChoch =
    direction === "BUY"
      ? (
          structure.bos === "BULLISH" ||
          structure.choch === "BULLISH"
        )
      : (
          structure.bos === "BEARISH" ||
          structure.choch === "BEARISH"
        );

  /*
    FVG OR retracement is enough.
    This keeps news confirmation from becoming
    unnecessarily strict.
  */

  const retracementOrFVG =
    retracement || Boolean(fvg);

  return {
    liquiditySweep,
    bos: direction === "BUY"
      ? structure.bos === "BULLISH"
      : structure.bos === "BEARISH",

    choch: direction === "BUY"
      ? structure.choch === "BULLISH"
      : structure.choch === "BEARISH",

    fvg: Boolean(fvg),

    retracement,

    confirmed:
      liquiditySweep &&
      bosOrChoch &&
      retracementOrFVG
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
    throw new Error(
      "API cooldown active — rate limit hit recently"
    );
  }

  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${outputsize}` +
    `&timezone=UTC` +
    `&apikey=${encodeURIComponent(API_KEY)}`;

  state.api.totalRequests++;

  const response = await fetch(url);

  const data =
    await response.json().catch(
      () => null
    );

  if (response.status === 429) {
    state.api.cooldownUntil =
      Date.now() +
      RATE_LIMIT_COOLDOWN_MS;

    throw new Error(
      "Rate limit hit — cooling down 60s"
    );
  }

  if (!response.ok) {
    throw new Error(
      `Twelve Data HTTP ${response.status}`
    );
  }

  if (data?.status === "error") {
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
    .map(c => ({
      datetime: new Date(
        c.datetime + " UTC"
      ),

      open: num(c.open),
      high: num(c.high),
      low: num(c.low),
      close: num(c.close),
      volume: num(c.volume)
    }))
    .filter(c =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    )
    .sort(
      (a, b) =>
        a.datetime.getTime() -
        b.datetime.getTime()
    );
}

/*
=========================================================
COMPLETED CANDLES
=========================================================
*/

function getClosedCandles(
  candles,
  minutes
) {
  if (!candles?.length) {
    return [];
  }

  const now = Date.now();

  return candles.filter(
    candle =>
      candle.datetime.getTime() +
      minutes * 60000 <= now
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

  const closed1H =
    getClosedCandles(
      hourlyCandles,
      60
    );

  const groups = new Map();

  for (const candle of closed1H) {
    const d = candle.datetime;

    const half =
      d.getUTCHours() < 12
        ? 0
        : 12;

    const key =
      `${d.getUTCFullYear()}-` +
      `${d.getUTCMonth()}-` +
      `${d.getUTCDate()}-` +
      `${half}`;

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups
      .get(key)
      .push(candle);
  }

  const result = [];

  for (const candles of groups.values()) {
    candles.sort(
      (a, b) =>
        a.datetime.getTime() -
        b.datetime.getTime()
    );

    /*
      A complete 12H candle needs
      exactly 12 hourly candles.
    */

    if (candles.length !== 12) {
      continue;
    }

    const first = candles[0];

    const last =
      candles[candles.length - 1];

    result.push({
      datetime: first.datetime,

      open: first.open,

      high: Math.max(
        ...candles.map(c => c.high)
      ),

      low: Math.min(
        ...candles.map(c => c.low)
      ),

      close: last.close,

      volume: candles.reduce(
        (sum, c) =>
          sum + (c.volume || 0),
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
    candles.length < period + 1
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
      losses += Math.abs(change);
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

    avgGain =
      (
        avgGain * (period - 1) +
        Math.max(change, 0)
      ) / period;

    avgLoss =
      (
        avgLoss * (period - 1) +
        Math.max(-change, 0)
      ) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  return (
    100 -
    100 /
      (
        1 +
        avgGain / avgLoss
      )
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
        .map(c => c.close)
    );

  const slow =
    average(
      recent.map(c => c.close)
    );

  const first =
    recent[0].close;

  const last =
    recent[recent.length - 1]
      .close;

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
12H TREND
=========================================================
*/

function get12HTrend(candles) {
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
        .map(c => c.close)
    );

  const slow =
    average(
      recent.map(c => c.close)
    );

  const previous =
    candles[candles.length - 2];

  const current =
    candles[candles.length - 1];

  const bullish =
    current.close > previous.close &&
    current.high >= previous.high;

  const bearish =
    current.close < previous.close &&
    current.low <= previous.low;

  if (
    fast > slow &&
    current.close > fast &&
    bullish
  ) {
    return "BULLISH";
  }

  if (
    fast < slow &&
    current.close < fast &&
    bearish
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

function isSwingHigh(
  candles,
  i
) {
  if (
    i < 2 ||
    i >= candles.length - 2
  ) {
    return false;
  }

  return (
    candles[i].high >
      candles[i - 1].high &&
    candles[i].high >
      candles[i - 2].high &&
    candles[i].high >
      candles[i + 1].high &&
    candles[i].high >
      candles[i + 2].high
  );
}

function isSwingLow(
  candles,
  i
) {
  if (
    i < 2 ||
    i >= candles.length - 2
  ) {
    return false;
  }

  return (
    candles[i].low <
      candles[i - 1].low &&
    candles[i].low <
      candles[i - 2].low &&
    candles[i].low <
      candles[i + 1].low &&
    candles[i].low <
      candles[i + 2].low
  );
}

/*
=========================================================
SMC STRUCTURE
=========================================================
*/

function getStructure(candles) {
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
      isSwingHigh(candles, i)
    ) {
      highs.push(candles[i]);
    }

    if (
      isSwingLow(candles, i)
    ) {
      lows.push(candles[i]);
    }
  }

  const last =
    candles[candles.length - 1];

  const prev =
    candles[candles.length - 2];

  const prevHigh =
    highs.length
      ? highs[highs.length - 1].high
      : null;

  const prevLow =
    lows.length
      ? lows[lows.length - 1].low
      : null;

  let structure = "RANGE";

  let bos = "—";

  let choch = "—";

  let liquidity = "—";

  /*
    BOS
  */

  if (
    prevHigh !== null &&
    last.close > prevHigh
  ) {
    structure = "BULLISH";
    bos = "BULLISH";
  }

  if (
    prevLow !== null &&
    last.close < prevLow
  ) {
    structure = "BEARISH";
    bos = "BEARISH";
  }

  /*
    CHoCH
  */

  if (
    prevHigh !== null &&
    prev.close <= prevHigh &&
    last.close > prevHigh
  ) {
    choch = "BULLISH";
  }

  if (
    prevLow !== null &&
    prev.close >= prevLow &&
    last.close < prevLow
  ) {
    choch = "BEARISH";
  }

  /*
    Liquidity sweep
  */

  if (
    prevHigh !== null &&
    last.high > prevHigh &&
    last.close < prevHigh
  ) {
    liquidity =
      "BUY-SIDE SWEPT";
  }

  if (
    prevLow !== null &&
    last.low < prevLow &&
    last.close > prevLow
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

function rejectionSignal(candle) {
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
      candle.close > candle.open,

    bearish:
      upperWick > minimum &&
      candle.close < candle.open
  };
}

/*
=========================================================
BREAKOUT
=========================================================
*/

function breakoutSignal(candles) {
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
    candles[candles.length - 1];

  const previous =
    candles.slice(-6, -1);

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
      current.close > highest,

    bearish:
      current.close < lowest
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
    candles.length < period + 1
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

  return average(
    trs.slice(-period)
  );
}

/*
=========================================================
12H ANALYSIS
=========================================================
*/

function get12HAnalysis(candles) {
  if (
    !candles ||
    candles.length < 20
  ) {
    return {
      bias: "UNKNOWN",
      trend: "UNKNOWN",
      rsi: null,
      previous: "UNKNOWN",
      current: "UNKNOWN",
      previousCandle: null,
      currentCandle: null
    };
  }

  const current =
    candles[candles.length - 1];

  const previous =
    candles[candles.length - 2];

  const trend =
    get12HTrend(candles);

  const rsi =
    calculateRSI(candles);

  let bias = "NEUTRAL";

  if (
    trend === "BULLISH" &&
    current.close >
      current.open &&
    current.close >
      previous.close
  ) {
    bias = "BULLISH";
  }

  if (
    trend === "BEARISH" &&
    current.close <
      current.open &&
    current.close <
      previous.close
  ) {
    bias = "BEARISH";
  }

  return {
    bias,

    trend,

    rsi:
      rsi !== null
        ? Number(rsi.toFixed(1))
        : null,

    previous:
      getTrend(
        candles.slice(0, -1)
      ),

    current:
      getTrend(candles),

    previousCandle: previous,

    currentCandle: current
  };
}

/*
=========================================================
MAIN ANALYSIS ENGINE
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
    !h12?.length ||
    !h1?.length ||
    !m5?.length
  ) {
    throw new Error(
      "Insufficient candle data"
    );
  }

  const closedM5 =
    getClosedCandles(
      m5,
      5
    );

  const closedH1 =
    getClosedCandles(
      h1,
      60
    );

  if (closedM5.length < 30) {
    throw new Error(
      "Not enough completed 5M candles"
    );
  }

  if (closedH1.length < 30) {
    throw new Error(
      "Not enough completed 1H candles"
    );
  }

  const config =
    PAIR_CONFIG[pair];

  const latest =
    closedM5[
      closedM5.length - 1
    ];

  const price =
    latest.close;

  /*
  -------------------------------------------------------
  TIMEFRAMES
  -------------------------------------------------------
  */

  const h12Analysis =
    get12HAnalysis(h12);

  const h1Trend =
    getTrend(closedH1);

  const h1RSI =
    calculateRSI(closedH1);

  const m5Trend =
    getTrend(closedM5);

  const m5RSI =
    calculateRSI(closedM5);

  /*
  -------------------------------------------------------
  SMC
  -------------------------------------------------------
  */

  const h12Structure =
    getStructure(h12);

  const h1Structure =
    getStructure(closedH1);

  const m5Structure =
    getStructure(closedM5);

  const rejection =
    rejectionSignal(latest);

  const breakout =
    breakoutSignal(closedM5);

  const currentFVG =
    detectFVG(closedM5);

  /*
  -------------------------------------------------------
  SCORING
  -------------------------------------------------------

  IMPORTANT:
  This remains the same normal strategy.

  12H = 2 points
  1H  = 1 point
  5M  = 1 point
  RSI = 1 point
  SMC = extra confirmation

  Maximum = 5
  -------------------------------------------------------
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
    buyScore += 2;
  }

  if (
    h12Analysis.bias ===
    "BEARISH"
  ) {
    sellScore += 2;
  }

  /*
    1H
  */

  if (
    h1Trend === "BULLISH"
  ) {
    buyScore++;
  }

  if (
    h1Trend === "BEARISH"
  ) {
    sellScore++;
  }

  /*
    5M
  */

  if (
    m5Trend === "BULLISH"
  ) {
    buyScore++;
  }

  if (
    m5Trend === "BEARISH"
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
    m5RSI <= 50 &&
    m5RSI >= 32
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

  /*
    CHoCH extra weight
  */

  if (
    m5Structure.choch ===
    "BULLISH"
  ) {
    buyScore++;
  }

  if (
    m5Structure.choch ===
    "BEARISH"
  ) {
    sellScore++;
  }

  if (bullishSMC) {
    buyScore++;
  }

  if (bearishSMC) {
    sellScore++;
  }

  /*
    Maximum 5
  */

  buyScore =
    Math.min(5, buyScore);

  sellScore =
    Math.min(5, sellScore);

  let status = "WAIT";

  let score =
    Math.max(
      buyScore,
      sellScore
    );

  /*
  -------------------------------------------------------
  NORMAL BUY
  -------------------------------------------------------
  */

  if (
    buyScore >= 4 &&
    h12Analysis.bias ===
      "BULLISH" &&
    h1Trend === "BULLISH" &&
    (
      bullishSMC ||
      m5Trend === "BULLISH"
    )
  ) {
    status = "BUY";
  }

  /*
  -------------------------------------------------------
  NORMAL SELL
  -------------------------------------------------------
  */

  if (
    sellScore >= 4 &&
    h12Analysis.bias ===
      "BEARISH" &&
    h1Trend === "BEARISH" &&
    (
      bearishSMC ||
      m5Trend === "BEARISH"
    )
  ) {
    status = "SELL";
  }

  /*
  -------------------------------------------------------
  ENTRY / SL / TP
  -------------------------------------------------------

  DECLARED BEFORE NEWS PROTECTION.

  This fixes the JavaScript temporal-dead-zone
  error that was causing the previous crash.
  -------------------------------------------------------
  */

  let entry = null;

  let stopLoss = null;

  let takeProfit = null;

  let riskReward = null;

  /*
  -------------------------------------------------------
  NEWS PROTECTION
  -------------------------------------------------------
  */

  let newsConfirmed = false;

  let newsSetup = null;

  const news =
    newsProtection || {
      active: false,
      phase: "CLEAR",
      event: null,
      message:
        "No active high-impact news protection"
    };

  /*
    BEFORE NEWS:
    WAIT
  */

  if (
    news.phase ===
    "BEFORE_NEWS"
  ) {
    status = "WAIT";
  }

  /*
    IMMEDIATELY AFTER NEWS:
    WAIT
  */

  if (
    news.phase ===
    "AFTER_NEWS"
  ) {
    status = "WAIT";
  }

  /*
    SETTLING:
    WAIT

    We do NOT force an entry here.
  */

  if (
    news.phase ===
    "SETTLING"
  ) {
    status = "WAIT";
  }

  /*
  -------------------------------------------------------
  AFTER NEWS HAS SETTLED
  -------------------------------------------------------

  If the market is clear, normal strategy works.

  The special liquidity/BOS/FVG/retracement confirmation
  is only used while the news event is still within the
  protection cycle.
  -------------------------------------------------------
  */

  if (
    news.phase ===
    "CLEAR"
  ) {
    newsConfirmed = false;
  }

  /*
  -------------------------------------------------------
  EXTENSION PROTECTION
  -------------------------------------------------------
  */

  const atr =
    calculateATR(closedM5);

  let extended = false;

  if (atr !== null) {
    const ref =
      closedM5[
        Math.max(
          0,
          closedM5.length - 6
        )
      ];

    const distance =
      Math.abs(
        price - ref.open
      );

    if (
      distance >
      atr *
      config.atrMultiplier
    ) {
      extended = true;

      status = "WAIT";
    }
  }

  /*
  -------------------------------------------------------
  ENTRY / SL / TP
  -------------------------------------------------------
  */

  if (
    status === "BUY" &&
    atr !== null
  ) {
    entry = price;

    stopLoss =
      Math.min(
        latest.low,
        price -
          atr *
          config.slAtrFactor
      );

    const risk =
      entry - stopLoss;

    if (risk > 0) {
      takeProfit =
        entry + risk * 2;

      riskReward = "1:2";
    }
  }

  if (
    status === "SELL" &&
    atr !== null
  ) {
    entry = price;

    stopLoss =
      Math.max(
        latest.high,
        price +
          atr *
          config.slAtrFactor
      );

    const risk =
      stopLoss - entry;

    if (risk > 0) {
      takeProfit =
        entry - risk * 2;

      riskReward = "1:2";
    }
  }

  /*
  -------------------------------------------------------
  LOCATION
  -------------------------------------------------------
  */

  let location = "NEUTRAL";

  if (status === "BUY") {
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
      m5Structure.choch ===
      "BULLISH"
    ) {
      location =
        "CHoCH BULLISH";
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

  if (status === "SELL") {
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
      m5Structure.choch ===
      "BEARISH"
    ) {
      location =
        "CHoCH BEARISH";
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
  -------------------------------------------------------
  NEWS LOCATION / MESSAGE
  -------------------------------------------------------
  */

  if (
    news.phase ===
    "BEFORE_NEWS"
  ) {
    location =
      "WAIT — BEFORE NEWS";
  }

  if (
    news.phase ===
    "AFTER_NEWS"
  ) {
    location =
      "WAIT — AFTER NEWS";
  }

  if (
    news.phase ===
    "SETTLING"
  ) {
    location =
      "WAIT — MARKET SETTLING";
  }

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
      " | ✅ BUY CONFIRMATION";
  }

  if (
    status === "SELL"
  ) {
    message +=
      " | ✅ SELL CONFIRMATION";
  }

  if (extended) {
    message =
      "Move extended — waiting for pullback";
  }

  if (
    news.phase ===
    "BEFORE_NEWS"
  ) {
    message =
      "WAIT — high-impact news approaching";
  }

  if (
    news.phase ===
    "AFTER_NEWS"
  ) {
    message =
      "WAIT — immediate post-news volatility";
  }

  if (
    news.phase ===
    "SETTLING"
  ) {
    message =
      "WAIT — market settling. Looking for 5M liquidity sweep → BOS/CHoCH → retracement/FVG";
  }

  /*
  -------------------------------------------------------
  RETURN
  -------------------------------------------------------
  */

  return {
    symbol: pair,

    label: config.label,

    emoji: config.emoji,

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

    riskReward,

    updated:
      new Date().toISOString(),

    newsProtection: {
      active: Boolean(
        news.active
      ),

      phase:
        news.phase,

      event:
        news.event,

      message:
        news.message
    },

    timeframes: {
      h12: {
        trend:
          h12Analysis.bias,

        rsi:
          h12Analysis.rsi,

        previous:
          h12Analysis.previous,

        current:
          h12Analysis.current,

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
        trend: h1Trend,

        rsi:
          h1RSI !== null
            ? Number(
                h1RSI.toFixed(1)
              )
            : null
      },

      m5: {
        trend: m5Trend,

        rsi:
          m5RSI !== null
            ? Number(
                m5RSI.toFixed(1)
              )
            : null
      }
    },

    analysis: {
      direction: status,

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
        detectRetracement(
          closedM5,
          status === "BUY"
            ? "BUY"
            : "SELL"
        ),

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
      `[TELEGRAM] Skipped incomplete signal ${signal.symbol}`
    );

    return;
  }

  const dirEmoji =
    signal.status === "BUY"
      ? "🟢"
      : "🔴";

  const arrow =
    signal.status === "BUY"
      ? "⬆️"
      : "⬇️";

  const newsText =
    signal.newsProtection?.active
      ? `
⚠️ NEWS PROTECTION
   Phase: ${
     signal.newsProtection.phase
   }
   Event: ${
     signal.newsProtection.event?.title ||
     "—"
   }
   Confirmation: ${
     signal.analysis.newsConfirmed
       ? "CONFIRMED"
       : "WAIT"
   }`
      : "";

  const text =
`${dirEmoji} ${signal.status} SIGNAL — ${signal.emoji} ${signal.label}

${arrow} ${signal.status} @ ${signal.entry}

━━━━━━━━━━━━━━━━
📍 Entry:       ${signal.entry}
🛑 Stop Loss:   ${signal.stopLoss}
🎯 Take Profit: ${signal.takeProfit}
💰 Risk/Reward: ${signal.riskReward || "1:2"}
━━━━━━━━━━━━━━━━

⭐ Signal Score: ${signal.score}/5

📊 TIMEFRAME ALIGNMENT
   12H → ${signal.timeframes.h12.trend}
   1H  → ${signal.timeframes.h1.trend}
   5M  → ${signal.timeframes.m5.trend}

📈 SMC ANALYSIS
   Structure : ${signal.analysis.structure}
   BOS       : ${signal.analysis.bos}
   CHoCH     : ${signal.analysis.choch}
   Liquidity : ${signal.analysis.liquidity}
   FVG       : ${signal.analysis.fvg}
   Retrace   : ${signal.analysis.retracement ? "YES" : "NO"}
   Location  : ${signal.analysis.location}

🔢 RSI (5M): ${
  signal.timeframes.m5.rsi ?? "—"
}
${newsText}

━━━━━━━━━━━━━━━━
⚠️ ALERT ONLY — NOT A TRADE ORDER
Always verify your full checklist
on the chart before entering.
━━━━━━━━━━━━━━━━`;

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

          body: JSON.stringify({
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
    } else {
      console.log(
        `[TELEGRAM] Signal sent — ${signal.symbol} ${signal.status}`
      );
    }
  } catch (err) {
    console.error(
      "Telegram error:",
      err.message
    );
  }
}

/*
=========================================================
MARKET CLOSED
=========================================================
*/

function setMarketClosed(pair) {
  const r =
    state.pairs[pair];

  r.status = "WAIT";

  r.score = 0;

  r.message =
    "Market closed — resumes Sunday 22:00 UTC";

  r.price =
    r.entry =
    r.stopLoss =
    r.takeProfit =
      null;

  r.riskReward = null;

  r.updated =
    new Date().toISOString();

  r.newsProtection = {
    active: false,
    phase: "CLEAR",
    event: null,
    message: "Market closed"
  };

  r.timeframes = {
    h12: {
      trend: "MARKET CLOSED",
      rsi: null,
      previous: "UNKNOWN",
      current: "UNKNOWN",
      previousCandle: null
    },

    h1: {
      trend: "MARKET CLOSED",
      rsi: null
    },

    m5: {
      trend: "MARKET CLOSED",
      rsi: null
    }
  };

  r.analysis = {
    direction: "WAIT",

    h12SMC:
      "MARKET CLOSED",

    h1SMC:
      "MARKET CLOSED",

    breakout: false,

    rejection: false,

    location:
      "MARKET CLOSED",

    extended: false,

    structure: "—",

    bos: "—",

    choch: "—",

    liquidity: "—",

    fvg: "—",

    retracement: false,

    newsConfirmed: false
  };
}

/*
=========================================================
1H DATA CACHE
=========================================================
*/

async function getHourlyData(pair) {
  const cached =
    h1Cache[pair];

  const now =
    Date.now();

  if (
    cached.candles &&
    cached.updated &&
    now - cached.updated <
      H1_REFRESH_MS
  ) {
    console.log(
      `[${pair}] Using cached 1H data`
    );

    return cached.candles;
  }

  console.log(
    `[${pair}] Fetching fresh 1H data`
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
SIGNAL COOLDOWN
=========================================================
*/

function isSignalOnCooldown(pair) {
  const last =
    lastSignalTime[pair];

  if (!last) {
    return false;
  }

  return (
    Date.now() - last <
    4 * 60 * 60 * 1000
  );
}

function markSignalSent(pair) {
  lastSignalTime[pair] =
    Date.now();
}

/*
=========================================================
SCAN ONE PAIR
=========================================================
*/

async function scanPair(pair) {
  const result =
    state.pairs[pair];

  result.updated =
    new Date().toISOString();

  if (!isMarketOpen()) {
    setMarketClosed(pair);
    return;
  }

  try {
    /*
      News is refreshed by scanAll().
      We deliberately do NOT refresh it again here.
    */

    const newsProtection =
      getNewsProtection(pair);

    const hourly =
      await getHourlyData(pair);

    const h12 =
      aggregate12HCandles(
        hourly
      );

    const h1 =
      getClosedCandles(
        hourly,
        60
      ).slice(-300);

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

    if (h12.length < 20) {
      throw new Error(
        `Not enough 12H candles: ${h12.length}`
      );
    }

    if (h1.length < 30) {
      throw new Error(
        `Not enough 1H candles: ${h1.length}`
      );
    }

    if (m5.length < 30) {
      throw new Error(
        `Not enough 5M candles: ${m5.length}`
      );
    }

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

    const isNewBuy =
      signal.status === "BUY" &&
      oldStatus !== "BUY";

    const isNewSell =
      signal.status === "SELL" &&
      oldStatus !== "SELL";

    /*
      Telegram only on a new signal.
    */

    if (
      isNewBuy ||
      isNewSell
    ) {
      if (
        !isSignalOnCooldown(pair)
      ) {
        if (isNewBuy) {
          state.performance.totalSignals++;
          state.performance.buys++;
        }

        if (isNewSell) {
          state.performance.totalSignals++;
          state.performance.sells++;
        }

        await sendTelegramSignal(
          signal
        );

        markSignalSent(pair);
      }
    }

    state.pairs[pair] =
      signal;

    console.log(
      `[${pair}] ${signal.status} | Score ${signal.score}/5 | ${signal.message}`
    );

    if (
      signal.newsProtection?.active
    ) {
      console.log(
        `[${pair}] NEWS ${signal.newsProtection.phase} | ${signal.newsProtection.event?.title || ""}`
      );
    }

  } catch (err) {
    console.error(
      `[${pair}] ERROR:`,
      err.message
    );

    result.status =
      "OFFLINE";

    result.score = 0;

    result.message =
      err.message;

    result.updated =
      new Date().toISOString();

    result.price =
      result.entry =
      result.stopLoss =
      result.takeProfit =
        null;

    result.riskReward =
      null;

    result.newsProtection = {
      active: false,
      phase:
        state.newsProtection.status ===
        "UNAVAILABLE"
          ? "UNAVAILABLE"
          : "CLEAR",
      event: null,
      message:
        "News protection unavailable; normal scan error"
    };

    result.analysis = {
      direction: "WAIT",
      h12SMC: "—",
      h1SMC: "—",
      breakout: false,
      rejection: false,
      location: "—",
      extended: false,
      structure: "—",
      bos: "—",
      choch: "—",
      liquidity: "—",
      fvg: "—",
      retracement: false,
      newsConfirmed: false
    };

    state.api.lastError =
      `${pair}: ${err.message}`;
  }
}

/*
=========================================================
SCAN ALL
=========================================================
*/

async function scanAll() {
  if (scanRunning) {
    console.log(
      "[SCAN] Previous scan still running — skipping"
    );

    return;
  }

  scanRunning = true;

  state.api.requestsThisScan =
    0;

  state.api.lastError =
    null;

  try {
    console.log(
      "===================================="
    );

    console.log(
      `[SCAN] ${new Date().toISOString()}`
    );

    console.log(
      `[SCAN] XAU/USD + GBP/JPY`
    );

    console.log(
      `[SCAN] Market: ${
        isMarketOpen()
          ? "OPEN"
          : "CLOSED"
      }`
    );

    /*
      Refresh news once per scan.
    */

    if (isMarketOpen()) {
      await refreshNewsCalendar();
    }

    if (!isMarketOpen()) {
      for (const pair of PAIRS) {
        setMarketClosed(pair);
      }

      state.lastScan =
        new Date().toISOString();

      return;
    }

    for (const pair of PAIRS) {
      await scanPair(pair);

      await sleep(
        API_DELAY_MS
      );

      /*
        If Twelve Data rate limit was hit,
        stop the remaining scan rather than
        generating more API errors.
      */

      if (
        state.api.cooldownUntil &&
        Date.now() <
          state.api.cooldownUntil
      ) {
        console.log(
          "[SCAN] API cooldown active — stopping scan"
        );

        break;
      }
    }

    state.lastScan =
      new Date().toISOString();

  } catch (err) {
    console.error(
      "[SCAN] ERROR:",
      err.message
    );

    state.api.lastError =
      err.message;

  } finally {
    scanRunning = false;
  }
}

/*
=========================================================
API — STATUS
=========================================================
*/

app.get(
  "/api/status",
  (req, res) => {
    const cooldownSeconds =
      state.api.cooldownUntil &&
      state.api.cooldownUntil >
        Date.now()
        ? Math.ceil(
            (
              state.api.cooldownUntil -
              Date.now()
            ) / 1000
          )
        : 0;

    const total =
      state.performance
        .totalSignals;

    const winRate =
      total > 0
        ? Number(
            (
              state.performance.wins /
              total *
              100
            ).toFixed(1)
          )
        : 0;

    res.json({
      online:
        state.online,

      marketOpen:
        isMarketOpen(),

      marketStatus:
        isMarketOpen()
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

      performance: {
        ...state.performance,
        winRate
      },

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
API — ALERTS GET
=========================================================
*/

app.get(
  "/api/alerts",
  (req, res) => {
    res.json({
      enabled:
        alertsEnabled,

      configured:
        Boolean(
          TELEGRAM_BOT_TOKEN &&
          TELEGRAM_CHAT_ID
        )
    });
  }
);

/*
=========================================================
API — ALERTS POST
=========================================================
*/

app.post(
  "/api/alerts",
  (req, res) => {
    if (
      typeof req.body?.enabled ===
      "boolean"
    ) {
      alertsEnabled =
        req.body.enabled;
    }

    res.json({
      ok: true,
      enabled:
        alertsEnabled
    });
  }
);

/*
=========================================================
API — MANUAL SCAN
=========================================================
*/

app.post(
  "/api/scan",
  async (req, res) => {
    if (scanRunning) {
      return res.json({
        ok: false,
        message:
          "A scan is already running"
      });
    }

    try {
      await scanAll();

      res.json({
        ok: true,
        message:
          "Scan completed",
        lastScan:
          state.lastScan
      });

    } catch (err) {
      res.status(500).json({
        ok: false,
        error:
          err.message
      });
    }
  }
);

/*
=========================================================
API — NEWS
=========================================================
*/

app.get(
  "/api/news",
  (req, res) => {
    res.json({
      ...state.newsProtection
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

      online:
        state.online,

      marketOpen:
        isMarketOpen(),

      lastScan:
        state.lastScan,

      timestamp:
        new Date().toISOString()
    });
  }
);

/*
=========================================================
API INFO
=========================================================
*/

app.get(
  "/api",
  (req, res) => {
    res.json({
      name:
        "Trading Cloud Monitor",

      version:
        "News Protection Edition",

      engine:
        "12H + 1H + 5M",

      pairs:
        PAIRS,

      features: [
        "12H bias",
        "1H confirmation",
        "5M entry",
        "SMC",
        "BOS",
        "CHoCH",
        "Liquidity",
        "FVG",
        "Retracement",
        "Extension protection",
        "1:2 Risk/Reward",
        "Telegram alerts",
        "High-impact news protection"
      ],

      newsProtection: {
        enabled: true,

        beforeMinutes:
          NEWS_BEFORE_MINUTES,

        afterMinutes:
          NEWS_AFTER_MINUTES,

        settleMinutes:
          NEWS_SETTLE_MINUTES,

        source:
          "Biquote Economic Calendar"
      }
    });
  }
);

/*
=========================================================
ROOT
=========================================================
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

/*
=========================================================
ERROR HANDLING
=========================================================
*/

process.on(
  "unhandledRejection",
  err => {
    console.error(
      "[UNHANDLED REJECTION]",
      err
    );
  }
);

process.on(
  "uncaughtException",
  err => {
    console.error(
      "[UNCAUGHT EXCEPTION]",
      err
    );
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
      "TRADING CLOUD MONITOR ONLINE"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Pairs: ${PAIRS.join(" + ")}`
    );

    console.log(
      "Engine: 12H + 1H + 5M"
    );

    console.log(
      "SMC: BOS + CHoCH + Liquidity"
    );

    console.log(
      "FVG: ENABLED"
    );

    console.log(
      "Retracement: ENABLED"
    );

    console.log(
      "News Protection: ENABLED"
    );

    console.log(
      "News: BEFORE → WAIT"
    );

    console.log(
      "News: AFTER → WAIT"
    );

    console.log(
      "News: SETTLING → WAIT"
    );

    console.log(
      "News setup: Liquidity → BOS/CHoCH → Retracement/FVG"
    );

    console.log(
      `Twelve Data: ${
        API_KEY
          ? "CONFIGURED"
          : "MISSING"
      }`
    );

    console.log(
      `Telegram: ${
        TELEGRAM_BOT_TOKEN &&
        TELEGRAM_CHAT_ID
          ? "CONFIGURED"
          : "NOT CONFIGURED"
      }`
    );

    console.log(
      `Scan interval: ${
        POLL_MS / 60000
      } minutes`
    );

    console.log(
      "===================================="
    );

    /*
      Initial scan.
      The server is already listening at this point,
      so the dashboard can load even while scanning.
    */

    try {
      await scanAll();
    } catch (err) {
      console.error(
        "[STARTUP SCAN ERROR]",
        err.message
      );
    }

    /*
      Continue automatic scanning.
    */

    setInterval(
      async () => {
        try {
          await scanAll();
        } catch (err) {
          console.error(
            "[AUTO SCAN ERROR]",
            err.message
          );
        }
      },
      POLL_MS
    );
  }
);
