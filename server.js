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

const INTERVAL =
  process.env.TIMEFRAME || "5min";

/*
  IMPORTANT:

  We deliberately scan every 15 minutes instead of every
  5 minutes for now.

  This reduces Twelve Data usage substantially while we
  stabilize the system.
*/
const POLL_MS = Math.max(
  900000,
  Number(process.env.POLL_MS || 900000)
);

/*
  Delay between API requests.

  This prevents several requests from being fired
  at Twelve Data at exactly the same moment.
*/
const REQUEST_DELAY_MS = Math.max(
  1000,
  Number(process.env.REQUEST_DELAY_MS || 1500)
);

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
   SIGNAL / ALERT STATE
========================================================= */

const lastSignal = {};

let alertsEnabled = true;


/* =========================================================
   CACHE
========================================================= */

const tfCache = new Map();

/*
  1H candles are cached for one hour.

  5M candles are cached for 15 minutes because the scanner
  currently runs every 15 minutes.
*/
const TF_CACHE_MS = {

  "1h":
    60 * 60 * 1000,

  "5min":
    15 * 60 * 1000
};


/* =========================================================
   API COOLDOWN
========================================================= */

/*
  If Twelve Data returns HTTP 429, we stop making requests
  for five minutes.

  This prevents the bot from repeatedly hitting the limit.
*/
const API_COOLDOWN_MS =
  5 * 60 * 1000;

let apiCooldownUntil = 0;


/* =========================================================
   UTILITY
========================================================= */

function sleep(ms) {

  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}


/* =========================================================
   EMA
========================================================= */

function ema(a, p) {

  if (!a.length) {
    return 0;
  }

  const k =
    2 / (p + 1);

  let e = a[0];

  for (
    let i = 1;
    i < a.length;
    i++
  ) {

    e =
      a[i] * k +
      e * (1 - k);
  }

  return e;
}


/* =========================================================
   RSI
========================================================= */

function rsi(a, p = 14) {

  if (
    a.length <
    p + 1
  ) {

    return 50;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = a.length - p;
    i < a.length;
    i++
  ) {

    const difference =
      a[i] - a[i - 1];

    if (difference >= 0) {

      gains += difference;

    } else {

      losses -= difference;
    }
  }

  if (!losses) {
    return 100;
  }

  return 100 -
    100 /
    (
      1 +
      (gains / p) /
      (losses / p)
    );
}


/* =========================================================
   SMC
========================================================= */

