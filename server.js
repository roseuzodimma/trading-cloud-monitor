const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* =========================================================
   CONFIG
========================================================= */

const PORT = process.env.PORT || 3000;

const API_KEY =
  process.env.TWELVE_DATA_API_KEY;

const TIMEFRAME =
  process.env.TIMEFRAME || "5min";

/*
  IMPORTANT:
  We use a 20-minute scan interval.

  This keeps the Basic Twelve Data plan below
  the 800 API-credit daily limit when using:
    - 7 pairs
    - 5M data every 20 minutes
    - 1H data every hour

  Approximate daily usage:
    5M: 7 x 72 = 504
    1H: 7 x 24 = 168
    Total:     672 credits/day
*/

const POLL_MS = Math.max(
  20 * 60 * 1000,
  Number(process.env.POLL_MS || 20 * 60 * 1000)
);

/*
  Small delay before API requests.
*/

const REQUEST_DELAY_MS = Math.max(
  1000,
  Number(
    process.env.REQUEST_DELAY_MS || 1500
  )
);


/* =========================================================
   PAIRS
========================================================= */

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
   ALERT STATE
========================================================= */

let alertsEnabled = true;

const lastSignal = {};


/* =========================================================
   DATA CACHE
========================================================= */

const cache = new Map();

/*
  5M data is cached for 20 minutes.

  1H data is cached for 60 minutes.

  12H is created locally from 1H data.
*/

const CACHE_TIME = {

  "5min":
    20 * 60 * 1000,

  "1h":
    60 * 60 * 1000
};


/* =========================================================
   API COOLDOWN
========================================================= */

const API_COOLDOWN_MS =
  5 * 60 * 1000;

let apiCooldownUntil = 0;


/* =========================================================
   UTILITY
========================================================= */

