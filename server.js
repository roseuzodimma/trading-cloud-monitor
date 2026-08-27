const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* =========================================================
   CONFIGURATION
========================================================= */

const PORT = process.env.PORT || 3000;

const API_KEY =
  process.env.TWELVE_DATA_API_KEY;

const POLL_MS = Math.max(
  900000,
  Number(process.env.POLL_MS || 900000)
);

const REQUEST_DELAY_MS = Math.max(
  1500,
  Number(process.env.REQUEST_DELAY_MS || 2000)
);

const API_COOLDOWN_MS =
  5 * 60 * 1000;

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
    status: API_KEY
      ? "READY"
      : "NOT CONFIGURED",

    lastError: null,
    last429: null,
    cooldownUntil: null,

    requestsThisScan: 0,
    totalRequests: 0
  }
};


/* =========================================================
   INITIALIZE ALL 7 PAIRS
========================================================= */

for (const pair of pairs) {
  state.pairs[pair] = {
    pair,
    signal: "DATA WAIT",
    score: 0,
    detail: "Waiting for market data...",
    updatedAt: new Date().toISOString()
  };
}


/* =========================================================
   ALERTS
========================================================= */

let alertsEnabled = true;

const lastSignal = {};


/* =========================================================
   CANDLE CACHE
========================================================= */

const tfCache = new Map();

const TF_CACHE_MS = {
  "1h": 60 * 60 * 1000,
  "5min": 15 * 60 * 1000
};


/* =========================================================
   API COOLDOWN
========================================================= */

let apiCooldownUntil = 0;


/* =========================================================
   SLEEP
========================================================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


/* =========================================================
   EMA
========================================================= */

function ema(values, period) {

  if (!values.length) {
    return 0;
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
      values[i] * multiplier +
      result * (1 - multiplier);
  }

  return result;
}


/* =========================================================
   RSI
========================================================= */

