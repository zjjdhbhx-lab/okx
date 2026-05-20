/* ===========================================================================
 * ETH 交易快照 — snapshot.js (浏览器 / GitHub Pages 版)
 *
 * 与扩展版的差异:
 *   - 删除 chrome.runtime / storage / tabs 相关代码 (纯前端环境)
 *   - Yahoo / Farside 无 CORS 头, 浏览器无法直接抓; 通过 CORS_PROXY 通道
 *     代理 URL 由 window.buildSnapshot(symbol, account, proxy, sendProgress) 注入
 *     代理形如 "https://my-worker.workers.dev/?url=" — 内部拼接 encodeURIComponent(目标URL)
 *     代理为空时这两路调用会失败并标记到 errors, 其余数据不受影响
 *   - 导出 window.buildSnapshot, 由 app.js 调用
 *   - 删除 Coinglass (无 key 管理且原本就受限)
 * =========================================================================== */

const HTTP_TIMEOUT_MS = 15000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let CORS_PROXY = "";   // 由 buildSnapshot 注入
let PROXY_ALL = false; // 由 buildSnapshot 注入: 全部 OKX/CoinGecko 也走代理 (绕过地区静默限制)
function viaProxy(url) {
  if (!CORS_PROXY) throw new Error(`需要 CORS 代理才能访问 ${new URL(url).hostname} (留空则跳过)`);
  return CORS_PROXY + encodeURIComponent(url);
}
function maybeProxy(url) {
  return (PROXY_ALL && CORS_PROXY) ? CORS_PROXY + encodeURIComponent(url) : url;
}

function timeoutFetch(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

async function getJson(url, opts = {}, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await timeoutFetch(url, opts);
      if (r.status === 429 || (r.status >= 500 && r.status < 600)) {
        lastErr = new Error(`HTTP ${r.status}`);
        await sleep((2 ** i) * 500 + 300);
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep((2 ** i) * 500 + 300);
    }
  }
  throw lastErr;
}

async function getText(url, opts = {}, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await timeoutFetch(url, opts);
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      return await r.text();
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep((2 ** i) * 500 + 300);
    }
  }
  throw lastErr;
}

/* ---------- 时间格式 (UTC+8) ---------- */
function tsToStr(tsMs) {
  const dt = new Date(Number(tsMs) + 8 * 3600000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`;
}
function tsToStrSec(tsMs) {
  const dt = new Date(Number(tsMs) + 8 * 3600000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;
}
function nowCnStr() {
  const d = new Date(Date.now() + 8 * 3600000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} 北京时间`;
}

/* ===========================================================================
 * OKX endpoints
 * =========================================================================== */
const OKX = "https://www.okx.com";
let lastOkxError = null;

async function okxGet(path, params = {}) {
  const url = new URL(OKX + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const finalUrl = maybeProxy(url.toString()); // PROXY_ALL=true 时走 CF Worker
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(finalUrl, { method: "GET" });
      const j = await r.json();
      if (j.code === "0") { lastOkxError = null; return j.data || []; }
      if ((j.code === "50011" || j.code === "50061") && i < 2) {
        await sleep(1500 * (i + 1));
        continue;
      }
      lastOkxError = `OKX code=${j.code} msg=${j.msg || "?"} (${path})`;
      return [];
    } catch (e) {
      lastOkxError = `fetch fail (${path}): ${e.message}`;
      if (i < 2) await sleep(1000 * (i + 1));
      else return [];
    }
  }
  return [];
}

/* OKX 主流币种 SWAP 合约乘数 (1 张合约 = 多少币) — 仅当 fetchCtVal 失败时的兜底.
 * 实际 ctVal 通过 /public/instruments 动态拉取 (OKX 历史上调过 ETH ctVal 从 0.01 → 0.1, 硬编码会过期). */
const CT_VAL = {
  BTC: 0.01, ETH: 0.1, BCH: 0.01,
  SOL: 1, LTC: 1, AVAX: 1, LINK: 1, ATOM: 1, NEAR: 1, FIL: 1,
  XRP: 100, ADA: 100, TRX: 100, MATIC: 10,
  DOGE: 1000, SHIB: 1000000, PEPE: 10000000,
};

/* 从 OKX /public/instruments 动态拉取合约乘数, 避免硬编码过期 */
const _ctValCache = new Map();
async function fetchCtVal(swapInstId) {
  if (_ctValCache.has(swapInstId)) return _ctValCache.get(swapInstId);
  const d = await okxGet("/api/v5/public/instruments", { instType: "SWAP", instId: swapInstId });
  if (d.length && d[0].ctVal) {
    const cv = +d[0].ctVal;
    _ctValCache.set(swapInstId, cv);
    return cv;
  }
  return null;
}

async function fetchTicker(instId) {
  const d = await okxGet("/api/v5/market/ticker", { instId });
  if (!d.length) return null;
  const t = d[0];
  const last = +t.last, open = +t.open24h;
  // volCcy24h: SPOT → 报价币(USDT); SWAP/FUTURES → 基础币(coin). 统一折成 USD 名义.
  const isSwap = /-SWAP$/.test(instId) || /-\d{6}$/.test(instId);
  const volCcy = +t.volCcy24h;
  const vol24h_usdt = isSwap ? volCcy * last : volCcy;
  return {
    last, open24h: open, high24h: +t.high24h, low24h: +t.low24h,
    vol24h_usdt,
    vol24h_base: isSwap ? volCcy : volCcy / last, // 基础币计量 (ETH 数量)
    chg_pct: +(((last - open) / open) * 100).toFixed(2),
  };
}

/* 多周期 K 线抓取 (单页, 数量见 fetchAllCandles) */
async function fetchCandles(instId, bar, limit) {
  const d = await okxGet("/api/v5/market/candles", { instId, bar, limit: String(limit) });
  if (!d.length) return [];
  d.reverse();
  return d.map((c) => ({
    ts: +c[0], time: tsToStr(c[0]),
    open: +c[1], high: +c[2], low: +c[3], close: +c[4],
    vol_coin: +c[5], vol_usdt: +c[7],
  }));
}

async function fetchAllCandles(instId) {
  // OKX market/candles 单页上限 300.
  // D1 拉 300 让 MA200 有足量样本; 1H 拉 300 (~12.5 天) 供 Volume Profile;
  // 15m 拉 96 (=24h) 让当日 VWAP 覆盖完整一天; 4H 拉 60 给 MA50/BOLL20/ATR14 留余量.
  const [d1, h4, h1, m15] = await Promise.all([
    fetchCandles(instId, "1D", 300),
    fetchCandles(instId, "4H", 60),
    fetchCandles(instId, "1H", 300),
    fetchCandles(instId, "15m", 96),
  ]);
  return { d1, h4, h1, m15 };
}