function sleep(ms) {

  return new Promise(
    resolve => setTimeout(
      resolve,
      ms
    )
  );
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
      values[i] *
      multiplier +
      result *
      (1 - multiplier);
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
    values.length <
    period + 1
  ) {

    return 50;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i =
      values.length - period;
    i < values.length;
    i++
  ) {

    const change =
      values[i] -
      values[i - 1];

    if (change >= 0) {

      gains += change;

    } else {

      losses -= change;
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
    averageGain /
    averageLoss;

  return 100 -
    100 / (1 + rs);
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
    candles.map(
      x => Number(x.high)
    );

  const lows =
    candles.map(
      x => Number(x.low)
    );


  const recentHigh =
    Math.max(
      ...highs.slice(-20, -3)
    );

  const recentLow =
    Math.min(
      ...lows.slice(-20, -3)
    );


  const last =
    candles[candles.length - 1];

  const previous =
    candles[candles.length - 2];


  const close =
    Number(last.close);

  const open =
    Number(last.open);

  const previousClose =
    Number(previous.close);

  const previousOpen =
    Number(previous.open);


  const bullishBOS =
    close > recentHigh;

  const bearishBOS =
    close < recentLow;


  const bullishSweep =
    Number(last.low) <
      recentLow &&
    close >
      recentLow;


  const bearishSweep =
    Number(last.high) >
      recentHigh &&
    close <
      recentHigh;


  const bullishCandles =
    (close > open ? 1 : 0) +
    (
      previousClose >
      previousOpen
        ? 1
        : 0
    );


  const bearishCandles =
    (close < open ? 1 : 0) +
    (
      previousClose <
      previousOpen
        ? 1
        : 0
    );


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
   BATCH TWELVE DATA REQUEST
========================================================= */

async function fetchBatchCandles(
  symbolList,
  interval
) {

  if (!API_KEY) {

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


  const symbolString =
    symbolList.join(",");


  const url =
    "https://api.twelvedata.com/time_series" +
    "?symbol=" +
    encodeURIComponent(
      symbolString
    ) +
    "&interval=" +
    encodeURIComponent(
      interval
    ) +
    "&outputsize=" +
    outputSize +
    "&apikey=" +
    encodeURIComponent(
      API_KEY
    );


  await sleep(
    REQUEST_DELAY_MS
  );


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
      "Twelve Data HTTP " +
      response.status;


    throw new Error(
      "Twelve Data HTTP " +
      response.status
    );
  }


  const data =
    await response.json();


  /*
    Batch responses normally return an object
    containing one result per symbol.

    We also support a single-symbol array response.
  */

  const result = {};


  if (
    Array.isArray(data.values)
  ) {

    /*
      Single-symbol response.
    */

    result[symbolList[0]] =
      data.values
        .slice()
        .reverse();

  } else if (
    data &&
    typeof data === "object"
  ) {

    for (
      const symbol of symbolList
    ) {

      const item =
        data[symbol];


      if (
        item &&
        Array.isArray(
          item.values
        )
      ) {

        result[symbol] =
          item.values
            .slice()
            .reverse();

      } else if (
        item &&
        item.status === "error"
      ) {

        result[symbol] = {

          error:
            item.message ||
            "Twelve Data error"
        };

      } else {

        result[symbol] = {

          error:
            "No candle data returned"
        };
      }
    }
  }


  state.api.status =
    "CONNECTED";

  state.api.lastError =
    null;

  state.api.cooldownUntil =
    null;


  return result;
}


/* =========================================================
   CACHED BATCH DATA
========================================================= */

async function getCachedBatch(
  symbolList,
  interval
) {

  const now =
    Date.now();


  const output = {};

  const missing = [];


  /*
    First use cache.
  */

  for (
    const symbol of symbolList
  ) {

    const key =
      `${symbol}:${interval}`;

    const cached =
      cache.get(key);


    if (
      cached &&
      now - cached.time <
        CACHE_TIME[interval]
    ) {

      output[symbol] =
        cached.data;

    } else {

      missing.push(symbol);
    }
  }


  /*
    If everything is cached,
    no API request is made.
  */

  if (
    missing.length === 0
  ) {

    return output;
  }


  /*
    One batch request instead of
    one request per pair.
  */

  const fresh =
    await fetchBatchCandles(
      missing,
      interval
    );


  for (
    const symbol of missing
  ) {

    const data =
      fresh[symbol];


    if (
      Array.isArray(data)
    ) {

      cache.set(
        `${symbol}:${interval}`,
        {

          data,

          time: now
        }
      );


      output[symbol] =
        data;

    } else {

      output[symbol] =
        data;
    }
  }


  return output;
}


/* =========================================================
   BUILD 12H CANDLES
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
        Number(first.open),

      high:
        Math.max(
          ...candles.map(
            x =>
              Number(x.high)
          )
        ),

      low:
        Math.min(
          ...candles.map(
            x =>
              Number(x.low)
          )
        ),

      close:
        Number(last.close),

      volume:
        candles.reduce(
          (
            total,
            x
          ) =>
            total +
            (
              Number(x.volume) ||
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
   SIGNAL ENGINE
========================================================= */

function createSignal(
  pair,
  h12,
  h1,
  m5
) {

  if (
    !Array.isArray(h12) ||
    !Array.isArray(h1) ||
    !Array.isArray(m5)
  ) {

    return {

      pair,

      signal:
        "DATA WAIT",

      score: 0,

      detail:
        "Waiting for market data"
    };
  }


  if (
    h12.length < 20 ||
    h1.length < 20 ||
    m5.length < 20
  ) {

    return {

      pair,

      signal:
        "DATA WAIT",

      score: 0,

      detail:
        "Waiting for enough candles"
    };
  }


  const b12 =
    smc(h12);

  const b1 =
    smc(h1);


  const closes =
    m5.map(
      x => Number(x.close)
    );


  const last =
    m5[m5.length - 1];

  const previous =
    m5[m5.length - 2];


  const close =
    Number(last.close);

  const open =
    Number(last.open);

  const high =
    Number(last.high);

  const low =
    Number(last.low);


  const previousHigh =
    Number(previous.high);

  const previousLow =
    Number(previous.low);


  /*
    RSI is used as an additional confirmation,
    not as the sole reason for entering.
  */

  const currentRSI =
    rsi(closes, 14);


  /*
    Recent range excludes current candle.
  */

  const recent =
    m5.slice(-11, -1);


  if (
    recent.length < 5
  ) {

    return {

      pair,

      signal:
        "WAIT",

      score: 0,

      detail:
        "Waiting for 5M range"
    };
  }


  const recentHigh =
    Math.max(
      ...recent.map(
        x =>
          Number(x.high)
      )
    );


  const recentLow =
    Math.min(
      ...recent.map(
        x =>
          Number(x.low)
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

      signal:
        "WAIT",

      score: 0,

      detail:
        "Invalid market range"
    };
  }


  /*
    5M bullish confirmation:
      - bullish candle
      - closes above previous high
      - price interacted with lower part of range
  */

  const bullish5 =
    close > open &&
    close > previousHigh &&
    low <=
      recentLow +
      range * 0.45;


  /*
    5M bearish confirmation.
  */

  const bearish5 =
    close < open &&
    close < previousLow &&
    high >=
      recentHigh -
      range * 0.45;


  /*
    Anti-late-entry protection.
  */

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


  const buyNotLate =
    bullishExtension <=
    0.80;


  const sellNotLate =
    bearishExtension <=
    0.80;


  /*
    Higher timeframe alignment.
  */

  const higherBullish =
    b12.bias === "BULLISH" &&
    b1.bias === "BULLISH";


  const higherBearish =
    b12.bias === "BEARISH" &&
    b1.bias === "BEARISH";


  /*
    BUY
  */

  if (
    higherBullish &&
    bullish5 &&
    buyNotLate &&
    currentRSI >= 50 &&
    currentRSI <= 75
  ) {

    const entry =
      close;


    const sl =
      recentLow;


    const risk =
      entry - sl;


    if (
      risk <= 0
    ) {

      return {

        pair,

        signal:
          "WAIT",

        score: 0,

        detail:
          "Invalid BUY risk"
      };
    }


    const tp =
      entry +
      risk * 2;


    return {

      pair,

      signal:
        "STRONG BUY",

      entry:
        Number(
          entry.toFixed(5)
        ),

      stopLoss:
        Number(
          sl.toFixed(5)
        ),

      takeProfit:
        Number(
          tp.toFixed(5)
        ),

      score: 5,

      detail:
        `12H ${b12.bias} ✓ 1H ${b1.bias} ✓ 5M confirmation ✓ RSI ${currentRSI.toFixed(1)} ✓ SMC`
    };
  }


  /*
    SELL
  */

  if (
    higherBearish &&
    bearish5 &&
    sellNotLate &&
    currentRSI >= 25 &&
    currentRSI <= 50
  ) {

    const entry =
      close;


    const sl =
      recentHigh;


    const risk =
      sl - entry;


    if (
      risk <= 0
    ) {

      return {

        pair,

        signal:
          "WAIT",

        score: 0,

        detail:
          "Invalid SELL risk"
      };
    }


    const tp =
      entry -
      risk * 2;


    return {

      pair,

      signal:
        "STRONG SELL",

      entry:
        Number(
          entry.toFixed(5)
        ),

      stopLoss:
        Number(
          sl.toFixed(5)
        ),

      takeProfit:
        Number(
          tp.toFixed(5)
        ),

      score: 5,

      detail:
        `12H ${b12.bias} ✓ 1H ${b1.bias} ✓ 5M confirmation ✓ RSI ${currentRSI.toFixed(1)} ✓ SMC`
    };
  }


  return {

    pair,

    signal:
      "WAIT",

    score: 0,

    detail:
      `12H ${b12.bias} | 1H ${b1.bias} | RSI ${currentRSI.toFixed(1)} | Waiting for 5M confirmation`
  };
}


/* =========================================================
   TELEGRAM
========================================================= */

async function notify(
  signal
) {

  if (
    !alertsEnabled
  ) {

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


  if (
    !response.ok
  ) {

    throw new Error(
      "Telegram HTTP " +
      response.status
    );
  }
}


/* =========================================================
   UPDATE DATA WAIT
========================================================= */

function setAllDataWait(
  message
) {

  for (
    const pair of pairs
  ) {

    state.pairs[pair] = {

      pair,

      signal:
        "DATA WAIT",

      score: 0,

      detail:
        message,

      updatedAt:
        new Date().toISOString()
    };
  }
}


/* =========================================================
   SCAN
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

  state.api.requestsThisScan =
    0;


  try {

    /*
      Don't make another API request while
      Twelve Data has us rate limited.
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


      setAllDataWait(
        `Twelve Data rate-limit cooldown (${seconds}s)`
      );


      return;
    }


    console.log(
      "Starting market scan..."
    );


    /*
      Get all 1H data in ONE batch.

      7 symbols = 7 API credits.
    */

    const hourly =
      await getCachedBatch(
        pairs,
        "1h"
      );


    /*
      Get all 5M data in ONE batch.

      7 symbols = 7 API credits,
      but this only happens every 20 minutes
      because of the cache.
    */

    const fiveMinute =
      await getCachedBatch(
        pairs,
        "5min"
      );


    /*
      Process every pair locally.
    */

    for (
      const pair of pairs
    ) {

      try {

        const h1 =
          hourly[pair];


        const m5 =
          fiveMinute[pair];


        /*
          Handle individual API errors.
        */

        if (
          !Array.isArray(h1)
        ) {

          state.pairs[pair] = {

            pair,

            signal:
              "DATA WAIT",

            score: 0,

            detail:
              h1?.error ||
              "1H market data unavailable",

            updatedAt:
              new Date().toISOString()
          };

          continue;
        }


        if (
          !Array.isArray(m5)
        ) {

          state.pairs[pair] = {

            pair,

            signal:
              "DATA WAIT",

            score: 0,

            detail:
              m5?.error ||
              "5M market data unavailable",

            updatedAt:
              new Date().toISOString()
          };

          continue;
        }


        const h12 =
          build12HCandles(
            h1
          );


        const signal =
          createSignal(
            pair,
            h12,
            h1,
            m5
          );


        signal.updatedAt =
          new Date().toISOString();


        state.pairs[pair] =
          signal;


        /*
          Send Telegram only for a NEW signal.

          This prevents the bot from sending
          the same BUY/SELL every scan.
        */

        if (
          signal.signal ===
            "STRONG BUY" ||
          signal.signal ===
            "STRONG SELL"
        ) {

          const signalKey =
            `${signal.signal}:${signal.entry}:${signal.stopLoss}:${signal.takeProfit}`;


          if (
            lastSignal[pair] !==
            signalKey
          ) {

            lastSignal[pair] =
              signalKey;


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
        }


      } catch (
        pairError
      ) {

        console.error(
          pair,
          pairError.message
        );


        state.pairs[pair] = {

          pair,

          signal:
            "DATA WAIT",

          score: 0,

          detail:
            pairError.message,

          updatedAt:
            new Date().toISOString()
        };
      }
    }


    state.lastScan =
      new Date().toISOString();


    console.log(
      "Scan completed.",
      "API requests:",
      state.api.requestsThisScan
    );


  } catch (
    error
  ) {

    console.error(
      "SCAN ERROR:",
      error.message
    );


    state.api.lastError =
      error.message;


    /*
      If we hit 429, show a clear message
      rather than pretending the market is offline.
    */

    if (
      /429|rate.limit|credit/i
        .test(error.message)
    ) {

      state.api.status =
        "RATE LIMITED";

      setAllDataWait(
        error.message
      );

    } else {

      setAllDataWait(
        "Market data temporarily unavailable"
      );
    }


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

      system:
        "Online",

      lastScan:
        state.lastScan,

      timeframe:
        TIMEFRAME,

      pairs:
        state.pairs,

      api: {

        status:
          state.api.status,

        lastError:
          state.api.lastError,

        last429:
          state.api.last429,

        cooldownUntil:
          state.api.cooldownUntil,

        requestsThisScan:
          state.api.requestsThisScan,

        totalRequests:
          state.api.totalRequests
      }
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
   HEALTH CHECK
========================================================= */

app.get(
  "/health",
  (req, res) => {

    res.json({

      ok: true,

      system:
        "Trading Cloud Monitor",

      time:
        new Date().toISOString()
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

    console.log(
      "API key:",
      API_KEY
        ? "configured"
        : "NOT CONFIGURED"
    );


    /*
      Start first scan.

      After that, scan every 20 minutes.
    */

    scan();

    setInterval(
      scan,
      POLL_MS
    );
  }
);
