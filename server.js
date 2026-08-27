const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TWELVE_DATA_API_KEY;

const TIMEFRAME = "5min";

/*
  One batch request for all 7 pairs.

  15 minutes = 96 scans/day.
  7 symbols x 96 scans = 672 API credits/day.

  Twelve Data Basic currently allows 8 API credits/minute
  and 800 API credits/day.
*/
const POLL_MS = Math.max(
  900000,
  Number(process.env.POLL_MS || 900000)
);

const OUTPUT_SIZE = 3000;

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
   STATE
========================================================= */

const state = {
  lastScan: null,
  scanning: false,

  pairs: {},

  api: {
    status: API_KEY ? "READY" : "NOT CONFIGURED",
    lastError: null,
    last429: null,
    cooldownUntil: null,

    requestsThisScan: 0,
    totalRequests: 0,

    creditsUsed: null,
    creditsLeft: null
  }
};


/* =========================================================
   ALERTS
========================================================= */

let alertsEnabled = true;

const lastAlertSent = {};


/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


function nowISO() {
  return new Date().toISOString();
}


function safeNumber(value) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}


/* =========================================================
   EMA
========================================================= */

function ema(values, period) {

  if (!values.length) {
    return 0;
  }

  const k = 2 / (period + 1);

  let result = values[0];

  for (let i = 1; i < values.length; i++) {

    result =
      values[i] * k +
      result * (1 - k);
  }

  return result;
}


/* =========================================================
   RSI
========================================================= */

function rsi(values, period = 14) {

  if (values.length < period + 1) {
    return 50;
  }

  let gains = 0;
  let losses = 0;

  const start = values.length - period;

  for (let i = start; i < values.length; i++) {

    const change =
      values[i] - values[i - 1];

    if (change > 0) {
      gains += change;
    }

    if (change < 0) {
      losses += Math.abs(change);
    }
  }

  if (losses === 0) {
    return 100;
  }

  const averageGain =
    gains / period;

  const averageLoss =
    losses / period;

  const rs =
    averageGain / averageLoss;

  return 100 - (100 / (1 + rs));
}


/* =========================================================
   SMC STRUCTURE
========================================================= */

function smc(candles) {

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


  const highs =
    candles.map(c => safeNumber(c.high));

  const lows =
    candles.map(c => safeNumber(c.low));

  const closes =
    candles.map(c => safeNumber(c.close));


  const recentHigh =
    Math.max(
      ...highs.slice(-20, -2)
    );

  const recentLow =
    Math.min(
      ...lows.slice(-20, -2)
    );


  const last =
    candles[candles.length - 1];

  const previous =
    candles[candles.length - 2];


  const close =
    safeNumber(last.close);

  const open =
    safeNumber(last.open);

  const previousClose =
    safeNumber(previous.close);


  const bullishBOS =
    close > recentHigh;

  const bearishBOS =
    close < recentLow;


  const bullishSweep =
    safeNumber(last.low) < recentLow &&
    close > recentLow;


  const bearishSweep =
    safeNumber(last.high) > recentHigh &&
    close < recentHigh;


  const bullishCandle =
    close > open;

  const bearishCandle =
    close < open;


  if (
    bullishBOS &&
    bullishCandle
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
    bearishCandle
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
    bullishCandle
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
    bearishCandle
  ) {

    return {
      bias: "BEARISH",
      bos: false,
      sweep: true,
      strength: "CONFIRMED"
    };
  }


  /*
    Use EMA trend as a secondary bias.
  */

  const validCloses =
    closes.filter(
      x => x !== null
    );


  if (validCloses.length >= 20) {

    const ema9 =
      ema(validCloses, 9);

    const ema20 =
      ema(validCloses, 20);

    if (ema9 > ema20) {

      return {
        bias: "BULLISH",
        bos: false,
        sweep: false,
        strength: "WEAK"
      };
    }

    if (ema9 < ema20) {

      return {
        bias: "BEARISH",
        bos: false,
        sweep: false,
        strength: "WEAK"
      };
    }
  }


  return {
    bias: "NEUTRAL",
    bos: false,
    sweep: false,
    strength: "WEAK"
  };
}


/* =========================================================
   BUILD HIGHER TIMEFRAMES FROM 5M
========================================================= */