/* perp/spot 盘口深度 — 前 N 档 + ±1% 内大单墙 + 失衡 */
async function fetchBooks(instId, isSwap, ctVal, levels = 10) {
  const d = await okxGet("/api/v5/market/books", { instId, sz: "400" });
  if (!d.length) return null;
  const bk = d[0];
  const cv = isSwap ? (ctVal ?? 1) : 1; // SWAP 档位 sz 是张数 → 折成币
  const conv = (x) => ({ p: +x[0], s: +x[1] * cv });
  const bids = (bk.bids || []).map(conv);
  const asks = (bk.asks || []).map(conv);
  if (!bids.length || !asks.length) return null;
  const mid = (bids[0].p + asks[0].p) / 2;
  const r = (v, d2 = 2) => +v.toFixed(d2);
  const inBand = (arr) => arr.filter((x) => Math.abs(x.p - mid) / mid <= 0.01);
  const bidsIn = inBand(bids), asksIn = inBand(asks);
  const sumS = (arr) => arr.reduce((a, x) => a + x.s, 0);
  const bSum = sumS(bidsIn), aSum = sumS(asksIn);
  const walls = (arr) => [...arr].sort((a, b) => b.s - a.s).slice(0, 3)
    .map((x) => ({ p: x.p, s: r(x.s), usd: Math.round(x.p * x.s) }));
  return {
    mid: r(mid),
    spread: r(asks[0].p - bids[0].p),
    top_bids: bids.slice(0, levels).map((x) => ({ p: x.p, s: r(x.s) })),
    top_asks: asks.slice(0, levels).map((x) => ({ p: x.p, s: r(x.s) })),
    bid_sum_1pct_coin: r(bSum), bid_sum_1pct_usd: Math.round(bSum * mid),
    ask_sum_1pct_coin: r(aSum), ask_sum_1pct_usd: Math.round(aSum * mid),
    imbalance_1pct: bSum + aSum > 0 ? r((bSum - aSum) / (bSum + aSum), 3) : null,
    wall_bids: walls(bidsIn), wall_asks: walls(asksIn),
  };
}

/* ETH/BTC 比值 + BTC/ETH 市占率 (CoinGecko global) */
async function fetchRelative(symbol) {
  const out = {};
  if (symbol !== "BTC") {
    const t = await fetchTicker(`${symbol}-BTC`);
    if (t) out.ratio_vs_btc = { last: t.last, chg_pct: t.chg_pct, high24h: t.high24h, low24h: t.low24h };
  }
  try {
    const g = await getJson(maybeProxy("https://api.coingecko.com/api/v3/global"));
    const mc = g?.data?.market_cap_percentage || {};
    out.btc_dominance_pct = mc.btc ?? null;
    out.eth_dominance_pct = mc.eth ?? null;
  } catch (e) { /* dominance 缺失不致命 */ }
  return Object.keys(out).length ? out : null;
}

/* OI 历史 — 1H 粒度, 留 48h 供 24h 绝对值序列 + 1h/4h 变化 */
async function fetchOiHistory(instId, period = "1H", n = 48) {
  const d = await okxGet("/api/v5/rubik/stat/contracts/open-interest-history", { instId, period, limit: "100" });
  if (!d.length) return [];
  d.reverse();
  return d.slice(-n).map((x) => ({ ts: +x[0], time: tsToStr(x[0]), oi: +x[1] }));
}

/* 散户多空人数比 (账户) — 1H × 24 点曲线 */
async function fetchRetailLsr(ccy, period = "1H", n = 24) {
  const d = await okxGet("/api/v5/rubik/stat/contracts/long-short-account-ratio", { ccy, period });
  if (!d.length) return [];
  d.reverse();
  return d.slice(-n).map((x) => ({ ts: +x[0], time: tsToStr(x[0]), ratio: +x[1] }));
}
async function fetchTopTraderPositionRatio(instId, period = "1H", n = 24) {
  const d = await okxGet(
    "/api/v5/rubik/stat/contracts/long-short-position-ratio-contract-top-trader",
    { instId, period }
  );
  if (!d.length) return [];
  d.reverse();
  return d.slice(-n).map((x) => ({ ts: +x[0], time: tsToStr(x[0]), ratio: +x[1] }));
}

async function fetchFunding(instId) {
  const d = await okxGet("/api/v5/public/funding-rate", { instId });
  if (!d.length) return null;
  const x = d[0];
  return {
    current: +x.fundingRate,
    current_settle_time: tsToStr(x.fundingTime),
    last_settled: x.settFundingRate ? +x.settFundingRate : null,
    premium: x.premium != null && x.premium !== "" ? +x.premium : null,
  };
}

/* 完整 funding 历史 (用于 8h/24h/7d 均值, 30d 分位, 连续正负计数) */
async function fetchFundingHist(instId, limit = 100) {
  const d = await okxGet("/api/v5/public/funding-rate-history", { instId, limit: String(limit) });
  if (!d.length) return [];
  d.reverse();
  return d.map((x) => ({ ts: +x.fundingTime, rate: +x.fundingRate }));
}

/* Taker 主动成交 (5m / 15m 桶, 用于 CVD 累计) */
async function fetchTakerBuckets(ccy, period = "5m", n = 200) {
  const d = await okxGet("/api/v5/rubik/stat/taker-volume", { ccy, period, instType: "CONTRACTS" });
  if (!d.length) return [];
  d.reverse();
  return d.slice(-n).map((x) => ({
    ts: +x[0], time: tsToStr(x[0]),
    buy: +x[1], sell: +x[2],
  }));
}

/* OKX 单边清算流水 — 含价位聚集. ctVal 由调用方注入(优先动态值, 避免硬编码漂移). */
async function fetchLiquidations(symbol, ctVal) {
  const uly = `${symbol}-USDT`;
  const cv = ctVal ?? CT_VAL[symbol] ?? 1;
  const d = await okxGet("/api/v5/public/liquidation-orders",
    { instType: "SWAP", uly, state: "filled", limit: "100" });
  if (!d.length || !d[0].details) return null;
  const details = (d[0].details || []).sort((a, b) => +b.ts - +a.ts);
  let longUsd = 0, shortUsd = 0;
  const recent = [];
  let earliestTs = Infinity, latestTs = 0;
  const byBucket = new Map(); // 按 0.5% 价格桶聚合
  let priceRef = null;
  for (const x of details) {
    const sz = +x.sz, px = +x.bkPx, ts = +x.ts;
    if (!priceRef) priceRef = px;
    if (ts < earliestTs) earliestTs = ts;
    if (ts > latestTs) latestTs = ts;
    const usd = sz * px * cv;
    const isLongLiq = x.side === "sell";
    if (isLongLiq) longUsd += usd; else shortUsd += usd;
    if (recent.length < 10) {
      recent.push({ time: tsToStrSec(ts), side: isLongLiq ? "long" : "short", price: px, usd: Math.round(usd) });
    }
    // 价位聚合: 以 0.5% 为桶
    const bucketStep = priceRef * 0.005;
    const bucket = Math.round(px / bucketStep) * bucketStep;
    const key = bucket.toFixed(2);
    const cur = byBucket.get(key) || { price: +key, long_usd: 0, short_usd: 0, count: 0 };
    if (isLongLiq) cur.long_usd += usd; else cur.short_usd += usd;
    cur.count += 1;
    byBucket.set(key, cur);
  }
  const allBuckets = [...byBucket.values()]
    .map((b) => ({ ...b, long_usd: Math.round(b.long_usd), short_usd: Math.round(b.short_usd), total_usd: Math.round(b.long_usd + b.short_usd) }))
    .sort((a, b) => b.total_usd - a.total_usd);
  const top5 = allBuckets.slice(0, 5);
  const rest = allBuckets.slice(5);
  const other_usd = rest.reduce((s, b) => s + b.total_usd, 0);
  const other_count = rest.reduce((s, b) => s + b.count, 0);
  return {
    count: details.length,
    window_min: Math.round((latestTs - earliestTs) / 60000),
    long_count: details.filter((x) => x.side === "sell").length,
    short_count: details.filter((x) => x.side === "buy").length,
    long_usd: Math.round(longUsd),
    short_usd: Math.round(shortUsd),
    net_long_minus_short_usd: Math.round(longUsd - shortUsd),
    recent,
    top_price_clusters: top5,
    other_clusters: rest.length ? { usd: other_usd, count: other_count, n: rest.length } : null,
  };
}

