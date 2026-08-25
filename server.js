const express=require("express");
const path=require("path");
const app=express(); app.use(express.json()); app.use(express.static(path.join(__dirname,"public")));
const PORT=process.env.PORT||3000, API_KEY=process.env.TWELVE_DATA_API_KEY, INTERVAL=process.env.TIMEFRAME||"5min", POLL_MS=Math.max(1800000,Number(process.env.POLL_MS||60000));
const pairs=["EUR/USD","GBP/USD","USD/CAD","XAU/USD","USD/CHF","EUR/GBP","GBP/CHF"], state={lastScan:null,pairs:{}}, lastSignal={};
const tfCache = new Map();
const TF_CACHE_MS = {
  "12h": 12 * 60 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "5min": 5 * 60 * 1000
};

async function getCachedCandles(pair, interval) {
  const key = `${pair}:${interval}`;
  const now = Date.now();
  const cached = tfCache.get(key);

  if (cached && now - cached.time < TF_CACHE_MS[interval]) {
    return cached.data;
  }

  const data = await fetchCandles(pair, interval);
  tfCache.set(key, { data, time: now });
  return data;
  }
function ema(a,p){let k=2/(p+1),e=a[0];for(let i=1;i<a.length;i++)e=a[i]*k+e*(1-k);return e}
function rsi(a,p=14){if(a.length<p+1)return 50;let g=0,l=0;for(let i=a.length-p;i<a.length;i++){let d=a[i]-a[i-1];if(d>=0)g+=d;else l-=d}if(!l)return 100;return 100-100/(1+(g/p)/(l/p))}
function smc(c){
  if(c.length<10)return{bias:"NEUTRAL",bos:false,sweep:false};

  let h=c.map(x=>+x.high),l=c.map(x=>+x.low),cl=c.map(x=>+x.close);
  let prevHigh=Math.max(...h.slice(-10,-2));
  let prevLow=Math.min(...l.slice(-10,-2));
  let lastHigh=h.at(-1),lastLow=l.at(-1),lastClose=cl.at(-1);

  let bullishBOS=lastClose>prevHigh;
  let bearishBOS=lastClose<prevLow;

  let bullishSweep=lastLow<prevLow&&lastClose>prevLow;
  let bearishSweep=lastHigh>prevHigh&&lastClose<prevHigh;

  if(bullishBOS||bullishSweep)return{
    bias:"BULLISH",
    bos:bullishBOS,
    sweep:bullishSweep
  };

  if(bearishBOS||bearishSweep)return{
    bias:"BEARISH",
    bos:bearishBOS,
    sweep:bearishSweep
  };

  return{bias:"NEUTRAL",bos:false,sweep:false};
  }