function rsi(values, period = 14) {

  if (
    values.length <
    period + 1
  ) {
    return 50;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = values.length - period;
    i < values.length;
    i++
  ) {

    const difference =
      values[i] -
      values[i - 1];

    if (difference > 0) {
      gains += difference;
    } else {
      losses -= difference;
    }
  }

  if (losses === 0) {
    return 100;
  }

  const averageGain =
    gains / period;

  const averageLoss =
    losses / period;

  const relativeStrength =
    averageGain /
    averageLoss;

  return (
    100 -
    100 /
      (1 + relativeStrength)
  );
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
    candles.map(x => +x.high);

  const lows =
    candles.map(x => +x.low);

  const last =
    candles[candles.length - 1];

  const previous =
    candles[candles.length - 2];

  const recentHigh =
    Math.max(
      ...highs.slice(-20, -3)
    );

  const recentLow =
    Math.min(
      ...lows.slice(-20, -3)
    );

  const lastClose =
    +last.close;

  const lastOpen =
    +last.open;

  const previousClose =
    +previous.close;

  const previousOpen =
    +previous.open;

  const bullishBOS =
    lastClose >
    recentHigh;

  const bearishBOS =
    lastClose <
    recentLow;

  const bullishSweep =
    +last.low <
      recentLow &&
    lastClose >
      recentLow;

  const bearishSweep =
    +last.high >
      recentHigh &&
    lastClose <
      recentHigh;

  const bullishCandles =
    (lastClose > lastOpen ? 1 : 0) +
    (previousClose > previousOpen ? 1 : 0);

  const bearishCandles =
    (lastClose < lastOpen ? 1 : 0) +
    (previousClose < previousOpen ? 1 : 0);


  if (
    bullishBOS &&
    bullishCandles >= 1
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
    bearishCandles >= 1
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
    bullishCandles >= 1
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
    bearishCandles >= 1
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
   TWELVE DATA
========================================================= */

async function fetchCandles(
  pair,
  interval
) {

  if (!API_KEY) {

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


  const outputSize =
    interval === "1h"
      ? 300
      : 100;


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


  const response =
    await fetch(url);


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


  if (!response.ok) {

    state.api.status =
      "API ERROR";

    state.api.lastError =
      `Twelve Data HTTP ${response.status}`;

    throw new Error(
      `Twelve Data HTTP ${response.status}`
    );
  }


  const data =
    await response.json();


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

async function getCachedCandles(
  pair,
  interval
) {

  const key =
    `${pair}:${interval}`;

  const now =
    Date.now();

  const cached =
    tfCache.get(key);


  if (
    cached &&
    now - cached.time <
      TF_CACHE_MS[interval]
  ) {

    return cached.data;
  }


  await sleep(
    REQUEST_DELAY_MS
  );


  const data =
    await fetchCandles(
      pair,
      interval
    );


  tfCache.set(
    key,
    {
      data,
      time: Date.now()
    }
  );


  return data;
}


/* =========================================================
   BUILD 12H CANDLES FROM 1H
========================================================= */

function build12HCandles(
  hourly
) {

  if (
    !Array.isArray(hourly) ||
    hourly.length < 12
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

    if (
      candles.length < 8
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
      candles[
        candles.length - 1
      ];


    result.push({

      datetime,

      open:
        +first.open,

      high:
        Math.max(
          ...candles.map(
            x => +x.high
          )
        ),

      low:
        Math.min(
          ...candles.map(
            x => +x.low
          )
        ),

      close:
        +last.close,

      volume:
        candles.reduce(
          (sum, x) =>
            sum +
            (+x.volume || 0),
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
   MULTI-TIMEFRAME SIGNAL
========================================================= */

function multiTimeframeSignal(
  pair,
  h12,
  h1,
  m5
) {

  const b12 =
    smc(h12);

  const b1 =
    smc(h1);


  if (
    !m5 ||
    m5.length < 12
  ) {

    return {
      pair,
      signal: "WAIT",
      score: 0,
      detail:
        `12H ${b12.bias} | 1H ${b1.bias} | Waiting for 5M data`
    };
  }


  const last =
    m5[m5.length - 1];

  const previous =
    m5[m5.length - 2];


  const close =
    +last.close;

  const open =
    +last.open;

  const high =
    +last.high;

  const low =
    +last.low;

  const previousHigh =
    +previous.high;

  const previousLow =
    +previous.low;


  const recent =
    m5.slice(-11, -1);


  const recentHigh =
    Math.max(
      ...recent.map(
        x => +x.high
      )
    );

  const recentLow =
    Math.min(
      ...recent.map(
        x => +x.low
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
        "Invalid 5M range"
    };
  }


  /* =======================================================
     5M PULLBACK CONFIRMATION
  ======================================================= */

  const bullish5 =
    close > open &&
    close > previousHigh &&
    low <=
      recentLow +
      range * 0.45;


  const bearish5 =
    close < open &&
    close < previousLow &&
    high >=
      recentHigh -
      range * 0.45;


  /* =======================================================
     ANTI-LATE-ENTRY PROTECTION
  ======================================================= */

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


  const buyNotExtended =
    bullishExtension <= 0.80;

  const sellNotExtended =
    bearishExtension <= 0.80;


  /* =======================================================
     HIGHER TIMEFRAME ALIGNMENT
  ======================================================= */

  const higherBullish =
    b12.bias === "BULLISH" &&
    (
      b12.strength === "STRONG" ||
      b12.strength === "CONFIRMED"
    ) &&
    b1.bias === "BULLISH" &&
    (
      b1.strength === "STRONG" ||
      b1.strength === "CONFIRMED"
    );


  const higherBearish =
    b12.bias === "BEARISH" &&
    (
      b12.strength === "STRONG" ||
      b12.strength === "CONFIRMED"
    ) &&
    b1.bias === "BEARISH" &&
    (
      b1.strength === "STRONG" ||
      b1.strength === "CONFIRMED"
    );


  /* =======================================================
     BUY
  ======================================================= */

  if (
    higherBullish &&
    bullish5 &&
    buyNotExtended
  ) {

    const stopLoss =
      recentLow;

    const risk =
      close -
      stopLoss;


    if (
      risk <= 0
    ) {

      return {
        pair,
        signal: "WAIT",
        score: 0,
        detail:
          "Invalid BUY risk"
      };
    }


    const takeProfit =
      close +
      risk * 2;


    return {

      pair,

      signal:
        "STRONG BUY",

      entry:
        +close.toFixed(5),

      stopLoss:
        +stopLoss.toFixed(5),

      takeProfit:
        +takeProfit.toFixed(5),

      score: 5,

      detail:
        "12H bullish ✓ 1H bullish ✓ 5M pullback/break ✓ SMC confirmed"
    };
  }


  /* =======================================================
     SELL
  ======================================================= */

  if (
    higherBearish &&
    bearish5 &&
    sellNotExtended
  ) {

    const stopLoss =
      recentHigh;

    const risk =
      stopLoss -
      close;


    if (
      risk <= 0
    ) {

      return {
        pair,
        signal: "WAIT",
        score: 0,
        detail:
          "Invalid SELL risk"
      };
    }


    const takeProfit =
      close -
      risk * 2;


    return {

      pair,

      signal:
        "STRONG SELL",

      entry:
        +close.toFixed(5),

      stopLoss:
        +stopLoss.toFixed(5),

      takeProfit:
        +takeProfit.toFixed(5),

      score: 5,

      detail:
        "12H bearish ✓ 1H bearish ✓ 5M pullback/break ✓ SMC confirmed"
    };
  }


  return {

    pair,

    signal:
      "WAIT",

    score: 0,

    detail:
      `12H ${b12.bias} | 1H ${b1.bias} | Waiting for 5M confirmation`
  };
}


/* =========================================================
   TELEGRAM
========================================================= */

async function notify(signal) {

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


  const message =
`🚨 ${signal.signal}: ${signal.pair}
Entry: ${signal.entry}
🛑 Stop Loss: ${signal.stopLoss}
🎯 Take Profit: ${signal.takeProfit}
⭐ Score: ${signal.score}/5
📊 ${signal.detail}`;


  const response =
    await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",

        headers: {
          "content-type":
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


  if (
    !response.ok
  ) {

    throw new Error(
      `Telegram HTTP ${response.status}`
    );
  }
}


/* =========================================================
   SCAN
========================================================= */

async function scan() {

  if (state.scanning) {

    console.log(
      "Scan already running. Skipping."
    );

    return;
  }


  state.scanning =
    true;

  state.api.requestsThisScan =
    0;


  try {

    /* =====================================================
       GLOBAL RATE LIMIT CHECK
    ===================================================== */

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


    /* =====================================================
       PROCESS ALL 7 PAIRS
    ===================================================== */

    for (
      const pair of pairs
    ) {

      try {

        /*
          1H data is cached for one hour.
          12H is created locally.
        */

        const h1 =
          await getCachedCandles(
            pair,
            "1h"
          );


        const h12 =
          build12HCandles(
            h1
          );


        if (
          h1.length < 20 ||
          h12.length < 20
        ) {

          state.pairs[pair] = {

            pair,

            signal:
              "WAIT",

            score: 0,

            detail:
              "Waiting for enough 1H/12H candles",

            updatedAt:
              new Date().toISOString()
          };

          continue;
        }


        const b12 =
          smc(h12);

        const b1 =
          smc(h1);


        const higherBullish =
          b12.bias === "BULLISH" &&
          (
            b12.strength === "STRONG" ||
            b12.strength === "CONFIRMED"
          ) &&
          b1.bias === "BULLISH" &&
          (
            b1.strength === "STRONG" ||
            b1.strength === "CONFIRMED"
          );


        const higherBearish =
          b12.bias === "BEARISH" &&
          (
            b12.strength === "STRONG" ||
            b12.strength === "CONFIRMED"
          ) &&
          b1.bias === "BEARISH" &&
          (
            b1.strength === "STRONG" ||
            b1.strength === "CONFIRMED"
          );


        /*
          Only request 5M when the higher timeframes
          agree. This saves API credits.
        */

        if (
          !higherBullish &&
          !higherBearish
        ) {

          state.pairs[pair] = {

            pair,

            signal:
              "WAIT",

            score: 0,

            detail:
              `12H ${b12.bias} | 1H ${b1.bias} | Higher timeframes not aligned`,

            updatedAt:
              new Date().toISOString()
          };

          continue;
        }


        /*
          Get 5M confirmation.
        */

        const m5 =
          await getCachedCandles(
            pair,
            "5min"
          );


        const signal =
          multiTimeframeSignal(
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


        /*
          Telegram only sends a new alert when the
          direction changes.
        */

        if (
          (
            signal.signal ===
              "STRONG BUY" ||
            signal.signal ===
              "STRONG SELL"
          ) &&
          lastSignal[pair] !==
            signal.signal
        ) {

          lastSignal[pair] =
            signal.signal;


          try {

            await notify(
              signal
            );

          } catch (
            telegramError
          ) {

            console.error(
              "Telegram error:",
              telegramError.message
            );
          }
        }


      } catch (error) {

        /*
          If one pair fails, continue with the other
          pairs instead of crashing the whole scanner.
        */

        state.pairs[pair] = {

          pair,

          signal:
            "DATA WAIT",

          score: 0,

          detail:
            error.message,

          updatedAt:
            new Date().toISOString()
        };


        console.error(
          `${pair}: ${error.message}`
        );


        /*
          If we hit 429, stop processing this scan.
          The next scan will respect the cooldown.
        */

        if (
          Date.now() <
          apiCooldownUntil
        ) {

          break;
        }
      }
    }


    state.lastScan =
      new Date().toISOString();


  } catch (error) {

    console.error(
      "SCAN ERROR:",
      error
    );

    state.api.lastError =
      error.message;

  } finally {

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

      timeframe:
        "5min",

      lastScan:
        state.lastScan,

      scanning:
        state.scanning,

      api:
        state.api,

      pairs:
        state.pairs
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
        alertsEnabled
    });
  }
);


/* =========================================================
   ALERT TOGGLE
========================================================= */

app.post(
  "/api/alerts",
  (req, res) => {

    alertsEnabled =
      Boolean(
        req.body?.enabled
      );


    res.json({

      ok: true,

      enabled:
        alertsEnabled
    });
  }
);


/* =========================================================
   TELEGRAM TEST
========================================================= */

app.get(
  "/api/test-alert",
  async (req, res) => {

    try {

      await notify({

        signal:
          "TEST ALERT",

        pair:
          "SYSTEM",

        entry:
          "—",

        stopLoss:
          "—",

        takeProfit:
          "—",

        score:
          5,

        detail:
          "Telegram connection is working."
      });


      res.json({

        ok: true,

        message:
          "Test alert sent."
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


/* =========================================================
   HEALTH CHECK
========================================================= */

app.get(
  "/health",
  (req, res) => {

    res.json({
      ok: true,
      service:
        "Trading Cloud Monitor"
    });
  }
);


/* =========================================================
   DASHBOARD FALLBACK
========================================================= */

app.use(
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
   START SERVER
========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      "Cloud monitor running on port " +
      PORT
    );

    console.log(
      "Monitoring " +
      pairs.length +
      " pairs"
    );

    console.log(
      "Scan interval: " +
      POLL_MS / 60000 +
      " minutes"
    );

    /*
      Start first scan after the server is listening.
    */

    scan();
  }
);


/* =========================================================
   SCHEDULED SCAN
========================================================= */

setInterval(
  scan,
  POLL_MS
);