/* BTC 同步快照 (mini) */
async function fetchBtcSync() {
  const instId = "BTC-USDT-SWAP";
  const [tk, oiH, fr] = await Promise.all([
    okxGet("/api/v5/market/ticker", { instId }),
    okxGet("/api/v5/rubik/stat/contracts/open-interest-history", { instId, period: "5m" }),
    okxGet("/api/v5/public/funding-rate", { instId }),
  ]);
  if (!tk.length) return null;
  const t = tk[0];
  const last = +t.last, open = +t.open24h;
  let oiTrend = null;
  if (oiH.length >= 12) {
    const arr = [...oiH].reverse();
    const oldest = arr[arr.length - 12], latest = arr[arr.length - 1];
    oiTrend = { current: +latest[1], pct_1h: +(((+latest[1] - +oldest[1]) / +oldest[1]) * 100).toFixed(3) };
  }
  return {
    last, chg_pct: +(((last - open) / open) * 100).toFixed(2),
    oi_pct_1h: oiTrend ? oiTrend.pct_1h : null,
    funding_current_pct: fr.length ? +((+fr[0].fundingRate) * 100).toFixed(4) : null,
  };
}

/* ===========================================================================
 * 指标计算
 * =========================================================================== */
function sma(arr, n) {
  if (!arr || arr.length < n) return null;
  let s = 0;
  for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
  return s / n;
}
function stddev(arr, n, mean) {
  if (!arr || arr.length < n) return null;
  const w = arr.slice(-n);
  return Math.sqrt(w.reduce((a, x) => a + (x - mean) ** 2, 0) / n);
}
function boll(closes, n = 20, k = 2) {
  const ma = sma(closes, n);
  if (ma == null) return null;
  const sd = stddev(closes, n, ma);
  return { mid: ma, upper: ma + k * sd, lower: ma - k * sd };
}
/* ATR(14): Wilder smoothing of TR */
function atr(candles, n = 14) {
  if (!candles || candles.length < n + 1) return null;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const prevClose = candles[i - 1].close;
    const h = candles[i].high, l = candles[i].low;
    tr.push(Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose)));
  }
  // Wilder: first ATR = simple avg, then ATR_i = (ATR_{i-1}*(n-1) + TR_i)/n
  let a = tr.slice(0, n).reduce((s, x) => s + x, 0) / n;
  for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
  return a;
}
/* 当日 VWAP — 用 D1 当日的 (open+high+low+close)/4 + 量近似 typical price */
function vwapToday(candles15m) {
  if (!candles15m || !candles15m.length) return null;
  const last = candles15m[candles15m.length - 1];
  const lastDay = new Date(last.ts + 8 * 3600000).toISOString().slice(0, 10);
  let pv = 0, v = 0;
  for (const c of candles15m) {
    const d = new Date(c.ts + 8 * 3600000).toISOString().slice(0, 10);
    if (d !== lastDay) continue;
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * c.vol_coin;
    v += c.vol_coin;
  }
  return v > 0 ? pv / v : null;
}
/* 简易 swing 点检测: 中间 bar 是左右 k 根的最高/最低则为 pivot */
function swingPivots(candles, k = 3, n = 5) {
  if (!candles || candles.length < 2 * k + 1) return { highs: [], lows: [] };
  const highs = [], lows = [];
  for (let i = k; i < candles.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push({ time: candles[i].time, price: candles[i].high });
    if (isLow) lows.push({ time: candles[i].time, price: candles[i].low });
  }
  return { highs: highs.slice(-n), lows: lows.slice(-n) };
}
/* 周开盘 — UTC+8 周一 00:00 */
function weekOpen(d1Candles) {
  if (!d1Candles || !d1Candles.length) return null;
  const last = d1Candles[d1Candles.length - 1];
  const lastDate = new Date(last.ts + 8 * 3600000);
  const dow = lastDate.getUTCDay(); // 0=Sun
  const daysToMon = dow === 0 ? 6 : dow - 1;
  const mondayUtc8 = new Date(Date.UTC(lastDate.getUTCFullYear(), lastDate.getUTCMonth(), lastDate.getUTCDate() - daysToMon, 0, 0, 0));
  // mondayUtc8 表示 UTC+8 的周一 00:00, 转回毫秒戳
  const mondayMs = mondayUtc8.getTime() - 8 * 3600000;
  for (const c of d1Candles) if (c.ts >= mondayMs) return { date: tsToStr(c.ts).slice(0, 5), open: c.open };
  return null;
}
/* 上周高低: 上一个 UTC+8 周一到周日 */
function lastWeekHL(d1Candles) {
  if (!d1Candles || d1Candles.length < 14) return null;
  const last = d1Candles[d1Candles.length - 1];
  const lastDate = new Date(last.ts + 8 * 3600000);
  const dow = lastDate.getUTCDay();
  const daysToMon = dow === 0 ? 6 : dow - 1;
  const thisMonMs = (new Date(Date.UTC(lastDate.getUTCFullYear(), lastDate.getUTCMonth(), lastDate.getUTCDate() - daysToMon))).getTime() - 8 * 3600000;
  const lastMonMs = thisMonMs - 7 * 86400000;
  const lastSunEndMs = thisMonMs - 1;
  const week = d1Candles.filter((c) => c.ts >= lastMonMs && c.ts <= lastSunEndMs);
  if (!week.length) return null;
  return {
    high: Math.max(...week.map((c) => c.high)),
    low: Math.min(...week.map((c) => c.low)),
  };
}
/* 近 7 日 H/L */
function recentHL(d1Candles, n) {
  if (!d1Candles || !d1Candles.length) return null;
  const slice = d1Candles.slice(-n);
  return { high: Math.max(...slice.map((c) => c.high)), low: Math.min(...slice.map((c) => c.low)) };
}
/* 体积分布 (Volume Profile): 用 1H K 线, 把每根成交量按高低区间均摊到价格桶,
 * 给出 POC (成交最密价) 与 70% 价值区间 VAH/VAL. 这是定位真支撑/阻力的依据. */
function volumeProfile(candles, bins = 60) {
  if (!candles || candles.length < 20) return null;
  const hi = Math.max(...candles.map((c) => c.high));
  const lo = Math.min(...candles.map((c) => c.low));
  if (!(hi > lo)) return null;
  const step = (hi - lo) / bins;
  const vol = new Array(bins).fill(0);
  for (const c of candles) {
    const loBin = Math.max(0, Math.floor((c.low - lo) / step));
    const hiBin = Math.min(bins - 1, Math.floor((c.high - lo) / step));
    const span = hiBin - loBin + 1;
    const per = c.vol_coin / span;
    for (let b = loBin; b <= hiBin; b++) vol[b] += per;
  }
  let poc = 0;
  for (let i = 1; i < bins; i++) if (vol[i] > vol[poc]) poc = i;
  const total = vol.reduce((a, b) => a + b, 0);
  let lo2 = poc, hi2 = poc, acc = vol[poc];
  while (acc < total * 0.7 && (lo2 > 0 || hi2 < bins - 1)) {
    const left = lo2 > 0 ? vol[lo2 - 1] : -1;
    const right = hi2 < bins - 1 ? vol[hi2 + 1] : -1;
    if (right >= left) { hi2++; acc += vol[hi2]; } else { lo2--; acc += vol[lo2]; }
  }
  const px = (b) => +(lo + (b + 0.5) * step).toFixed(2);
  return {
    days: Math.round((candles[candles.length - 1].ts - candles[0].ts) / 86400000),
    bars: candles.length,
    poc: px(poc), vah: px(hi2), val: px(lo2),
    range_high: +hi.toFixed(2), range_low: +lo.toFixed(2),
  };
}