function evaluate(pair,c){if(c.length<80)return{pair,signal:"WAIT",detail:"Not enough candles"};let b=c.map(x=>({open:+x.open,high:+x.high,low:+x.low,close:+x.close})),cl=b.map(x=>x.close),e20=ema(cl.slice(-80),20),e50=ema(cl.slice(-80),50),rs=rsi(cl.slice(-40),14),x=b.at(-1),look=b.slice(-21,-1),res=Math.max(...look.map(x=>x.high)),sup=Math.min(...look.map(x=>x.low));let buy=(x.close>e20&&e20>e50?1:0)+(rs>=55&&rs<=72?1:0)+(x.close>res&&x.close>x.open?1:0)+(x.close>res?1:0)+(x.close>b.at(-2).close?1:0),sell=(x.close<e20&&e20<e50?1:0)+(rs<=45&&rs>=28?1:0)+(x.close<sup&&x.close<x.open?1:0)+(x.close<sup?1:0)+(x.close<b.at(-2).close?1:0);if(buy>=4&&x.close>res){
  let entry=x.close;
  let sl=sup;
  let risk=entry-sl;
  let tp=entry+(risk*2);
  return{pair,signal:"STRONG BUY",score:buy,entry:+entry.toFixed(5),stopLoss:+sl.toFixed(5),takeProfit:+tp.toFixed(5),detail:`Trend ✓ RSI ${rs.toFixed(1)} ✓ Breakout ✓ R:R 1:2`};
}

if(sell>=4&&x.close<sup){
  let entry=x.close;
  let sl=res;
  let risk=sl-entry;
  let tp=entry-(risk*2);
  return{pair,signal:"STRONG SELL",score:sell,entry:+entry.toFixed(5),stopLoss:+sl.toFixed(5),takeProfit:+tp.toFixed(5),detail:`Trend ✓ RSI ${rs.toFixed(1)} ✓ Breakdown ✓ R:R 1:2`};
}return{pair,signal:"WAIT",score:Math.max(buy,sell),detail:`BUY ${buy}/5 • SELL ${sell}/5`}}
 async function fetchCandles(pair,interval=INTERVAL){
  if(!API_KEY)throw Error("TWELVE_DATA_API_KEY is not configured");
  let u=`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair)}&interval=${encodeURIComponent(interval)}&outputsize=100&apikey=${encodeURIComponent(API_KEY)}`;
  let r=await fetch(u);
  if(!r.ok)throw Error("Twelve Data HTTP "+r.status);
  let d=await r.json();
  if(d.status==="error")throw Error(d.message||"Twelve Data error");
  if(!d.values||!d.values.length)throw Error("No candle data returned");
  return d.values.slice().reverse();
}
async function notify(s){let t=process.env.TELEGRAM_BOT_TOKEN,ch=process.env.TELEGRAM_CHAT_ID;if(!t||!ch)return;await fetch(`https://api.telegram.org/bot${t}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:ch,text:`🚨 ${s.signal}: ${s.pair}
Entry: ${s.entry}
🛑 Stop Loss: ${s.stopLoss}
🎯 Take Profit: ${s.takeProfit}
⭐ Score: ${s.score}/5
📊 ${s.detail}`})})}
function multiTimeframeSignal(pair,h12,h1,m5){
  if(!h12?.length||!h1?.length||!m5?.length){
    return {pair,signal:"WAIT",score:0,detail:"Not enough timeframe data"};
  }

  const b12=smc(h12);
  const b1=smc(h1);

  const last=m5[m5.length-1];
  const prev=m5[m5.length-2];

  const close=+last.close;
  const open=+last.open;
  const high=+last.high;
  const low=+last.low;

  const prevHigh=+prev.high;
  const prevLow=+prev.low;

  const recent=m5.slice(-10);
  const recentHigh=Math.max(...recent.map(x=>+x.high));
  const recentLow=Math.min(...recent.map(x=>+x.low));

  // Bullish 5M confirmation:
  // price pulls back, then closes bullish and breaks the previous candle high
  const bullish5=
    close>open &&
    close>prevHigh &&
    low<=recentLow+(recentHigh-recentLow)*0.45;

  // Bearish 5M confirmation:
  // price pulls back upward, then closes bearish and breaks previous candle low
  const bearish5=
    close<open &&
    close<prevLow &&
    high>=recentHigh-(recentHigh-recentLow)*0.45;

  // BUY only when 12H + 1H agree
  if(b12.bias==="BULLISH" && b1.bias==="BULLISH" && bullish5){

    const sl=recentLow;
    const risk=close-sl;

    if(risk<=0)return{pair,signal:"WAIT",score:0,detail:"Invalid BUY risk"};

    const tp=close+(risk*2);

    return{
      pair,
      signal:"STRONG BUY",
      entry:close,
      stopLoss:sl,
      takeProfit:tp,
      score:5,
      detail:"12H bullish ✓ 1H bullish ✓ 5M pullback/break ✓ SMC confirmed"
    };
  }

  // SELL only when 12H + 1H agree
  if(b12.bias==="BEARISH" && b1.bias==="BEARISH" && bearish5){

    const sl=recentHigh;
    const risk=sl-close;

    if(risk<=0)return{pair,signal:"WAIT",score:0,detail:"Invalid SELL risk"};

    const tp=close-(risk*2);

    return{
      pair,
      signal:"STRONG SELL",
      entry:close,
      stopLoss:sl,
      takeProfit:tp,
      score:5,
      detail:"12H bearish ✓ 1H bearish ✓ 5M pullback/break ✓ SMC confirmed"
    };
  }

  return{
    pair,
    signal:"WAIT",
    score:0,
    detail:`12H ${b12.bias} | 1H ${b1.bias} | Waiting for 5M confirmation`
  };
            }
async function scan(){for(const p of pairs)try{let [h12,h1,m5]=await Promise.all([
  fetchCandles(p,"12h"),
  fetchCandles(p,"1h"),
  fetchCandles(p,"5min")
]);

let s=multiTimeframeSignal(p,h12,h1,m5);state.pairs[p]={...s,updatedAt:new Date().toISOString()};if((s.signal==="STRONG BUY"||s.signal==="STRONG SELL")&&lastSignal[p]!==s.signal){lastSignal[p]=s.signal;await notify(s)}}catch(e){state.pairs[p]={pair:p,signal:"OFFLINE",detail:e.message,updatedAt:new Date().toISOString()}}state.lastScan=new Date().toISOString()}
app.get("/api/status",(q,r)=>r.json({timeframe:INTERVAL,lastScan:state.lastScan,pairs:state.pairs}));
app.get("/api/test-alert",async(q,r)=>{
  try{
    await notify({
      signal:"TEST ALERT",
      pair:"SYSTEM",
      entry:"—",
      score:5,
      detail:"Telegram connection is working."
    });
    r.json({ok:true,message:"Test alert sent."});
  }catch(e){
    r.status(500).json({ok:false,error:e.message});
  }
});app.get("/health",(q,r)=>r.json({ok:true}));app.use((q,r)=>r.sendFile(path.join(__dirname,"public","index.html")));scan();setInterval(scan,POLL_MS);app.listen(PORT,()=>console.log("Cloud monitor running on "+PORT));
