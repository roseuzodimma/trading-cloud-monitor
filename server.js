const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TWELVE_DATA_API_KEY;
const INTERVAL = process.env.TIMEFRAME || "5min";
const POLL_MS = Math.max(
  300000,
  Number(process.env.POLL_MS || 300000)
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

const state = {
  lastScan: null,
  pairs: {},
  api: {
    status: "READY",
    lastError: null,
    last429: null
  }
};

const lastSignal = {};
const tfCache = new Map();

const TF_CACHE_MS = {
  "1h": 60 * 60 * 1000,
  "5min": 5 * 60 * 1000
};

/*
  When Twelve Data returns HTTP 429, don't immediately
  keep hitting the API.

  Five minutes is used as a local cooldown.
*/
let apiCooldownUntil = 0;
const API_COOLDOWN_MS = 5 * 60 * 1000;


/* =========================================================
   CACHE
========================================================= */

async function getCachedCandles(pair, interval) {

  const key = `${pair}:${interval}`;
  const now = Date.now();

  const cached = tfCache.get(key);

  if (
    cached &&
    now - cached.time < TF_CACHE_MS[interval]
  ) {
    return cached.data;
  }

  const data = await fetchCandles(pair, interval);

  tfCache.set(key, {
    data,
    time: now
  });

  return data;
}


/* =========================================================
   EMA
========================================================= */

function ema(a, p) {

  if (!a.length) return 0;

  const k = 2 / (p + 1);

  let e = a[0];

  for (let i = 1; i < a.length; i++) {
    e = a[i] * k + e * (1 - k);
  }

  return e;
}


/* =========================================================
   RSI
========================================================= */

function rsi(a, p = 14) {

  if (a.length < p + 1) {
    return 50;
  }

  let g = 0;
  let l = 0;

  for (let i = a.length - p; i < a.length; i++) {

    const d = a[i] - a[i - 1];

    if (d >= 0) {
      g += d;
    } else {
      l -= d;
    }
  }

  if (!l) {
    return 100;
  }

  return 100 - 100 / (
    1 + (g / p) / (l / p)
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

  const h = c.map(x => +x.high);
  const l = c.map(x => +x.low);
  const cl = c.map(x => +x.close);

  /*
    Exclude the current candle and the previous
    two candles from the structure range.
  */
  const recentHigh = Math.max(
    ...h.slice(-20, -3)
  );

  const recentLow = Math.min(
    ...l.slice(-20, -3)
  );

  const lastClose = cl.at(-1);
  const lastOpen = +c.at(-1).open;

  const prevClose = cl.at(-2);
  const prevOpen = +c.at(-2).open;

  const bullishBOS =
    lastClose > recentHigh;

  const bearishBOS =
    lastClose < recentLow;

  const bullishSweep =
    +c.at(-1).low < recentLow &&
    lastClose > recentLow;

  const bearishSweep =
    +c.at(-1).high > recentHigh &&
    lastClose < recentHigh;

  const bullishCandles =
    (lastClose > lastOpen ? 1 : 0) +
    (prevClose > prevOpen ? 1 : 0);

  const bearishCandles =
    (lastClose < lastOpen ? 1 : 0) +
    (prevClose < prevOpen ? 1 : 0);


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
   ORIGINAL EVALUATION FUNCTION
   Kept for compatibility.
========================================================= */

function evaluate(pair, c) {

  if (c.length < 80) {
    return {
      pair,
      signal: "WAIT",
      detail: "Not enough candles"
    };
  }

  const b = c.map(x => ({
    open: +x.open,
    high: +x.high,
    low: +x.low,
    close: +x.close
  }));

  const cl = b.map(x => x.close);

  const e20 = ema(
    cl.slice(-80),
    20
  );

  const e50 = ema(
    cl.slice(-80),
    50
  );

  const rs = rsi(
    cl.slice(-40),
    14
  );

  const x = b.at(-1);

  const look = b.slice(-21, -1);

  const res = Math.max(
    ...look.map(x => x.high)
  );

  const sup = Math.min(
    ...look.map(x => x.low)
  );


  let buy =
    (x.close > e20 && e20 > e50 ? 1 : 0) +
    (rs >= 55 && rs <= 72 ? 1 : 0) +
    (x.close > res && x.close > x.open ? 1 : 0) +
    (x.close > res ? 1 : 0) +
    (x.close > b.at(-2).close ? 1 : 0);


  let sell =
    (x.close < e20 && e20 < e50 ? 1 : 0) +
    (rs <= 45 && rs >= 28 ? 1 : 0) +
    (x.close < sup && x.close < x.open ? 1 : 0) +
    (x.close < sup ? 1 : 0) +
    (x.close < b.at(-2).close ? 1 : 0);


  if (
    buy >= 4 &&
    x.close > res
  ) {

    const entry = x.close;
    const sl = sup;
    const risk = entry - sl;
    const tp = entry + risk * 2;

    return {
      pair,
      signal: "STRONG BUY",
      score: buy,
      entry: +entry.toFixed(5),
      stopLoss: +sl.toFixed(5),
      takeProfit: +tp.toFixed(5),
      detail:
        `Trend ✓ RSI ${rs.toFixed(1)} ✓ Breakout ✓ R:R 1:2`
    };
  }


  if (
    sell >= 4 &&
    x.close < sup
  ) {

    const entry = x.close;
    const sl = res;
    const risk = sl - entry;
    const tp = entry - risk * 2;

    return {
      pair,
      signal: "STRONG SELL",
      score: sell,
      entry: +entry.toFixed(5),
      stopLoss: +sl.toFixed(5),
      takeProfit: +tp.toFixed(5),
      detail:
        `Trend ✓ RSI ${rs.toFixed(1)} ✓ Breakdown ✓ R:R 1:2`
    };
  }


  return {
    pair,
    signal: "WAIT",
    score: Math.max(buy, sell),
    detail:
      `BUY ${buy}/5 • SELL ${sell}/5`
  };
}


/* =========================================================
   TWELVE DATA
========================================================= */

async function fetchCandles(pair, interval = INTERVAL) {

  if (!API_KEY) {
    throw Error(
      "TWELVE_DATA_API_KEY is not configured"
    );
  }


  /*
    Don't repeatedly call Twelve Data while
    we're inside the local 429 cooldown.
  */
  if (Date.now() < apiCooldownUntil) {

    const remaining = Math.ceil(
      (apiCooldownUntil - Date.now()) / 1000
    );

    throw Error(
      `Twelve Data rate-limit cooldown (${remaining}s)`
    );
  }


  /*
    1H requires more candles because we use them
    to construct the 12H timeframe locally.
  */
  const outputSize =
    interval === "1h"
      ? 300
      : 100;


  const url =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${encodeURIComponent(pair)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${outputSize}` +
    `&apikey=${encodeURIComponent(API_KEY)}`;


  const response = await fetch(url);


  if (response.status === 429) {

    apiCooldownUntil =
      Date.now() + API_COOLDOWN_MS;

    state.api.status = "RATE LIMITED";
    state.api.last429 =
      new Date().toISOString();
    state.api.lastError =
      "Twelve Data HTTP 429";

    throw Error(
      "Twelve Data HTTP 429 - API limit reached"
    );
  }


  if (!response.ok) {

    throw Error(
      "Twelve Data HTTP " +
      response.status
    );
  }


  const data = await response.json();


  if (data.status === "error") {

    /*
      Some Twelve Data API errors can contain
      rate-limit information even without HTTP 429.
    */
    const message =
      data.message ||
      "Twelve Data error";


    if (
      /limit|credit|rate/i.test(message)
    ) {

      apiCooldownUntil =
        Date.now() + API_COOLDOWN_MS;

      state.api.status =
        "RATE LIMITED";

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


  state.api.status = "CONNECTED";
  state.api.lastError = null;


  return data.values
    .slice()
    .reverse();
}


/* =========================================================
   BUILD 12H CANDLES FROM 1H CANDLES
========================================================= */

function build12HCandles(hourly) {

  if (
    !Array.isArray(hourly) ||
    hourly.length < 12
  ) {
    return [];
  }


  const groups = new Map();


  for (const candle of hourly) {

    const date =
      new Date(candle.datetime);


    if (Number.isNaN(date.getTime())) {
      continue;
    }


    /*
      UTC 12-hour buckets:

      00:00 -> 11:00
      12:00 -> 23:00
    */

    const year =
      date.getUTCFullYear();

    const month =
      String(date.getUTCMonth() + 1)
        .padStart(2, "0");

    const day =
      String(date.getUTCDate())
        .padStart(2, "0");

    const hour =
      date.getUTCHours();

    const bucketHour =
      hour < 12 ? 0 : 12;


    const key =
      `${year}-${month}-${day} ${String(bucketHour).padStart(2, "0")}:00:00`;


    if (!groups.has(key)) {
      groups.set(key, []);
    }


    groups.get(key).push(candle);
  }


  const result = [];


  for (const [datetime, candles] of groups) {

    if (candles.length < 8) {
      continue;
    }


    candles.sort(
      (a, b) =>
        new Date(a.datetime) -
        new Date(b.datetime)
    );


    const first = candles[0];
    const last = candles[candles.length - 1];


    result.push({

      datetime,

      open: +first.open,

      high: Math.max(
        ...candles.map(x => +x.high)
      ),

      low: Math.min(
        ...candles.map(x => +x.low)
      ),

      close: +last.close,

      volume: candles.reduce(
        (sum, x) =>
          sum + (+x.volume || 0),
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
   TELEGRAM
========================================================= */

async function notify(s) {

  if (!alertsEnabled) {
    return;
  }

  const token =
    process.env.TELEGRAM_BOT_TOKEN;

  const chatId =
    process.env.TELEGRAM_CHAT_ID;


  if (!token || !chatId) {
    return;
  }


  const message =
`🚨 ${s.signal}: ${s.pair}
Entry: ${s.entry}
🛑 Stop Loss: ${s.stopLoss}
🎯 Take Profit: ${s.takeProfit}
⭐ Score: ${s.score}/5
📊 ${s.detail}`;


  const response =
    await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",

        headers: {
          "content-type":
            "application/json"
        },

        body: JSON.stringify({
          chat_id: chatId,
          text: message
        })
      }
    );


  if (!response.ok) {

    throw Error(
      "Telegram HTTP " +
      response.status
    );
  }
}


/* =========================================================
   MULTI TIMEFRAME SIGNAL
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


  const b12 = smc(h12);
  const b1 = smc(h1);


  const last =
    m5[m5.length - 1];

  const prev =
    m5[m5.length - 2];


  if (!last || !prev) {

    return {
      pair,
      signal: "WAIT",
      score: 0,
      detail:
        "Not enough 5M candles"
    };
  }


  const close = +last.close;
  const open = +last.open;
  const high = +last.high;
  const low = +last.low;


  const prevHigh =
    +prev.high;

  const prevLow =
    +prev.low;


  /*
    IMPORTANT:

    -11,-1 excludes the current candle.

    Therefore the current candle cannot
    artificially increase recentHigh or
    recentLow.
  */

  const recent =
    m5.slice(-11, -1);


  if (recent.length < 5) {

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
    recentHigh - recentLow;


  if (range <= 0) {

    return {
      pair,
      signal: "WAIT",
      score: 0,
      detail:
        "Invalid 5M range"
    };
  }


  /*
    Bullish 5M confirmation:

    Price pulls back into the lower
    portion of the recent range,
    then closes bullish and breaks
    the previous candle high.
  */

  const bullish5 =
    close > open &&
    close > prevHigh &&
    low <=
      recentLow +
      range * 0.45;


  /*
    Bearish 5M confirmation:

    Price pulls upward into the upper
    portion of the range,
    then closes bearish and breaks
    previous candle low.
  */

  const bearish5 =
    close < open &&
    close < prevLow &&
    high >=
      recentHigh -
      range * 0.45;


  /*
    Overextension protection.

    The current candle IS included in the
    extension calculation, because we are
    measuring where the current entry sits
    inside the previous 10-candle range.

    That is intentional.

    recentHigh/recentLow themselves exclude
    the current candle.
  */

  const bullishExtension =
    (close - recentLow) /
    range;


  const bearishExtension =
    (recentHigh - close) /
    range;


  const buyNotExtended =
    bullishExtension <= 0.80;


  const sellNotExtended =
    bearishExtension <= 0.80;


  /*
    BUY:
    12H bullish
    +
    1H bullish
    +
    5M confirmation
    +
    not overextended
  */

  if (

    b12.bias === "BULLISH" &&

    (
      b12.strength === "STRONG" ||
      b12.strength === "CONFIRMED"
    ) &&

    b1.bias === "BULLISH" &&

    (
      b1.strength === "STRONG" ||
      b1.strength === "CONFIRMED"
    ) &&

    bullish5 &&

    buyNotExtended

  ) {

    const sl =
      recentLow;


    const risk =
      close - sl;


    if (risk <= 0) {

      return {
        pair,
        signal: "WAIT",
        score: 0,
        detail:
          "Invalid BUY risk"
      };
    }


    const tp =
      close + risk * 2;


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


  /*
    SELL:
    12H bearish
    +
    1H bearish
    +
    5M confirmation
    +
    not overextended
  */

  if (

    b12.bias === "BEARISH" &&

    (
      b12.strength === "STRONG" ||
      b12.strength === "CONFIRMED"
    ) &&

    b1.bias === "BEARISH" &&

    (
      b1.strength === "STRONG" ||
      b1.strength === "CONFIRMED"
    ) &&

    bearish5 &&

    sellNotExtended

  ) {

    const sl =
      recentHigh;


    const risk =
      sl - close;


    if (risk <= 0) {

      return {
        pair,
        signal: "WAIT",
        score: 0,
        detail:
          "Invalid SELL risk"
      };
    }


    const tp =
      close - risk * 2;


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
   SCAN
========================================================= */

async function scan() {

  state.api.status = "SCANNING";


  for (const p of pairs) {

    try {

      /*
        STEP 1

        Only fetch 1H.

        12H will be built locally from
        the 1H candles.
      */

      const h1 =
        await getCachedCandles(
          p,
          "1h"
        );


      const h12 =
        build12HCandles(h1);


      if (
        h12.length < 20 ||
        h1.length < 20
      ) {

        state.pairs[p] = {

          pair: p,

          signal: "WAIT",

          score: 0,

          detail:
            "Waiting for enough 1H/12H candles",

          updatedAt:
            new Date().toISOString()
        };

        continue;
      }


      /*
        Check the higher timeframes FIRST.

        This means we don't waste a 5M request
        if the 12H and 1H directions disagree.
      */

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
        If higher timeframes don't agree,
        there is no reason to request 5M.
      */

      if (
        !higherBullish &&
        !higherBearish
      ) {

        state.pairs[p] = {

          pair: p,

          signal: "WAIT",

          score: 0,

          detail:
            `12H ${b12.bias} | 1H ${b1.bias} | Higher timeframes not aligned`,

          updatedAt:
            new Date().toISOString()
        };

        continue;
      }


      /*
        STEP 2

        Only now fetch 5M.
      */

      const m5 =
        await getCachedCandles(
          p,
          "5min"
        );


      const signal =
        multiTimeframeSignal(
          p,
          h12,
          h1,
          m5
        );


      state.pairs[p] = {

        ...signal,

        updatedAt:
          new Date().toISOString()
      };


      /*
        Prevent duplicate Telegram alerts
        for the same direction.
      */

      if (

        (
          signal.signal === "STRONG BUY" ||
          signal.signal === "STRONG SELL"
        ) &&

        lastSignal[p] !==
          signal.signal

      ) {

        lastSignal[p] =
          signal.signal;

        try {

          await notify(signal);

        } catch (telegramError) {

          console.error(
            "Telegram error:",
            telegramError.message
          );
        }
      }

    } catch (e) {

      state.pairs[p] = {

        pair: p,

        signal:
          "OFFLINE",

        detail:
          e.message,

        updatedAt:
          new Date().toISOString()
      };

      console.error(
        `${p}: ${e.message}`
      );
    }
  }


  state.lastScan =
    new Date().toISOString();


  state.api.lastError =
    state.api.lastError || null;
}


/* =========================================================
   DASHBOARD STATUS
========================================================= */

app.get(
  "/api/status",
  (q, r) => {

    r.json({

      timeframe:
        INTERVAL,

      lastScan:
        state.lastScan,

      api:
        state.api,

      pairs:
        state.pairs
    });
  }
);


/* =========================================================
   TELEGRAM TEST
========================================================= */

app.get(
  "/api/test-alert",
  async (q, r) => {

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


      r.json({

        ok: true,

        message:
          "Test alert sent."
      });

    } catch (e) {

      r.status(500).json({

        ok: false,

        error:
          e.message
      });
    }
  }
);


/* =========================================================
   ALERT STATUS
========================================================= */

let alertsEnabled = true;


app.get(
  "/api/alerts",
  (q, r) => {

    r.json({
      enabled:
        alertsEnabled
    });
  }
);


app.post(
  "/api/alerts",
  (q, r) => {

    alertsEnabled =
      Boolean(q.body?.enabled);

    r.json({

      ok: true,

      enabled:
        alertsEnabled
    });
  }
);


/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/health",
  (q, r) => {

    r.json({
      ok: true
    });
  }
);


/* =========================================================
   DASHBOARD FALLBACK
========================================================= */

app.use(
  (q, r) =>
    r.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    )
);


/* =========================================================
   START
========================================================= */

scan();

setInterval(
  scan,
  POLL_MS
);


app.listen(
  PORT,
  () =>
    console.log(
      "Cloud monitor running on " +
      PORT
    )
);