/* 一次性算所有周期的指标. MA200 仅 D1 计算且需 ≥200 根 (已删 EMA200, 与 MA200 高度重合). */
function computeIndicators(allCandles) {
  const out = {};
  for (const [tf, candles] of Object.entries(allCandles)) {
    const closes = candles.map((c) => c.close);
    const ind = {
      ma20: sma(closes, 20),
      ma50: sma(closes, 50),
      ma200: null,
      ma200_status: null,
      atr14: atr(candles, 14),
    };
    if (tf === "d1") {
      if (closes.length >= 200) ind.ma200 = sma(closes, 200);
      else ind.ma200_status = `N/A (仅 ${closes.length} 根 D1, 需 ≥200)`;
    }
    const b = boll(closes, 20, 2);
    if (b) Object.assign(ind, { boll_upper: b.upper, boll_mid: b.mid, boll_lower: b.lower });
    out[tf] = ind;
  }
  out.vwap_today = vwapToday(allCandles.m15);
  return out;
}

/* ===========================================================================
 * 衍生品聚合 / CVD / funding 统计
 * =========================================================================== */
function fundingStats(hist) {
  if (!hist || !hist.length) return null;
  const now = Date.now();
  // OKX 每 8h 一期 → 8h=最近 1 期, 24h=3 期, 7d=21 期, 30d=90 期
  const win = (hours) => hist.filter((h) => now - h.ts <= hours * 3600 * 1000);
  const avg = (arr) => arr.length ? arr.reduce((s, x) => s + x.rate, 0) / arr.length : null;
  const last30 = win(30 * 24);
  const sorted = last30.map((x) => x.rate).sort((a, b) => a - b);
  const current = hist[hist.length - 1].rate;
  const rank = sorted.findIndex((v) => v >= current);
  const percentile = rank < 0 ? 100 : Math.round((rank / sorted.length) * 100);
  // 连续正/负计数
  let streak = 0, sign = Math.sign(current);
  for (let i = hist.length - 1; i >= 0; i--) {
    if (Math.sign(hist[i].rate) === sign && sign !== 0) streak++;
    else break;
  }
  return {
    current_pct: current * 100,
    avg_8h_pct: avg(win(8)) == null ? null : avg(win(8)) * 100,
    avg_24h_pct: avg(win(24)) == null ? null : avg(win(24)) * 100,
    avg_7d_pct: avg(win(24 * 7)) == null ? null : avg(win(24 * 7)) * 100,
    percentile_30d: percentile,
    consecutive_count: streak,
    consecutive_sign: sign > 0 ? "+" : sign < 0 ? "-" : "0",
    // 近 21 期实际 funding 值 (7 天 × 3 期/天) — 看情绪拐点
    series_21: hist.slice(-21).map((h) => ({ time: tsToStr(h.ts), rate_pct: +(h.rate * 100).toFixed(4) })),
  };
}

/* CVD: 15m / 1h / 4h / 24h 主动买卖累计 (taker 桶为 5m 粒度) */
function cvdAggregate(taker5m) {
  if (!taker5m || !taker5m.length) return null;
  const now = Date.now();
  const win = (hours) => taker5m.filter((b) => now - b.ts <= hours * 3600 * 1000);
  const net = (arr) => {
    if (!arr.length) return null;
    const buy = arr.reduce((s, x) => s + x.buy, 0);
    const sell = arr.reduce((s, x) => s + x.sell, 0);
    return { buy, sell, delta: buy - sell, ratio: sell > 0 ? buy / sell : null };
  };
  return {
    last_15m: net(win(0.25)), last_1h: net(win(1)),
    last_4h: net(win(4)), last_24h: net(win(24)),
  };
}

/* 趋势摘要: max/min/cur/direction. 方向用 前半均 vs 后半均 (抗单点抖动),
 * |变化| < flatThreshold 视为走平. 同时返回 first→last 链供需要时使用. */
function trendSummary(series, flatThreshold = 0.01) {
  if (!series?.length) return null;
  const vals = series.map((x) => x.ratio);
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const cur = vals[vals.length - 1];
  const first = vals[0];
  const half = Math.max(1, Math.floor(vals.length / 2));
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const avgFirst = avg(vals.slice(0, half));
  const avgLast = avg(vals.slice(-half));
  const chgHalves = (avgLast - avgFirst) / avgFirst;
  let direction;
  if (Math.abs(chgHalves) < flatThreshold) direction = "走平";
  else if (chgHalves > 0) direction = "上行";
  else direction = "下行";
  return {
    n: vals.length, max, min, cur, first,
    chg_pct: ((cur - first) / first) * 100,
    direction,
  };
}

/* OI 1h/4h 变化 + 近 24h 每 1h 绝对值序列 (配对当时 ETH 收盘价, 看 OI×价 背离) */
function oiChange(oiHist, h1Candles) {
  if (!oiHist || oiHist.length < 2) return null;
  const cur = oiHist[oiHist.length - 1].oi;
  const at = (back) => {
    const target = oiHist.length - 1 - back;
    return target >= 0 ? oiHist[target].oi : null;
  };
  const oi1h = at(1); // 1H 粒度 → 回看 1 根 = 1h
  const oi4h = at(4);
  const priceByTs = new Map();
  if (h1Candles) for (const c of h1Candles) priceByTs.set(c.ts, c.close);
  const series_24h = oiHist.slice(-24).map((x) => ({
    time: x.time, oi: x.oi, px: priceByTs.has(x.ts) ? priceByTs.get(x.ts) : null,
  }));
  return {
    current: cur,
    pct_1h: oi1h ? +(((cur - oi1h) / oi1h) * 100).toFixed(3) : null,
    pct_4h: oi4h ? +(((cur - oi4h) / oi4h) * 100).toFixed(3) : null,
    series_24h,
  };
}

/* ===========================================================================
 * 跨交易所衍生品聚合 (CoinGecko) — 精简
 * =========================================================================== */