function buildCandles(
  candles,
  minutesPerCandle
) {

  if (
    !Array.isArray(candles) ||
    candles.length < 10
  ) {

    return [];
  }


  const groups = new Map();


  for (const candle of candles) {

    const date =
      new Date(candle.datetime);

    if (
      Number.isNaN(
        date.getTime()
      )
    ) {
      continue;
    }


    const timestamp =
      date.getTime();


    const bucket =
      Math.floor(
        timestamp /
        (minutesPerCandle * 60 * 1000)
      ) *
      (minutesPerCandle * 60 * 1000);


    const key =
      String(bucket);


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
      bucket,
      group
    ] of groups
  ) {

    group.sort(
      (a, b) =>
        new Date(a.datetime) -
        new Date(b.datetime)
    );


    if (!group.length) {
      continue;
    }


    const first =
      group[0];

    const last =
      group[group.length - 1];


    result.push({

      datetime:
        new Date(
          Number(bucket)
        ).toISOString(),

      open:
        safeNumber(first.open),

      high:
        Math.max(
          ...group.map(
            c => safeNumber(c.high)
          )
        ),

      low:
        Math.min(
          ...group.map(
            c => safeNumber(c.low)
          )
        ),

      close:
        safeNumber(last.close),

      volume:
        group.reduce(
          (sum, c) =>
            sum +
            (safeNumber(c.volume) || 0),
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
   TWELVE DATA BATCH
========================================================= */

async function fetchBatch() {

  if (!API_KEY) {

    throw new Error(
      "TWELVE_DATA_API_KEY is not configured"
    );
  }


  const symbolList =
    pairs.join(",");


  const url =
    "https://api.twelvedata.com/time_series" +
    "?symbol=" +
    encodeURIComponent(symbolList) +
    "&interval=" +
    encodeURIComponent(TIMEFRAME) +
    "&outputsize=" +
    OUTPUT_SIZE +
    "&timezone=UTC" +
    "&apikey=" +
    encodeURIComponent(API_KEY);


  state.api.requestsThisScan++;
  state.api.totalRequests++;


  const response =
    await fetch(url);


  const creditsUsed =
    response.headers.get(
      "api-credits-used"
    );

  const creditsLeft =
    response.headers.get(
      "api-credits-left"
    );


  if (creditsUsed !== null) {

    state.api.creditsUsed =
      Number(creditsUsed);
  }


  if (creditsLeft !== null) {

    state.api.creditsLeft =
      Number(creditsLeft);
  }


  if (response.status === 429) {

    state.api.status =
      "RATE LIMITED";

    state.api.last429 =
      nowISO();

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
      "Twelve Data HTTP " +
      response.status;


    throw new Error(
      "Twelve Data HTTP " +
      response.status
    );
  }


  const data =
    await response.json();


  return data;
}


/* =========================================================
   EXTRACT BATCH SYMBOL
========================================================= */

function getSymbolData(
  batch,
  pair
) {

  /*
    Normal single-symbol response.
  */

  if (
    batch &&
    batch.values
  ) {

    return batch;
  }


  if (
    !batch ||
    typeof batch !== "object"
  ) {

    return null;
  }


  /*
    Direct key.
  */

  if (
    batch[pair] &&
    batch[pair].values
  ) {

    return batch[pair];
  }


  /*
    Normalized key search.
  */

  const target =
    pair
      .replace(/\//g, "")
      .replace(/:/g, "")
      .toUpperCase();


  for (
    const key of Object.keys(batch)
  ) {

    const normalized =
      key
        .replace(/\//g, "")
        .replace(/:/g, "")
        .toUpperCase();


    if (
      normalized === target
    ) {

      if (
        batch[key] &&
        batch[key].values
      ) {

        return batch[key];
      }
    }
  }


  return null;
}


/* =========================================================
   VALIDATE CANDLES
========================================================= */

function cleanCandles(values) {

  if (
    !Array.isArray(values)
  ) {

    return [];
  }


  return values
    .filter(c =>
      c &&
      c.datetime &&
      safeNumber(c.open) !== null &&
      safeNumber(c.high) !== null &&
      safeNumber(c.low) !== null &&
      safeNumber(c.close) !== null
    )
    .map(c => ({
      datetime: c.datetime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume || 0
    }))
    .reverse();
}


/* =========================================================
   SIGNAL ENGINE
========================================================= */

function createSignal(
  pair,
  candles
) {

  if (
    candles.length < 100
  ) {

    return {

      pair,

      signal: "DATA WAIT",

      score: 0,

      detail:
        "Waiting for enough 5M candles",

      updatedAt:
        nowISO()
    };
  }


  /*
    Build 1H and 12H locally.

    This is important because we do NOT make additional
    Twelve Data requests for the higher timeframes.
  */

  const h1 =
    buildCandles(
      candles,
      60
    );


  const h12 =
    buildCandles(
      candles,
      720
    );


  if (
    h1.length < 20 ||
    h12.length < 20
  ) {

    return {

      pair,

      signal: "DATA WAIT",

      score: 0,

      detail:
        "Waiting for enough 1H/12H structure",

      updatedAt:
        nowISO()
    };
  }


  const bias12 =
    smc(h12);

  const bias1 =
    smc(h1);


  const last =
    candles[candles.length - 1];

  const previous =
    candles[candles.length - 2];


  const close =
    safeNumber(last.close);

  const open =
    safeNumber(last.open);

  const high =
    safeNumber(last.high);

  const low =
    safeNumber(last.low);


  const previousHigh =
    safeNumber(previous.high);

  const previousLow =
    safeNumber(previous.low);


  /*
    Last 20 completed candles,
    excluding current candle.
  */

  const recent =
    candles.slice(
      -21,
      -1
    );


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

      pair,

      signal: "WAIT",

      score: 0,

      detail:
        "Invalid market range",

      updatedAt:
        nowISO()
    };
  }


  const closes =
    candles.map(
      c => safeNumber(c.close)
    );


  const currentRSI =
    rsi(closes, 14);


  const ema20 =
    ema(
      closes.slice(-100),
      20
    );


  const ema50 =
    ema(
      closes.slice(-100),
      50
    );


  /*
    BUY setup
  */

  const bullishCandle =
    close > open;


  const bullishBreak =
    close > previousHigh;


  const bullishPullback =
    low <=
    recentLow +
    range * 0.50;


  const bullishHigherTF =
    bias12.bias === "BULLISH" &&
    bias1.bias === "BULLISH";


  const bullishTrend =
    ema20 > ema50;


  /*
    SELL setup
  */

  const bearishCandle =
    close < open;


  const bearishBreak =
    close < previousLow;


  const bearishPullback =
    high >=
    recentHigh -
    range * 0.50;


  const bearishHigherTF =
    bias12.bias === "BEARISH" &&
    bias1.bias === "BEARISH";


  const bearishTrend =
    ema20 < ema50;


  /*
    Anti-late-entry protection.

    We don't want to buy at the very top of the move
    or sell at the very bottom.
  */

  const bullishExtension =
    (close - recentLow) /
    range;


  const bearishExtension =
    (recentHigh - close) /
    range;


  const buyNotLate =
    bullishExtension <= 0.80;


  const sellNotLate =
    bearishExtension <= 0.80;


  /*
    BUY SCORE
  */

  let buyScore = 0;

  if (bullishHigherTF) {
    buyScore++;
  }

  if (bullishTrend) {
    buyScore++;
  }

  if (bullishBreak) {
    buyScore++;
  }

  if (bullishPullback) {
    buyScore++;
  }

  if (
    currentRSI >= 50 &&
    currentRSI <= 72
  ) {
    buyScore++;
  }


  /*
    SELL SCORE
  */

  let sellScore = 0;

  if (bearishHigherTF) {
    sellScore++;
  }

  if (bearishTrend) {
    sellScore++;
  }

  if (bearishBreak) {
    sellScore++;
  }

  if (bearishPullback) {
    sellScore++;
  }

  if (
    currentRSI >= 28 &&
    currentRSI <= 50
  ) {
    sellScore++;
  }


  /*
    STRONG BUY
  */

  if (
    buyScore >= 5 &&
    buyNotLate
  ) {

    const stopLoss =
      recentLow;


    const risk =
      close - stopLoss;


    if (risk > 0) {

      const takeProfit =
        close +
        risk * 2;


      return {

        pair,

        signal:
          "STRONG BUY",

        entry:
          Number(
            close.toFixed(5)
          ),

        stopLoss:
          Number(
            stopLoss.toFixed(5)
          ),

        takeProfit:
          Number(
            takeProfit.toFixed(5)
          ),

        score: 5,

        rsi:
          Number(
            currentRSI.toFixed(1)
          ),

        detail:
          "12H bullish ✓ 1H bullish ✓ 5M break ✓ Pullback ✓ RSI ✓",

        updatedAt:
          nowISO()
      };
    }
  }


  /*
    STRONG SELL
  */

  if (
    sellScore >= 5 &&
    sellNotLate
  ) {

    const stopLoss =
      recentHigh;


    const risk =
      stopLoss - close;


    if (risk > 0) {

      const takeProfit =
        close -
        risk * 2;


      return {

        pair,

        signal:
          "STRONG SELL",

        entry:
          Number(
            close.toFixed(5)
          ),

        stopLoss:
          Number(
            stopLoss.toFixed(5)
          ),

        takeProfit:
          Number(
            takeProfit.toFixed(5)
          ),

        score: 5,

        rsi:
          Number(
            currentRSI.toFixed(1)
          ),

        detail:
          "12H bearish ✓ 1H bearish ✓ 5M break ✓ Pullback ✓ RSI ✓",

        updatedAt:
          nowISO()
      };
    }
  }


  /*
    WAIT
  */

  return {

    pair,

    signal:
      "WAIT",

    score:
      Math.max(
        buyScore,
        sellScore
      ),

    detail:
      `12H ${bias12.bias} | 1H ${bias1.bias} | RSI ${currentRSI.toFixed(1)} | Waiting for 5M confirmation`,

    updatedAt:
      nowISO()
  };
}


/* =========================================================
   TELEGRAM
========================================================= */

async function sendTelegram(signal) {

  if (!alertsEnabled) {
    return;
  }


  const token =
    process.env.TELEGRAM_BOT_TOKEN;

  const chatId =
    process.env.TELEGRAM_CHAT_ID;


  if (
    !token ||
    !chatId
  ) {

    return;
  }


  /*
    Don't send the same signal repeatedly.
  */

  const alertKey =
    signal.pair +
    ":" +
    signal.signal;


  if (
    lastAlertSent[signal.pair] ===
    alertKey
  ) {

    return;
  }


  const message =
`🚨 ${signal.signal}: ${signal.pair}

Entry: ${signal.entry}
🛑 Stop Loss: ${signal.stopLoss}
🎯 Take Profit: ${signal.takeProfit}

⭐ Score: ${signal.score}/5
📊 RSI: ${signal.rsi}

${signal.detail}`;


  try {

    const response =
      await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {

          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({

              chat_id:
                chatId,

              text:
                message
            })
        }
      );


    if (!response.ok) {

      console.log(
        "Telegram error:",
        response.status
      );

      return;
    }


    lastAlertSent[signal.pair] =
      alertKey;


    console.log(
      "Telegram alert sent:",
      signal.pair,
      signal.signal
    );

  } catch (error) {

    console.log(
      "Telegram error:",
      error.message
    );
  }
}


/* =========================================================
   SCAN
========================================================= */

async function scan() {

  if (state.scanning) {

    console.log(
      "Scan already running."
    );

    return;
  }


  state.scanning = true;

  state.api.requestsThisScan = 0;


  try {

    console.log(
      "Starting market scan..."
    );


    const batch =
      await fetchBatch();


    state.api.status =
      "CONNECTED";

    state.api.lastError =
      null;


    /*
      Process every pair from the same batch.
    */

    for (
      const pair of pairs
    ) {

      const symbolData =
        getSymbolData(
          batch,
          pair
        );


      if (
        !symbolData ||
        !symbolData.values
      ) {

        state.pairs[pair] = {

          pair,

          signal:
            "DATA WAIT",

          score: 0,

          detail:
            "No market data returned for this pair",

          updatedAt:
            nowISO()
        };


        continue;
      }


      const candles =
        cleanCandles(
          symbolData.values
        );


      if (
        candles.length < 100
      ) {

        state.pairs[pair] = {

          pair,

          signal:
            "DATA WAIT",

          score: 0,

          detail:
            `Only ${candles.length} candles received`,

          updatedAt:
            nowISO()
        };


        continue;
      }


      const signal =
        createSignal(
          pair,
          candles
        );


      state.pairs[pair] =
        signal;


      if (
        signal.signal ===
          "STRONG BUY" ||
        signal.signal ===
          "STRONG SELL"
      ) {

        await sendTelegram(
          signal
        );
      }
    }


    state.lastScan =
      nowISO();


    console.log(
      "Scan completed."
    );


  } catch (error) {

    console.log(
      "SCAN ERROR:",
      error.message
    );


    state.api.lastError =
      error.message;


    if (
      error.message.includes(
        "429"
      )
    ) {

      state.api.status =
        "RATE LIMITED";
    }


    /*
      Do NOT destroy good previous data.

      Only mark pairs as DATA WAIT if we have
      never received data for them.
    */

    for (
      const pair of pairs
    ) {

      if (
        !state.pairs[pair]
      ) {

        state.pairs[pair] = {

          pair,

          signal:
            "DATA WAIT",

          score: 0,

          detail:
            error.message,

          updatedAt:
            nowISO()
        };
      }
    }


    state.lastScan =
      nowISO();

  } finally {

    state.scanning =
      false;
  }
}


/* =========================================================
   API ROUTES
========================================================= */

app.get(
  "/health",
  (req, res) => {

    res.json({

      ok: true,

      service:
        "Trading Cloud Monitor",

      time:
        nowISO()
    });
  }
);


app.get(
  "/api/status",
  (req, res) => {

    res.json({

      lastScan:
        state.lastScan,

      timeframe:
        TIMEFRAME,

      scanning:
        state.scanning,

      pairs:
        state.pairs,

      api:
        state.api
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
        alertsEnabled
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
      "Trading Cloud Monitor running on port " +
      PORT
    );

    console.log(
      "Pairs:",
      pairs.join(", ")
    );

    console.log(
      "Scan interval:",
      POLL_MS / 60000,
      "minutes"
    );


    /*
      First scan after server starts.
    */

    scan();


    /*
      Continue scanning.
    */

    setInterval(
      scan,
      POLL_MS
    );
  }
);