function smc(c) {

  if (c.length < 20) {

    return {

      bias: "NEUTRAL",

      bos: false,

      sweep: false,

      strength: "WEAK"
    };
  }


  const highs =
    c.map(x => +x.high);

  const lows =
    c.map(x => +x.low);

  const closes =
    c.map(x => +x.close);


  /*
    Current candle and previous two candles are excluded
    from the structure range.
  */

  const recentHigh =
    Math.max(
      ...highs.slice(-20, -3)
    );

  const recentLow =
    Math.min(
      ...lows.slice(-20, -3)
    );


  const last =
    c.at(-1);

  const previous =
    c.at(-2);


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
    (
      lastClose >
      lastOpen
        ? 1
        : 0
    ) +
    (
      previousClose >
      previousOpen
        ? 1
        : 0
    );


  const bearishCandles =
    (
      lastClose <
      lastOpen
        ? 1
        : 0
    ) +
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
   TWELVE DATA REQUEST
========================================================= */

async function fetchCandles(
  pair,
  interval = INTERVAL
) {

  if (!API_KEY) {

    state.api.status =
      "NOT CONFIGURED";

    throw Error(
      "TWELVE_DATA_API_KEY is not configured"
    );
  }


  /*
    Global cooldown.

    If one request gets HTTP 429, no other pair should
    immediately hammer the API.
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

    throw Error(
      `Twelve Data rate-limit cooldown (${seconds}s)`
    );
  }


  /*
    Keep the request sizes reasonable.

    1H needs more candles because we construct 12H
    candles from the hourly data.
  */

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


  /*
    Twelve Data rate limit.
  */

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


    throw Error(
      "Twelve Data HTTP 429 - API limit reached"
    );
  }


  if (!response.ok) {

    state.api.status =
      "API ERROR";

    state.api.lastError =
      "Twelve Data HTTP " +
      response.status;


    throw Error(
      "Twelve Data HTTP " +
      response.status
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
      /limit|credit|rate/i
        .test(message)
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
        message;
    }


    throw Error(message);
  }


  if (
    !data.values ||
    !data.values.length
  ) {

    throw Error(
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
   CACHED DATA
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


  /*
    Wait between requests so we don't burst the API.
  */

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

      time: now
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

    /*
      Don't create a 12H candle from an incomplete
      period. Eight hourly candles is the minimum
      we accept for now.
    */

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
      new Date(
        a.datetime
      ) -
      new Date(
        b.datetime
      )
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

  if (
    !h12?.length ||
    !h1?.length ||
    !m5?.length
  ) {

    return {

      pair,

      signal: "WAIT",

      score: 0,

      detail:
        "Not enough timeframe data"
    };
  }


  const b12 =
    smc(h12);

  const b1 =
    smc(h1);


  const last =
    m5.at(-1);

  const previous =
    m5.at(-2);


  if (
    !last ||
    !previous
  ) {

    return {

      pair,

      signal: "WAIT",

      score: 0,

      detail:
        "Not enough 5M candles"
    };
  }


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


  /*
    Previous 10 candles.

    Current candle is deliberately excluded.
  */

  const recent =
    m5.slice(-11, -1);


  if (
    recent.length < 5
  ) {

    return {

      pair,

      signal: "WAIT",

      score: 0,

      detail:
        "Not enough 5M range candles"
    };
  }


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


  /*
    Bullish confirmation.

    The current candle must:

    1. Close bullish
    2. Break previous candle high
    3. Have interacted with the lower part of the range
  */

  const bullish5 =
    close > open &&
    close > previousHigh &&
    low <=
      recentLow +
      range * 0.45;


  /*
    Bearish confirmation.

    The current candle must:

    1. Close bearish
    2. Break previous candle low
    3. Have interacted with the upper part of the range
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


  const buyNotExtended =
    bullishExtension <=
    0.80;


  const sellNotExtended =
    bearishExtension <=
    0.80;


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

    const sl =
      recentLow;


    const risk =
      close - sl;


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


    const tp =
      close +
      risk * 2;


    return {

      pair,

      signal:
        "STRONG BUY",

      entry:
        +close.toFixed(5),

      stopLoss:
        +sl.toFixed(5),

      takeProfit:
        +tp.toFixed(5),

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

    const sl =
      recentHigh;


    const risk =
      sl - close;


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


    const tp =
      close -
      risk * 2;


    return {

      pair,

      signal:
        "STRONG SELL",

      entry:
        +close.toFixed(5),

      stopLoss:
        +sl.toFixed(5),

      takeProfit:
        +tp.toFixed(5),

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

    throw Error(
      "Telegram HTTP " +
      response.status
    );
  }
}


/* =========================================================
   SCAN
========================================================= */

async function scan() {

  /*
    Prevent overlapping scans.

    This is important because a slow API request must not
    cause another scan to start on top of it.
  */

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
      If the API is currently rate limited, don't loop
      through all seven pairs generating seven identical
      errors.
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


      for (
        const pair of pairs
      ) {

        state.pairs[pair] = {

          pair,

          signal:
            "DATA WAIT",

          score: 0,

          detail:
            `Twelve Data rate limit cooldown (${seconds}s)`,

          updatedAt:
            new Date().toISOString()
        };
      }


      return;
    }


    /*
      ======================================================
      PROCESS PAIRS ONE AT A TIME
      ======================================================
    */

    for (
      const pair of pairs
    ) {

      try {

        /*
          First get 1H.

          The 12H timeframe is constructed locally from
          the hourly candles, saving a separate 12H request.
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
          h12.length < 20 ||
          h1.length < 20
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


        /*
          Determine higher-timeframe direction BEFORE
          requesting 5M data.
        */

        const b12 =
          smc(h12);

        const b1 =
          smc(h1);


        const higherBullish =
          b12.bias === "BULLISH" &&
  