const ETH_PERP_TARGETS = [
  ["Binance (Futures)", new Set(["ETHUSDT"])],
  ["Bybit (Futures)", new Set(["ETHUSDT"])],
  ["OKX (Futures)", new Set(["ETH-USDT-SWAP", "ETHUSDTSWAP"])],
  ["Bitget Futures", new Set(["ETHUSDT_UMCBL", "ETHUSDT"])],
  ["Gate (Futures)", new Set(["ETH_USDT"])],
  ["Deribit (Futures)", new Set(["ETH-PERPETUAL"])],
  ["Hyperliquid (Futures)", new Set(["ETH"])],
];
async function fetchCgDerivatives(symbol) {
  if (symbol !== "ETH") return null; // 仅 ETH 维护映射, 其他币种跳过
  const rows = await getJson(maybeProxy("https://api.coingecko.com/api/v3/derivatives"));
  const found = [];
  for (const [market, symbols] of ETH_PERP_TARGETS) {
    const m = rows.find((r) => r.market === market && symbols.has(r.symbol) && (r.contract_type === "perpetual" || r.contract_type == null));
    if (!m) continue;
    found.push({ ex: market, oi: m.open_interest || 0, funding: m.funding_rate, basis: m.basis });
  }
  if (!found.length) return null;
  // 精简: 只留 Total OI + OI 加权 funding + Top3 OI + funding 极差
  const totalOi = found.reduce((s, x) => s + x.oi, 0);
  const fw = found.reduce((s, x) => x.funding != null ? s + x.funding * x.oi : s, 0) /
             (found.reduce((s, x) => x.funding != null ? s + x.oi : s, 0) || 1);
  const top3 = [...found].sort((a, b) => b.oi - a.oi).slice(0, 3);
  const fr = found.filter((x) => x.funding != null).sort((a, b) => b.funding - a.funding);
  const fundingSpread = fr.length >= 2 ? fr[0].funding - fr[fr.length - 1].funding : null;
  return {
    total_oi_usd: totalOi,
    oi_weighted_funding_pct: fw,
    top3_by_oi: top3,
    funding_spread_pct: fundingSpread,
  };
}

/* ===========================================================================
 * Farside ETH ETF (HTML 表)
 * =========================================================================== */
function stripTags(s) {
  return s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
}
function parseFarsideTable(html) {
  // MV3 service worker 无 DOMParser, 用正则提取 table.etf 内容
  const tableMatch = html.match(/<table[^>]*class="[^"]*etf[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) throw new Error("etf table not found");
  const tableHtml = tableMatch[1];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi;
  const rows = [];
  let m;
  while ((m = trRe.exec(tableHtml)) !== null) {
    const inner = m[1];
    const cells = [];
    let cm;
    cellRe.lastIndex = 0;
    while ((cm = cellRe.exec(inner)) !== null) cells.push(stripTags(cm[1]));
    if (cells.length) rows.push(cells);
  }
  let header = null;
  const dataRows = [];
  const dateRe = /^\d{1,2}\s+\w+\s+\d{4}$/;
  for (const cells of rows) {
    const joined = cells.join(" ").toUpperCase();
    if (!header && (joined.includes("ETHA") || joined.includes("FETH"))) { header = cells; continue; }
    if (header && cells[0] && dateRe.test(cells[0])) dataRows.push(cells);
  }
  if (!header || !dataRows.length) throw new Error("no header/rows parsed");
  if (header[header.length - 1] === "" || /total/i.test(header[header.length - 1])) {
    header = [...header]; header[header.length - 1] = "Total";
  }
  const parseNum = (s) => {
    s = s.replace(/,/g, "").replace(/\$/g, "").trim();
    if (!s || s === "-") return null;
    const neg = s.startsWith("(") && s.endsWith(")");
    s = s.replace(/[()]/g, "");
    const v = parseFloat(s);
    return Number.isFinite(v) ? (neg ? -v : v) : null;
  };
  const toObj = (r) => {
    const o = { date: r[0] };
    for (let i = 1; i < header.length; i++) if (i < r.length) o[header[i]] = parseNum(r[i]);
    return o;
  };
  const recent7 = dataRows.slice(-7).map(toObj);
  const latest = toObj(dataRows[dataRows.length - 1]);
  // 连续流出计数: 从最新往前, 直到第一个 Total > 0
  let outflowStreak = 0;
  for (let i = recent7.length - 1; i >= 0; i--) {
    if ((recent7[i].Total ?? 0) < 0) outflowStreak++; else break;
  }
  let inflowStreak = 0;
  for (let i = recent7.length - 1; i >= 0; i--) {
    if ((recent7[i].Total ?? 0) > 0) inflowStreak++; else break;
  }
  const sum5 = recent7.slice(-5).reduce((s, r) => s + (r.Total ?? 0), 0);
  return {
    latest_date: latest.date,
    latest_total_musd: latest.Total,
    last_5d_cum_musd: sum5,
    outflow_streak: outflowStreak,
    inflow_streak: inflowStreak,
    recent_7: recent7,
  };
}
async function fetchEtfFlows() {
  // Farside 无 CORS + Cloudflare → 必走代理
  const url = viaProxy("https://farside.co.uk/ethereum-etf-flow-all-data/");
  const html = await getText(url, {
    headers: { "accept": "text/html,application/xhtml+xml" },
  });
  return parseFarsideTable(html);
}

/* ===========================================================================
 * 宏观 (Yahoo) — DXY / NDX
 * =========================================================================== */
