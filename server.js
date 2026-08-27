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

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN;

const TELEGRAM_CHAT_ID =
  process.env.TELEGRAM_CHAT_ID;

/*
  We scan the 5-minute timeframe every 15 minutes.

  This keeps the daily API usage close to:

  7 pairs x 4 scans/hour x 24 hours
  = 672 API credits/day
*/
const SCAN_INTERVAL_MS = Math.max(
  15 * 60 * 1000,
  Number(process.env.POLL_MS || 900000)
);

/*
  Refresh higher timeframe data every 4 hours.

  7 pairs x 6 refreshes/day
  = 42 API credits/day

  Total estimated:
  672 + 42 = 714/day
*/
const HIGHER_TF_REFRESH_MS = 4 * 60 * 60 * 1000;

/*
  Minimum delay between API calls.
*/
const REQUEST_DELAY_MS = Math.max(
  1500,
  Number(process.env.REQUEST_DELAY_MS || 1500)
);

/*
  Twelve Data Basic:
  8 API credits/minute.

  We deliberately use only 7 symbols per batch.
*/
const MAX_SYMBOLS_PER_BATCH = 7;

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

    totalRequests: 0,

    creditsUsedLastScan: 0,

    creditsLeftLastResponse: null,

    last5mUpdate: null,

    last1hUpdate: null
  }

};


/* =========================================================
   ALERT STATE
========================================================= */

let alertsEnabled = true;

const lastSignal = {};


/* =========================================================
   CACHE
========================================================= */

/*
  Each pair has its own cached data.

  5M:
  refreshed every 15 minutes.

  1H:
  refreshed every 4 hours.
*/

const cache = {};

for (const pair of pairs) {

  cache[pair] = {

    m5: null,

    m5Time: 0,

    h1: null,

    h1Time: 0
  };

}


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
    resolve => setTimeout(resolve, ms)
  );

}


function nowISO() {

  return new Date().toISOString();

}


function isCooldownActive() {

  return Date.now() < apiCooldownUntil;

}