async function fetchYahoo(symbol) {
  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1h&includePrePost=false`;
  const url = viaProxy(target); // Yahoo 无 CORS → 必走代理
  const data = await getJson(url);
  const result = data.chart.result[0];
  const meta = result.meta;
  const ts = result.timestamp || [];
  const closes = (result.indicators.quote[0].close) || [];
  const series = [];
  for (let i = 0; i < ts.length; i++) if (closes[i] != null) series.push({ t: new Date(ts[i] * 1000).toISOString(), close: closes[i] });
  const cur = meta.regularMarketPrice;
  const last = series[series.length - 1];
  const lastDay = last ? last.t.slice(0, 10) : null;
  let prevDayClose = null;
  for (let i = series.length - 2; i >= 0; i--) {
    if (series[i].t.slice(0, 10) !== lastDay) { prevDayClose = series[i].close; break; }
  }
  const firstClose = series.length ? series[0].close : null;
  return {
    current: cur,
    chg_1d_pct: prevDayClose ? ((cur - prevDayClose) / prevDayClose) * 100 : null,
    chg_5d_pct: firstClose ? ((cur - firstClose) / firstClose) * 100 : null,
  };
}
async function fetchMacro() {
  // ^TNX = 美 10 年期国债收益率 (报价即收益率, 如 4.25 = 4.25%)
  const [dxy, ndx, us10y] = await Promise.all([
    fetchYahoo("DX-Y.NYB"), fetchYahoo("^NDX"), fetchYahoo("^TNX"),
  ]);
  return { DXY: dxy, NDX: ndx, US10Y: us10y };
}

/* ===========================================================================
 * stETH / ETH 价差 (CoinGecko)
 * =========================================================================== */
async function fetchStethSpread() {
  const url = maybeProxy("https://api.coingecko.com/api/v3/simple/price?ids=staked-ether,ethereum&vs_currencies=usd,eth&include_24hr_change=true");
  const data = await getJson(url);
  const ethUsd = data.ethereum.usd, stethUsd = data["staked-ether"].usd;
  const stethInEth = data["staked-ether"].eth;
  return {
    eth_usd: ethUsd, steth_usd: stethUsd, steth_in_eth: stethInEth,
    spread_pct_native: stethInEth != null ? (stethInEth - 1) * 100 : null,
  };
}

/* ===========================================================================
 * Markdown 格式化 — 13 段结构
 * =========================================================================== */
function fmtPct(v, d = 2) { return v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`; }
function fmtNum(v, d = 2) { return v == null || !Number.isFinite(v) ? "—" : v.toFixed(d); }
function fmtInt(v) { return v == null || !Number.isFinite(v) ? "—" : Math.round(v).toLocaleString("en-US"); }
function fmtUsd(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function formatMarkdown(j) {
  const s = j.snapshot;
  const sym = j.symbol;
  const L = [];
  L.push(`# ${sym} 交易快照`);
  L.push(`> 生成时间: ${j.generated_at_cn || j.generated_at} | 单位价格: USDT`);
  L.push("");

  // 1. 标的快照
  L.push("## 1. 标的快照");
  if (s.perp) {
    L.push(`- 永续最新: **${s.perp.last}**  24h变化: ${fmtPct(s.perp.chg_pct)}  24h区间: [${s.perp.low24h} , ${s.perp.high24h}]`);
    const baseTxt = s.perp.vol24h_base != null ? `  (≈ ${fmtInt(s.perp.vol24h_base)} ${sym})` : "";
    L.push(`- 24h 成交额: ${fmtUsd(s.perp.vol24h_usdt)}${baseTxt}`);
  }
  if (s.spot) L.push(`- OKX 现货最新: **${s.spot.last}**  24h变化: ${fmtPct(s.spot.chg_pct)}`);
  if (s.basis) L.push(`- Perp 溢价 (perp - spot)/spot: **${fmtPct(s.basis.premium_pct, 4)}**`);
  if (s.relative) {
    const r = s.relative;
    if (r.ratio_vs_btc) L.push(`- ${sym}/BTC: **${r.ratio_vs_btc.last}**  24h变化: ${fmtPct(r.ratio_vs_btc.chg_pct)}  24h区间: [${r.ratio_vs_btc.low24h} , ${r.ratio_vs_btc.high24h}]`);
    if (r.btc_dominance_pct != null) L.push(`- BTC.D: **${fmtNum(r.btc_dominance_pct, 2)}%**  ETH.D: ${fmtNum(r.eth_dominance_pct, 2)}%`);
  }
  L.push("");

  // 2. 多周期 K线 (摘要 + 最近 N 根)
  L.push("## 2. 多周期 K 线");
  const showK = (tf, candles, n) => {
    if (!candles || !candles.length) return;
    const rows = candles.slice(-n);
    L.push(`### ${tf} (最近 ${rows.length}/${candles.length} 根)`);
    L.push("| 时间 | 开 | 高 | 低 | 收 | 成交额(USDT) |");
    L.push("|---|---:|---:|---:|---:|---:|");
    for (const c of rows) L.push(`| ${c.time} | ${c.open} | ${c.high} | ${c.low} | ${c.close} | ${fmtInt(c.vol_usdt)} |`);
  };
  if (s.candles_tail) {
    if (s.candles_tail.d1?.length)  showK("D1",  s.candles_tail.d1,  s.candles_tail.d1.length);
    if (s.candles_tail.h4?.length)  showK("4H",  s.candles_tail.h4,  s.candles_tail.h4.length);
    if (s.candles_tail.h1?.length)  showK("1H",  s.candles_tail.h1,  s.candles_tail.h1.length);
    if (s.candles_tail.m15?.length) showK("15m", s.candles_tail.m15, s.candles_tail.m15.length);
  }
  L.push("");

  // 3. 技术指标
  L.push("## 3. 技术指标");
  if (s.indicators) {
    const i = s.indicators;
    const row = (tf, x) => {
      if (!x) return null;
      const parts = [
        `MA20=${fmtNum(x.ma20)}`,
        `MA50=${fmtNum(x.ma50)}`,
      ];
      if (x.ma200 != null) parts.push(`MA200=${fmtNum(x.ma200)}`);
      else if (x.ma200_status) parts.push(`MA200=${x.ma200_status}`);
      if (x.atr14 != null) parts.push(`**ATR14=${fmtNum(x.atr14)}**`);
      if (x.boll_mid != null) parts.push(`BOLL[${fmtNum(x.boll_lower)} / ${fmtNum(x.boll_mid)} / ${fmtNum(x.boll_upper)}]`);
      return `- **${tf}**: ${parts.join("  ")}`;
    };
    for (const [tf, label] of [["d1","D1"],["h4","4H"],["h1","1H"],["m15","15m"]]) {
      const line = row(label, i[tf]);
      if (line) L.push(line);
    }
    if (i.vwap_today != null) L.push(`- **当日 VWAP (从 15m 合成)**: ${fmtNum(i.vwap_today)}`);
  }
  L.push("");

  // 4. 关键价位
  L.push("## 4. 关键价位");
  if (s.recent_7d_hl) L.push(`- 近 7 日 H/L: **${s.recent_7d_hl.high}** / **${s.recent_7d_hl.low}**`);
  if (s.week_open) L.push(`- 本周开盘 (${s.week_open.date}): **${s.week_open.open}**`);
  if (s.last_week_hl) L.push(`- 上周 H/L: ${s.last_week_hl.high} / ${s.last_week_hl.low}`);
  if (s.indicators?.vwap_today != null) L.push(`- 当日 VWAP: ${fmtNum(s.indicators.vwap_today)}`);
  if (s.swing?.highs?.length) L.push(`- 最近 swing 高: ${s.swing.highs.map((p) => `${p.price}(${p.time})`).join(" , ")}`);
  if (s.swing?.lows?.length) L.push(`- 最近 swing 低: ${s.swing.lows.map((p) => `${p.price}(${p.time})`).join(" , ")}`);
  if (s.volume_profile) {
    const vp = s.volume_profile;
    L.push(`- **Volume Profile** (近 ${vp.days} 天 / ${vp.bars} 根 1H): **POC=${vp.poc}**  VAH=${vp.vah}  VAL=${vp.val}  区间[${vp.range_low} , ${vp.range_high}]`);
  }
  L.push("");

  // 5. 盘口深度
  L.push("## 5. 盘口深度 (OKX 实时)");
  const showBook = (label, b) => {
    if (!b) { L.push(`### ${label}: 无盘口数据`); return; }
    L.push(`### ${label}  mid=**${b.mid}**  spread=${b.spread}`);
    L.push(`- ±1% 内: 买Σ=${fmtNum(b.bid_sum_1pct_coin, 1)} ${sym} (${fmtUsd(b.bid_sum_1pct_usd)})  卖Σ=${fmtNum(b.ask_sum_1pct_coin, 1)} ${sym} (${fmtUsd(b.ask_sum_1pct_usd)})  imbalance=${b.imbalance_1pct != null ? (b.imbalance_1pct >= 0 ? "+" : "") + b.imbalance_1pct : "—"}`);
    const wall = (arr) => (arr || []).map((w) => `${w.p}=${fmtNum(w.s, 1)}${sym}(${fmtUsd(w.usd)})`).join(" , ");
    if (b.wall_bids?.length) L.push(`- 买墙(±1%内 Top3): ${wall(b.wall_bids)}`);
    if (b.wall_asks?.length) L.push(`- 卖墙(±1%内 Top3): ${wall(b.wall_asks)}`);
    const n = Math.max(b.top_bids.length, b.top_asks.length);
    L.push(`| 档 | 买价 | 买量${sym} | 卖价 | 卖量${sym} |`);
    L.push("|--:|--:|--:|--:|--:|");
    for (let k = 0; k < n; k++) {
      const bd = b.top_bids[k], ak = b.top_asks[k];
      L.push(`| ${k + 1} | ${bd ? bd.p : ""} | ${bd ? fmtNum(bd.s, 2) : ""} | ${ak ? ak.p : ""} | ${ak ? fmtNum(ak.s, 2) : ""} |`);
    }
  };
  if (s.books) {
    showBook("Perp", s.books.perp);
    showBook("Spot", s.books.spot);
  }
  L.push("");

  // 6. 衍生品
  L.push("## 6. 衍生品");
  const d = s.derivatives || {};
  if (d.oi) L.push(`- OI 当前: ${fmtInt(d.oi.current)}  1h 变化: ${fmtPct(d.oi.pct_1h, 3)}  4h 变化: ${fmtPct(d.oi.pct_4h, 3)}`);
  if (d.oi?.series_24h?.length) {
    L.push(`- OI 近 24h (每 1h, 绝对值 + 当时 ${sym} 收盘):`);
    L.push(`| 时间 | OI | ${sym}价 |`);
    L.push("|---|--:|--:|");
    for (const x of d.oi.series_24h) L.push(`| ${x.time} | ${fmtInt(x.oi)} | ${x.px != null ? x.px : "—"} |`);
  }
  if (d.funding) {
    L.push(`- Funding 本期 (到期 ${d.funding.current_settle_time}): **${fmtPct(d.funding.current * 100, 4)}**` +
      (d.funding.last_settled != null ? `  上次实际: ${fmtPct(d.funding.last_settled * 100, 4)}` : "") +
      (d.funding.premium != null ? `  即时溢价: ${fmtPct(d.funding.premium * 100, 4)}` : ""));
  }
  if (d.funding_stats) {
    const fs = d.funding_stats;
    L.push(`- Funding 8h 均=${fmtPct(fs.avg_8h_pct, 4)}  24h 均=${fmtPct(fs.avg_24h_pct, 4)}  7d 均=${fmtPct(fs.avg_7d_pct, 4)}  30d 分位=${fs.percentile_30d}%  连续 ${fs.consecutive_sign}${fs.consecutive_count} 期`);
    if (fs.series_21?.length) {
      L.push(`- Funding 近 21 期 (每 8h, 实际值):`);
      L.push(`  ${fs.series_21.map((x) => `${x.time}=${x.rate_pct >= 0 ? "+" : ""}${x.rate_pct}%`).join(" , ")}`);
    }
  }
  if (s.cross_exchange) {
    const ce = s.cross_exchange;
    L.push(`- 跨交易所 (CoinGecko): Total OI=${fmtUsd(ce.total_oi_usd)}  OI-加权 funding=${fmtPct(ce.oi_weighted_funding_pct, 4)}  Funding 极差=${fmtPct(ce.funding_spread_pct, 4)}`);
    if (ce.top3_by_oi?.length) {
      L.push(`  - Top3 OI:`);
      for (const t of ce.top3_by_oi) L.push(`    - ${t.ex}: OI=${fmtUsd(t.oi)}  funding=${fmtPct(t.funding, 4)}`);
    }
  }
  L.push("");

  // 7. 持仓结构 (max/min/cur/方向 + 24h 每 1h 曲线)
  L.push("## 7. 持仓结构");
  const lsrBlock = (label, arr, extra) => {
    if (!arr?.length) return;
    const t = trendSummary(arr);
    L.push(`- ${label} 近 ${t.n} 点(1h): max=${t.max.toFixed(3)} min=${t.min.toFixed(3)} 当前=**${t.cur.toFixed(3)}** 方向=${t.direction} (first→last ${fmtPct(t.chg_pct, 1)})${extra || ""}`);
    L.push(`  - 曲线(早→近): ${arr.map((x) => x.ratio.toFixed(3)).join(" , ")}`);
  };
  lsrBlock("大户仓位比", d.top_trader_pos_lsr);
  if (d.retail_lsr?.length) {
    const rt = trendSummary(d.retail_lsr);
    const pl = rt.cur / (1 + rt.cur) * 100;
    lsrBlock("散户人数比", d.retail_lsr, ` — 多 ${pl.toFixed(1)}% / 空 ${(100 - pl).toFixed(1)}%`);
    if (d.top_trader_pos_lsr?.length) {
      const tt = d.top_trader_pos_lsr[d.top_trader_pos_lsr.length - 1].ratio;
      L.push(`- 差值 (大户仓位 - 散户当前): ${(tt - rt.cur).toFixed(3)}`);
    }
  }
  L.push("");

  // 8. 主动成交 CVD
  L.push("## 8. 主动成交 (CVD)");
  if (s.cvd) {
    const fmtCvd = (label, x) => {
      if (!x) return;
      L.push(`- ${label}: buy=${fmtInt(x.buy)}  sell=${fmtInt(x.sell)}  **净 delta=${x.delta >= 0 ? "+" : ""}${fmtInt(x.delta)}**  buy/sell ratio=${x.ratio != null ? x.ratio.toFixed(3) : "—"}`);
    };
    fmtCvd("近 15m", s.cvd.last_15m);
    fmtCvd("近 1h", s.cvd.last_1h);
    fmtCvd("近 4h", s.cvd.last_4h);
    fmtCvd("近 24h", s.cvd.last_24h);
  }
  L.push("");

  // 9. 清算
  L.push("## 9. 清算");
  if (s.liquidations) {
    const liq = s.liquidations;
    L.push(`- 过去 ${liq.window_min} 分钟累计 ${liq.count} 笔 (OKX 单边, 含部分清算)`);
    L.push(`- 多单爆: ${liq.long_count} 笔  $${fmtInt(liq.long_usd)}  |  空单爆: ${liq.short_count} 笔  $${fmtInt(liq.short_usd)}`);
    L.push(`- 净 (多-空): ${liq.net_long_minus_short_usd >= 0 ? "+" : "-"}$${fmtInt(Math.abs(liq.net_long_minus_short_usd))}`);
    if (liq.top_price_clusters?.length) {
      L.push(`- 价位聚集 Top5 (0.5% 价格桶):`);
      L.push("  | 价格 | 多爆 $ | 空爆 $ | 合计 $ | 笔数 |");
      L.push("  |---:|---:|---:|---:|---:|");
      for (const b of liq.top_price_clusters) L.push(`  | ${b.price} | ${fmtInt(b.long_usd)} | ${fmtInt(b.short_usd)} | ${fmtInt(b.total_usd)} | ${b.count} |`);
      if (liq.other_clusters) L.push(`  - 其他 ${liq.other_clusters.n} 桶合计: $${fmtInt(liq.other_clusters.usd)} (${liq.other_clusters.count} 笔)`);
    }
  }
  if (s.coinglass?.liquidation_heatmap) {
    L.push(`- Coinglass liq heatmap: 已获取原始 JSON (见 JSON 副本)`);
  }
  L.push("");

  // 10. 现货-合约
  L.push("## 10. 现货-合约");
  if (s.spot && s.perp) L.push(`- OKX 现货: ${s.spot.last}  Perp: ${s.perp.last}  溢价: ${fmtPct(s.basis?.premium_pct, 4)}`);
  if (s.steth) {
    const dev = s.steth.spread_pct_native;
    if (dev != null && Math.abs(dev) > 0.1) L.push(`- ⚠️ stETH/ETH (native): ${s.steth.steth_in_eth}  价差: ${fmtPct(dev, 3)} (偏离 >0.1%)`);
    else L.push(`- stETH/ETH peg: 正常 (偏离 ${fmtPct(dev ?? 0, 3)})`);
  }
  L.push("");

  // 11. 宏观
  L.push("## 11. 宏观");
  if (s.macro) {
    const m = (l, v) => v && L.push(`- ${l}: ${fmtNum(v.current, 2)}  1d=${fmtPct(v.chg_1d_pct, 2)}  5d=${fmtPct(v.chg_5d_pct, 2)}`);
    m("DXY", s.macro.DXY);
    m("NDX", s.macro.NDX);
    m("US10Y (10年期美债收益率%)", s.macro.US10Y);
  }
  L.push("");

  // 12. ETF
  if (s.etf) {
    L.push("## 12. ETH 现货 ETF (Farside)");
    L.push(`- ${s.etf.latest_date} 日 Total: **${fmtNum(s.etf.latest_total_musd, 1)} M USD**`);
    L.push(`- 近 5 日累计: **${fmtNum(s.etf.last_5d_cum_musd, 1)} M USD**`);
    L.push(`- 连续流出: ${s.etf.outflow_streak} 日  |  连续流入: ${s.etf.inflow_streak} 日`);
    L.push("");
  }

  // 12 续 / BTC 参考
  if (s.btc_sync) {
    L.push("## 13. BTC 同步参考");
    L.push(`- 价: ${fmtInt(s.btc_sync.last)}  24h: ${fmtPct(s.btc_sync.chg_pct)}  OI 1h: ${fmtPct(s.btc_sync.oi_pct_1h, 3)}  funding: ${fmtPct(s.btc_sync.funding_current_pct, 4)}`);
    L.push("");
  }

  // 13. 账户输入
  L.push("## 14. 账户参数 (用户手填)");
  const acc = j.account || {};
  L.push(`- 账户净值: **${acc.equity_usdt ? acc.equity_usdt + " USDT" : "—"}**`);
  L.push(`- 单笔最大可承受亏损: **${acc.risk_per_trade_pct != null ? acc.risk_per_trade_pct + "% (≈ " + (acc.equity_usdt ? (acc.equity_usdt * acc.risk_per_trade_pct / 100).toFixed(2) + " USDT" : "—") + ")" : "—"}**`);
  L.push(`- 持仓时长意向: **${acc.holding_horizon || "—"}**`);
  L.push(`- 爆仓容忍 (反向 % 触发强平): **${acc.liq_tolerance_pct != null ? acc.liq_tolerance_pct + "%" : "—"}**`);
  L.push(`- 当前已有头寸: ${acc.existing_positions || "—"}`);
  L.push("");

  if (j.errors) {
    L.push("---");
    L.push("**部分数据源失败**:");
    for (const [k, v] of Object.entries(j.errors)) L.push(`- ${k}: ${v}`);
  }

  return L.join("\n");
}

/* ===========================================================================
 * 主聚合: 并发拉取 + 计算指标 + 装配 snapshot + 渲染 markdown
 * =========================================================================== */
async function buildSnapshot(symbol, account, proxy, sendProgress, proxyAll = false) {
  CORS_PROXY = (proxy || "").trim();
  PROXY_ALL = !!proxyAll;
  const errors = {};
  const wrap = async (label, fn) => {
    try { sendProgress?.(label); return await fn(); }
    catch (e) { errors[label] = e.message || String(e); return null; }
  };
  const swapId = `${symbol}-USDT-SWAP`;
  const spotId = `${symbol}-USDT`;

  const [perpTicker, spotTicker, candles, ctValDyn] = await Promise.all([
    wrap("perp ticker", () => fetchTicker(swapId)),
    wrap("spot ticker", () => fetchTicker(spotId)),
    wrap("multi-TF K线", () => fetchAllCandles(swapId)),
    wrap("合约乘数 ctVal", () => fetchCtVal(swapId)),
  ]);
  // 优先动态值; 拉取失败回落到硬编码表; 都没有则 1 (这种情况盘口/清算的 USD 名义会失真).
  const ctVal = ctValDyn ?? CT_VAL[symbol] ?? 1;

  const indicators = candles ? computeIndicators(candles) : null;
  const swing = candles ? swingPivots(candles.d1, 3, 2) : null; // 只留最近 2 个
  const week = candles ? weekOpen(candles.d1) : null;
  const lastWk = candles ? lastWeekHL(candles.d1) : null;
  const last7 = candles ? recentHL(candles.d1, 7) : null;
  const volProfile = candles ? volumeProfile(candles.h1, 60) : null;

  const [oiHist, retailLsr, topTraderPos, funding, fundingHist, taker5m, liquidations, btcSync, cgDeriv, etf, macro, steth, perpBooks, spotBooks, relative] = await Promise.all([
    wrap("OI history",     () => fetchOiHistory(swapId, "1H", 48)),
    wrap("散户多空比",      () => fetchRetailLsr(symbol, "1H", 24)),
    wrap("大户仓位比",      () => fetchTopTraderPositionRatio(swapId, "1H", 24)),
    wrap("funding 当期",    () => fetchFunding(swapId)),
    wrap("funding 历史",    () => fetchFundingHist(swapId, 100)),
    wrap("taker buckets",  () => fetchTakerBuckets(symbol, "5m", 300)),
    wrap("清算流水",        () => fetchLiquidations(symbol, ctVal)),
    wrap("BTC 同步",        () => symbol !== "BTC" ? fetchBtcSync() : null),
    wrap("跨交易所衍生品",   () => fetchCgDerivatives(symbol)),
    wrap("ETF 流向",        () => symbol === "ETH" ? fetchEtfFlows() : null),
    wrap("宏观 DXY/NDX/US10Y", () => fetchMacro()),
    wrap("stETH 价差",      () => symbol === "ETH" ? fetchStethSpread() : null),
    wrap("Perp 盘口",       () => fetchBooks(swapId, true, ctVal, 10)),
    wrap("Spot 盘口",       () => fetchBooks(spotId, false, ctVal, 10)),
    wrap("ETH/BTC + 市占率", () => fetchRelative(symbol)),
  ]);

  const coinglass = null; // 浏览器版不接入 Coinglass

  const fStats = fundingHist ? fundingStats(fundingHist) : null;
  const cvd = taker5m ? cvdAggregate(taker5m) : null;
  const oi = oiHist ? oiChange(oiHist, candles?.h1) : null;
  let basisOkx = null;
  if (perpTicker && spotTicker) basisOkx = { perp: perpTicker.last, spot: spotTicker.last, premium_pct: ((perpTicker.last - spotTicker.last) / spotTicker.last) * 100 };

  // K 线末尾若干根放进 snapshot (D1 20 / 4H 30 / 1H 48 / 15m 24)
  const tail = candles ? {
    d1: candles.d1.slice(-20),
    h4: candles.h4.slice(-30),
    h1: candles.h1.slice(-48),
    m15: candles.m15.slice(-24),
  } : null;

  const json = {
    generated_at: new Date().toISOString(),
    generated_at_cn: nowCnStr(),
    symbol,
    account,
    snapshot: {
      perp: perpTicker, spot: spotTicker, basis: basisOkx,
      relative,
      candles_meta: candles ? { d1: candles.d1.length, h4: candles.h4.length, h1: candles.h1.length, m15: candles.m15.length } : null,
      candles_tail: tail,
      indicators, swing, week_open: week, last_week_hl: lastWk, recent_7d_hl: last7,
      volume_profile: volProfile,
      books: (perpBooks || spotBooks) ? { perp: perpBooks, spot: spotBooks } : null,
      derivatives: { oi, retail_lsr: retailLsr, top_trader_pos_lsr: topTraderPos, funding, funding_stats: fStats },
      cvd, liquidations,
      cross_exchange: cgDeriv,
      etf, macro, steth,
      btc_sync: btcSync,
      coinglass,
    },
    errors: Object.keys(errors).length ? errors : null,
  };

  return { ok: true, markdown: formatMarkdown(json), json, errors };
}

/* ===========================================================================
 * 浏览器导出: app.js 通过 window.buildSnapshot 调用
 * =========================================================================== */
window.buildSnapshot = buildSnapshot;