function cooldownSeconds() {

  return Math.max(
    0,
    Math.ceil(
      (
        apiCooldownUntil -
        Date.now()
      ) / 1000
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

  if (values.length < period) {
    return values[values.length - 1];
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
    let i =
      values.length - period;
    i < values.length;
    i++
  ) {

    const change =
      values[i] -
      values[i - 1];

    if (change > 0) {

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
    (
      100 /
      (1 + rs)
    );

}


/* =========================================================
   SMC / MARKET STRUCTURE
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
      candle => +candle.high
    );

  const lows =
    candles.map(
      candle => +candle.low
    );


  /*
    Exclude current and previous candles.
  */

  const structure =
    candles.slice(
      -20,
      -2
    );


  const recentHigh =
    Math.max(
      ...structure.map(
        candle => +candle.high
      )
    );

  const recentLow =
    Math.min(
      ...structure.map(
        candle => +candle.low
      )
    );


  const last =
    candles[candles.length - 1];

  const previous =
    candles[candles.length - 2];


  const close =
    +last.close;

  const open =
    +last.open;

  const previousClose =
    +previous.close;

  const previousOpen =
    +previous.open;


  const bullishBOS =
    close >
    recentHigh;

  const bearishBOS =
    close <
    recentLow;


  const bullishSweep =
    +last.low <
      recentLow &&
    close >
      recentLow;


  const bearishSweep =
    +last.high >
      recentHigh &&
    close <
      recentHigh;


  const bullishCandles =
    (
      close > open
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
      close < open
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
   TWELVE DATA BATCH REQUEST
========================================================= */

async function fetchBatchCandles(
  interval,
  outputSize
) {

  if (!API_KEY) {

    state.api.status =
      "NOT CONFIGURED";

    throw new Error(
      "TWELVE_DATA_API_KEY is not configured"
    );

  }


  if (isCooldownActive()) {

    throw new Error(
      `Twelve Data rate-limit cooldown (${cooldownSeconds()}s)`
    );

  }


  const symbolList =
    pairs
      .slice(
        0,
        MAX_SYMBOLS_PER_BATCH
      )
      .join(",");


  const url =
    "https://api.twelvedata.com/time_series" +
    "?symbol=" +
    encodeURIComponent(symbolList) +
    "&interval=" +
    encodeURIComponent(interval) +
    "&outputsize=" +
    outputSize +
    "&order=ASC" +
    "&apikey=" +
    encodeURIComponent(API_KEY);


  state.api.requestsThisScan++;
  state.api.totalRequests++;


  console.log(
    `Twelve Data request: ${interval} / ${pairs.length} symbols`
  );


  const response =
    await fetch(url);


  const used =
    response.headers.get(
      "api-credits-used"
    );

  const left =
    response.headers.get(
      "api-credits-left"
    );


  if (used !== null) {

    state.api.creditsUsedLastScan =
      Number(used);

  }


  if (left !== null) {

    state.api.creditsLeftLastResponse =
      Number(left);

  }


  /*
    Rate limit.
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
      nowISO();

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


  /*
    Some Twelve Data responses can contain
    an error object instead of candle data.
  */

  if (
    data &&
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
        nowISO();

      state.api.cooldownUntil =
        new Date(
          apiCooldownUntil
        ).toISOString();

      state.api.lastError =
        message;

    }


    throw new Error(message);

  }


  state.api.status =
    "CONNECTED";

  state.api.lastError =
    null;


  return data;

}


/* =========================================================
   NORMALIZE BATCH RESPONSE
========================================================= */

function normalizeBatchResponse(
  data
) {

  const result = {};


  /*
    If Twelve Data returns:

    {
      "EUR/USD": {
        "values": [...]
      }
    }

    we process it directly.
  */

  for (
    const pair of pairs
  ) {

    const item =
      data[pair];


    if (
      item &&
      Array.isArray(
        item.values
      )
    ) {

      result[pair] =
        item.values
          .slice()
          .reverse();

      continue;
    }


    /*
      Some responses may normalize
      the symbol key.
    */

    const alternative =
      Object.keys(data)
        .find(
          key =>
            key.replace(
              /\s/g,
              ""
            ) ===
            pair.replace(
              /\s/g,
              ""
            )
        );


    if (
      alternative &&
      data[alternative] &&
      Array.isArray(
        data[alternative].values
      )
    ) {

      result[pair] =
        data[alternative]
          .values
          .slice()
          .reverse();

    }

  }


  return result;

}


/* =========================================================
   UPDATE HIGHER TIMEFRAME
========================================================= */

async function updateHigherTimeframe() {

  if (
    isCooldownActive()
  ) {

    return false;
  }


  try {

    await sleep(
      REQUEST_DELAY_MS
    );


    const data =
      await fetchBatchCandles(
        "1h",
        300
      );


    const normalized =
      normalizeBatchResponse(
        data
      );


    let updated = 0;


    for (
      const pair of pairs
    ) {

      if (
        normalized[pair] &&
        normalized[pair].length >= 20
      ) {

        cache[pair].h1 =
          normalized[pair];

        cache[pair].h1Time =
          Date.now();

        updated++;

      }

    }


    state.api.last1hUpdate =
      nowISO();


    console.log(
      `1H data updated for ${updated}/${pairs.length} pairs`
    );


    return updated > 0;

  } catch (error) {

    console.error(
      "1H update error:",
      error.message
    );

    return false;

  }

}


/* =========================================================
   UPDATE 5M DATA
========================================================= */

async function updateFiveMinuteData() {

  if (
    isCooldownActive()
  ) {

    return false;
  }


  try {

    await sleep(
      REQUEST_DELAY_MS
    );


    const data =
      await fetchBatchCandles(
        "5min",
        120
      );


    const normalized =
      normalizeBatchResponse(
        data
      );


    let updated = 0;


    for (
      const pair of pairs
    ) {

      if (
        normalized[pair] &&
        normalized[pair].length >= 20
      ) {

        cache[pair].m5 =
          normalized[pair];

        cache[pair].m5Time =
          Date.now();

        updated++;

      }

    }


    state.api.last5mUpdate =
      nowISO();


    console.log(
      `5M data updated for ${updated}/${pairs.length} pairs`
    );


    return updated > 0;

  } catch (error) {

    console.error(
      "5M update error:",
      error.message
    );

    return false;

  }

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
      ).padStart(
        2,
        "0"
      );

    const day =
      String(
        date.getUTCDate()
      ).padStart(
        2,
        "0"
      );

    const hour =
      date.getUTCHours();


    const bucketHour =
      hour < 12
        ? 0
        : 12;


    const key =
      `${year}-${month}-${day} ${String(
        bucketHour
      ).padStart(
        2,
        "0"
      )}:00:00`;


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
      Require at least 8 hourly candles
      so we don't build a very incomplete
      12H candle.
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
          (
            sum,
            x
          ) =>
            sum +
            (
              +x.volume ||
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

function analyzePair(
  pair
) {

  const m5 =
    cache[pair].m5;

  const h1 =
    cache[pair].h1;


  if (
    !m5 ||
    !h1
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


  const h12 =
    build12HCandles(
      h1
    );


  if (
    h12.length < 20
  ) {

    return {

      pair,

      signal:
        "DATA WAIT",

      score: 0,

      detail:
        "Waiting for enough 12H candles"
    };

  }


  if (
    m5.length < 20
  ) {

    return {

      pair,

      signal:
        "DATA WAIT",

      score: 0,

      detail:
        "Waiting for enough 5M candles"
    };

  }


  const b12 =
    smc(h12);

  const b1 =
    smc(h1);


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


  /*
    Last 10 completed candles before
    the current candle.
  */

  const recent =
    m5.slice(
      -11,
      -1
    );


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

      signal:
        "WAIT",

      score: 0,

      detail:
        "Invalid 5M range"
    };

  }


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
    Stronger confirmation requires
    structure confirmation on both
    higher timeframes.
  */

  const strongBullish =
    higherBullish &&
    (
      b12.strength === "STRONG" ||
      b12.strength === "CONFIRMED"
    ) &&
    (
      b1.strength === "STRONG" ||
      b1.strength === "CONFIRMED"
    );


  const strongBearish =
    higherBearish &&
    (
      b12.strength === "STRONG" ||
      b12.strength === "CONFIRMED"
    ) &&
    (
      b1.strength === "STRONG" ||
      b1.strength === "CONFIRMED"
    );


  /*
    5M bullish confirmation.

    We don't buy simply because the market
    is already rising.

    The candle must show:
    - bullish close
    - break of previous high
    - interaction with lower portion
      of the recent range
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

    If price has already travelled too far
    from the pullback area, don't chase it.
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
    bullishExtension <= 0.80;


  const sellNotExtended =
    bearishExtension <= 0.80;


  /*
    RSI confirmation.
  */

  const closes =
    m5.map(
      x => +x.close
    );


  const currentRSI =
    rsi(
      closes,
      14
    );


  /*
    EMA confirmation.
  */

  const currentEMA20 =
    ema(
      closes,
      20
    );


  /*
    BUY
  */

  if (
    strongBullish &&
    bullish5 &&
    buyNotExtended &&
    currentRSI >= 50 &&
    currentRSI <= 72 &&
    close > currentEMA20
  ) {

    const stopLoss =
      recentLow;


    const risk =
      close -
      stopLoss;


    if (
      risk > 0
    ) {

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

        rsi:
          +currentRSI.toFixed(1),

        detail:
          `12H ${b12.bias} ✓ 1H ${b1.bias} ✓ 5M pullback/break ✓ RSI ${currentRSI.toFixed(1)} ✓ EMA ✓ SMC confirmed`
      };

    }

  }


  /*
    SELL
  */

  if (
    strongBearish &&
    bearish5 &&
    sellNotExtended &&
    currentRSI >= 28 &&
    currentRSI <= 50 &&
    close < currentEMA20
  ) {

    const stopLoss =
      recentHigh;


    const risk =
      stopLoss -
      close;


    if (
      risk > 0
    ) {

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

        rsi:
          +currentRSI.toFixed(1),

        detail:
          `12H ${b12.bias} ✓ 1H ${b1.bias} ✓ 5M pullback/break ✓ RSI ${currentRSI.toFixed(1)} ✓ EMA ✓ SMC confirmed`
      };

    }

  }


  /*
    No valid signal.
  */

  return {

    pair,

    signal:
      "WAIT",

    score: 0,

    rsi:
      +currentRSI.toFixed(1),

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
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {

    console.log(
      "Telegram not configured."
    );

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
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {

          method:
            "POST",

          headers: {

            "Content-Type":
              "application/json"

          },

          body:
            JSON.stringify({

              chat_id:
                TELEGRAM_CHAT_ID,

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


    console.log(
      `Telegram alert sent: ${signal.pair}`
    );

  } catch (error) {

    console.error(
      "Telegram error:",
      error.message
    );

  }

}


/* =========================================================
   ALERT DEDUPLICATION
========================================================= */

async function processSignal(
  signal
) {

  if (
    signal.signal !==
      "STRONG BUY" &&
    signal.signal !==
      "STRONG SELL"
  ) {

    return;

  }


  if (
    !alertsEnabled
  ) {

    return;

  }


  const key =
    signal.pair;


  const signature =
    `${signal.signal}:${signal.entry}:${signal.stopLoss}:${signal.takeProfit}`;


  /*
    Don't send the exact same signal repeatedly.
  */

  if (
    lastSignal[key] ===
    signature
  ) {

    return;

  }


  lastSignal[key] =
    signature;


  await notify(
    signal
  );

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
      If cooldown is active, don't make
      another API request.
    */

    if (
      isCooldownActive()
    ) {

      const seconds =
        cooldownSeconds();


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
            nowISO()

        };

      }


      return;

    }


    /*
      Update 5M data.

      One batch request = 7 symbol credits.
    */

    await updateFiveMinuteData();


    /*
      Analyze all pairs from cache.
    */

    for (
      const pair of pairs
    ) {

      const signal =
        analyzePair(
          pair
        );


      state.pairs[pair] = {

        ...signal,

        updatedAt:
          nowISO()

      };


      /*
        Telegram only receives
        new STRONG BUY/SELL signals.
      */

      await processSignal(
        signal
      );

    }


    state.lastScan =
      nowISO();


    console.log(
      `Scan complete. API requests this scan: ${state.api.requestsThisScan}`
    );

  } catch (error) {

    console.error(
      "Scan error:",
      error.message
    );


    for (
      const pair of pairs
    ) {

      if (
        !state.pairs[pair] ||
        !state.pairs[pair].signal ||
        state.pairs[pair].signal ===
          "DATA WAIT"
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

  } finally {

    state.scanning =
      false;

  }

}


/* =========================================================
   HIGHER TIMEFRAME SCHEDULER
========================================================= */

let lastHigherRefresh =
  0;


async function refreshHigherTimeframeIfNeeded() {

  const now =
    Date.now();


  if (
    now -
    lastHigherRefresh <
      HIGHER_TF_REFRESH_MS
  ) {

    return;

  }


  /*
    Mark immediately so multiple
    scans cannot trigger it.
  */

  lastHigherRefresh =
    now;


  console.log(
    "Refreshing 1H data..."
  );


  await updateHigherTimeframe();

}


/* =========================================================
   API STATUS
========================================================= */

app.get(
  "/api/status",
  (req, res) => {

    res.json({

      ok: true,

      lastScan:
        state.lastScan,

      timeframe:
        "5min",

      scanning:
        state.scanning,

      pairs:
        state.pairs,

      alertsEnabled,

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
          state.api.totalRequests,

        creditsUsedLastScan:
          state.api.creditsUsedLastScan,

        creditsLeftLastResponse:
          state.api.creditsLeftLastResponse,

        last5mUpdate:
          state.api.last5mUpdate,

        last1hUpdate:
          state.api.last1hUpdate

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

      ok: true,

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

    if (
      typeof req.body.enabled !==
      "boolean"
    ) {

      return res
        .status(400)
        .json({

          ok: false,

          error:
            "enabled must be true or false"

        });

    }


    alertsEnabled =
      req.body.enabled;


    console.log(
      `Alerts ${alertsEnabled ? "ON" : "OFF"}`
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

      status:
        "online",

      time:
        nowISO()

    });

  }
);


/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  async () => {

    console.log(
      "=========================================="
    );

    console.log(
      "Trading Cloud Monitor"
    );

    console.log(
      "=========================================="
    );

    console.log(
      "Server running on port:",
      PORT
    );

    console.log(
      "Pairs:",
      pairs.join(", ")
    );

    console.log(
      "5M scan:",
      SCAN_INTERVAL_MS / 60000,
      "minutes"
    );

    console.log(
      "1H refresh:",
      HIGHER_TF_REFRESH_MS / 3600000,
      "hours"
    );

    console.log(
      "API:",
      API_KEY
        ? "configured"
        : "NOT CONFIGURED"
    );

    console.log(
      "Telegram:",
      TELEGRAM_BOT_TOKEN &&
      TELEGRAM_CHAT_ID
        ? "configured"
        : "not configured"
    );


    /*
      First load higher timeframe data.

      Then perform the first scan.
    */

    await updateHigherTimeframe();

    await scan();

    /*
      Normal 15-minute scanner.
    */

    setInterval(
      async () => {

        await refreshHigherTimeframeIfNeeded();

        await scan();

      },
      SCAN_INTERVAL_MS
    );

  }
);
