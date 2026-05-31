/**
 * 本地服务 + Gamma API 代理（解决 file:// 与 CORS 问题）
 * 启动: node markets-server.mjs
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3457;
const HOST = process.env.HOST || '0.0.0.0';
/** 槽结果/虚拟投注日志目录（Docker 可挂载 /data） */
const DATA_DIR = process.env.DATA_DIR || __dirname;
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  console.error('[DATA_DIR] 无法创建日志目录:', DATA_DIR, e.message || e);
}
const GAMMA = 'https://gamma-api.polymarket.com/events';
const DATA_API = 'https://data-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const RELAYER = 'https://relayer-v2.polymarket.com';
/** 与 polymarket.com/crypto/5M 、/crypto/15M 页头一致 */
const CRYPTO_PAGE_COINS = ['btc', 'eth', 'sol', 'xrp', 'doge', 'hype', 'bnb'];
const CRYPTO_PAGE_INTERVALS = { '5M': 5, '15M': 15 };
const CRYPTO_5M_RESULT_LOG = path.join(DATA_DIR, 'crypto-5m-slot-results.txt');
const CRYPTO_5M_VIRTUAL_LOG = path.join(DATA_DIR, 'crypto-5m-virtual-bet.txt');
const CRYPTO_5M_VIRTUAL_ORDERS = path.join(DATA_DIR, 'crypto-5m-virtual-orders.txt');
const CRYPTO_15M_RESULT_LOG = path.join(DATA_DIR, 'crypto-15m-slot-results.txt');
const CRYPTO_15M_VIRTUAL_LOG = path.join(DATA_DIR, 'crypto-15m-virtual-bet.txt');
const CRYPTO_15M_VIRTUAL_ORDERS = path.join(DATA_DIR, 'crypto-15m-virtual-orders.txt');
const CRYPTO_SLOT_LOG_FILES = {
  '5M': { result: CRYPTO_5M_RESULT_LOG, virtual: CRYPTO_5M_VIRTUAL_LOG, orders: CRYPTO_5M_VIRTUAL_ORDERS },
  '15M': { result: CRYPTO_15M_RESULT_LOG, virtual: CRYPTO_15M_VIRTUAL_LOG, orders: CRYPTO_15M_VIRTUAL_ORDERS },
};
const POLYMARKET_ORIGIN = 'https://polymarket.com';
const RTDS_URL = 'wss://ws-live-data.polymarket.com';
const COIN_CHAINLINK = {
  btc: 'btc/usd',
  eth: 'eth/usd',
  sol: 'sol/usd',
  xrp: 'xrp/usd',
  doge: 'doge/usd',
  hype: 'hype/usd',
  bnb: 'bnb/usd',
};
const chainlinkSpot = new Map();
const ptbCache = new Map();
/** 槽开盘时由 Chainlink 首笔 tick 捕获的 PTB（Gamma 未返回时的备用） */
const ptbBySlug = new Map();
const CHAINLINK_SYMBOLS = Object.values(COIN_CHAINLINK);
const CHAINLINK_TO_COIN = Object.fromEntries(
  Object.entries(COIN_CHAINLINK).map(([coin, sym]) => [sym, coin]),
);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

async function fetchEventBySlug(slug) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const headers = { Accept: 'application/json', 'User-Agent': 'polymarket-markets-local/1.0' };
    const qResp = await fetch(`${GAMMA}?slug=${encodeURIComponent(slug)}`, {
      signal: ctrl.signal,
      headers,
    });
    let fromQuery = null;
    if (qResp.ok) {
      const arr = await qResp.json();
      if (Array.isArray(arr) && arr.length) fromQuery = arr[0];
    }

    const resp = await fetch(`${GAMMA}/slug/${encodeURIComponent(slug)}`, {
      signal: ctrl.signal,
      headers,
    });
    if (resp.status === 404) {
      clearTimeout(timer);
      return fromQuery;
    }
    if (!resp.ok) throw new Error('Gamma HTTP ' + resp.status);
    const bySlug = await resp.json();
    clearTimeout(timer);

    if (!bySlug && fromQuery) return fromQuery;
    if (bySlug && fromQuery) {
      if (!bySlug.eventMetadata && fromQuery.eventMetadata) bySlug.eventMetadata = fromQuery.eventMetadata;
      if ((!bySlug.markets || !bySlug.markets.length) && Array.isArray(fromQuery.markets)) bySlug.markets = fromQuery.markets;
    }
    return bySlug || fromQuery;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

function currentCryptoSlotTs(intervalMin, nowSec = Math.floor(Date.now() / 1000)) {
  const sec = intervalMin * 60;
  return Math.floor(nowSec / sec) * sec;
}

function slugSlotTs(slug, intervalMin) {
  const m = (slug || '').toLowerCase().match(new RegExp(`-updown-${intervalMin}m-(\\d+)$`));
  return m ? parseInt(m[1], 10) : null;
}

/** 仅当前时间槽、已开盘、未结束、可下单 */
function isCryptoEventTradable(ev, intervalMin, nowMs = Date.now()) {
  if (!ev?.id) return false;
  if (ev.closed === true) return false;
  if (ev.active === false) return false;

  const currentTs = currentCryptoSlotTs(intervalMin, Math.floor(nowMs / 1000));
  if (slugSlotTs(ev.slug, intervalMin) !== currentTs) return false;

  const endMs = ev.endDate ? new Date(ev.endDate).getTime() : NaN;
  if (!Number.isNaN(endMs) && endMs <= nowMs) return false;

  const tradeStart = ev.eventStartTime || ev.startTime;
  const startMs = tradeStart
    ? new Date(tradeStart).getTime()
    : ev.startDate
      ? new Date(ev.startDate).getTime()
      : 0;
  if (startMs && startMs > nowMs) return false;

  const markets = ev.markets || [];
  if (!markets.length) return false;
  const hasOpen = markets.some(
    (m) => m.closed !== true && m.active !== false && m.acceptingOrders !== false,
  );
  return hasOpen;
}

function coinFromSlug(slug) {
  const m = (slug || '').toLowerCase().match(/^([a-z]+)-updown-/);
  return m ? m[1] : null;
}

function chainlinkSymbolForCoin(coin) {
  return COIN_CHAINLINK[(coin || '').toLowerCase()] || null;
}

function gammaPtbFromEvent(ev) {
  const v = ev?.eventMetadata?.priceToBeat;
  if (v == null) return null;
  const n = +v;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function cachePtb(slug, price, source) {
  const entry = { price, source, fetchedAt: Date.now() };
  ptbCache.set(slug, entry);
  return entry;
}

function captureSlotOpenPtb(coin, value, tsMs) {
  if (!coin || !Number.isFinite(value) || value <= 0) return;
  const ts = tsMs || Date.now();
  for (const intervalMin of [5, 15]) {
    const sec = intervalMin * 60;
    const slotTs = Math.floor(ts / 1000 / sec) * sec;
    const slug = `${coin}-updown-${intervalMin}m-${slotTs}`;
    if (ptbBySlug.has(slug)) continue;
    const slotStartMs = slotTs * 1000;
    if (ts < slotStartMs) continue;
    const entry = { price: value, source: 'chainlink:slot-open', fetchedAt: Date.now() };
    ptbBySlug.set(slug, entry);
    if (!ptbCache.has(slug)) ptbCache.set(slug, entry);
  }
}

async function fetchPriceToBeat(slug) {
  const cached = ptbCache.get(slug);
  if (cached && Date.now() - cached.fetchedAt < 20000) return cached;

  try {
    const ev = await fetchEventBySlug(slug);
    const gammaPtb = gammaPtbFromEvent(ev);
    if (gammaPtb != null) return cachePtb(slug, gammaPtb, 'gamma:eventMetadata');
  } catch (_) {}

  const slotPtb = ptbBySlug.get(slug);
  if (slotPtb?.price > 0) {
    return { price: slotPtb.price, source: slotPtb.source || 'chainlink:slot-open', fetchedAt: slotPtb.fetchedAt || Date.now() };
  }

  return cached || null;
}

function getChainlinkSpot(symbol) {
  if (!symbol) return null;
  const hit = chainlinkSpot.get(String(symbol).toLowerCase());
  if (!hit || Date.now() - hit.ts > 120000) return null;
  return hit;
}

function recordChainlinkTick(sym, value, tsMs) {
  const ts = tsMs || Date.now();
  chainlinkSpot.set(sym, { value, ts });
  const coin = CHAINLINK_TO_COIN[sym];
  if (coin) captureSlotOpenPtb(coin, value, ts);
}

async function getCurrentSpotForCoin(coin) {
  const sym = chainlinkSymbolForCoin(coin);
  const cl = getChainlinkSpot(sym);
  if (cl) return { price: cl.value, source: 'chainlink', symbol: sym, ts: cl.ts, ageMs: Date.now() - cl.ts };
  return null;
}

async function buildSpotPriceRow(slug) {
  const coin = coinFromSlug(slug);
  if (!coin) return { slug, error: 'unknown coin' };
  const sym = chainlinkSymbolForCoin(coin);
  const [ptb, currentResolved] = await Promise.all([fetchPriceToBeat(slug), getCurrentSpotForCoin(coin)]);
  const targetPrice = ptb?.price ?? null;
  const currentPrice = currentResolved?.price ?? null;
  let diff = null;
  let diffPct = null;
  if (targetPrice != null && currentPrice != null) {
    diff = currentPrice - targetPrice;
    diffPct = targetPrice !== 0 ? (diff / targetPrice) * 100 : null;
  }
  return {
    slug,
    coin,
    chainlinkSymbol: sym,
    targetPrice,
    targetSource: ptb?.source || null,
    currentPrice,
    currentSource: currentResolved?.source || null,
    diff,
    diffPct,
    updatedAt: Date.now(),
  };
}

/** Node 20 无全局 WebSocket，从内置 undici 加载；Node 21+ 可直接用 global */
async function resolveRtdsWebSocket() {
  if (typeof WebSocket !== 'undefined') return WebSocket;
  try {
    const { WebSocket: UndiciWebSocket } = await import('undici');
    if (UndiciWebSocket) return UndiciWebSocket;
  } catch (e) {
    console.warn('[RTDS] undici WebSocket 加载失败:', e.message || e);
  }
  return null;
}

async function startChainlinkFeed() {
  const WS = await resolveRtdsWebSocket();
  if (!WS) {
    console.warn('[RTDS] 无 WebSocket，现价将无法更新（请使用 Node 18+ 并确保 undici 可用）');
    return;
  }
  let loggedFirstTick = false;
  const connect = () => {
    let ws;
    try {
      ws = new WS(RTDS_URL);
    } catch (e) {
      console.warn('[RTDS] WebSocket 连接失败:', e.message || e);
      setTimeout(connect, 4000);
      return;
    }
    ws.addEventListener('open', () => {
      console.log('[RTDS] 已连接，订阅 Chainlink:', CHAINLINK_SYMBOLS.join(', '));
      const subscriptions = CHAINLINK_SYMBOLS.map((symbol) => ({
        topic: 'crypto_prices_chainlink',
        type: '*',
        filters: JSON.stringify({ symbol }),
      }));
      ws.send(JSON.stringify({ action: 'subscribe', subscriptions }));
    });
    ws.addEventListener('message', (ev) => {
      const text = String(ev.data).trim();
      if (!text || text === 'PING' || text === 'PONG' || text === 'ping' || text === 'pong') return;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.topic !== 'crypto_prices_chainlink' || !msg.payload?.symbol) return;
      const sym = String(msg.payload.symbol).toLowerCase();
      const value = parseFloat(msg.payload.value);
      if (!Number.isFinite(value) || value <= 0) return;
      const ts = msg.payload.timestamp || msg.timestamp || Date.now();
      recordChainlinkTick(sym, value, ts);
      if (!loggedFirstTick) {
        loggedFirstTick = true;
        console.log('[RTDS] Chainlink 首笔:', sym, value);
      }
    });
    ws.addEventListener('close', () => setTimeout(connect, 4000));
    ws.addEventListener('error', () => ws.close());
    const pingIv = setInterval(() => {
      if (ws.readyState === 1) ws.send('PING');
      else clearInterval(pingIv);
    }, 5000);
  };
  connect();
}

async function loadCryptoPageEvents(intervalKey) {
  const intervalMin = CRYPTO_PAGE_INTERVALS[intervalKey];
  if (!intervalMin) return [];

  const currentTs = currentCryptoSlotTs(intervalMin);
  const nowMs = Date.now();
  const events = [];

  for (const coin of CRYPTO_PAGE_COINS) {
    const slug = `${coin}-updown-${intervalMin}m-${currentTs}`;
    try {
      const ev = await fetchEventBySlug(slug);
      if (isCryptoEventTradable(ev, intervalMin, nowMs)) events.push(ev);
    } catch {
      /* 当前时间槽可能尚未创建 */
    }
  }

  return events.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
}

async function proxyEvents(query) {
  const url = GAMMA + '?' + query;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'polymarket-markets-local/1.0' },
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error('Gamma API HTTP ' + resp.status);
    const data = await resp.json();
    return { ok: true, data: Array.isArray(data) ? data : [] };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: e.message || String(e) };
  }
}

const server = http.createServer((req, res) => {
  const pathOnly = (req.url || '/').split('?')[0];

  // 同步 health，避免 async 处理器或 Docker 探活异常
  if (pathOnly === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      port: PORT,
      host: HOST,
      uptimeSec: Math.floor(process.uptime()),
      dataDir: DATA_DIR,
    });
  }

  void handleHttpRequest(req, res).catch((e) => {
    console.error('[HTTP]', req.method, req.url, e);
    if (!res.headersSent) sendJson(res, 500, { error: e.message || String(e) });
    else res.end();
  });
});

async function handleHttpRequest(req, res) {
  try {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    return res.end();
  }

  async function readJsonBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  /** 统一转发 /api/relayer/* → relayer-v2.polymarket.com（避免路径拼写导致 404） */
  const relayerPath = url.pathname.startsWith('/api/relayer')
    ? url.pathname.slice('/api/relayer'.length).replace(/\/+$/, '') || '/'
    : null;

  if (relayerPath !== null) {
    const upstream = `${RELAYER}${relayerPath}${url.search}`;

    if (relayerPath === '/submit') {
      if (req.method === 'OPTIONS') return res.end();
      if (req.method !== 'POST') {
        return sendJson(res, 405, { error: 'POST only', path: relayerPath });
      }
      try {
        const body = await readJsonBody(req);
        const { request, relayerApiKey, relayerApiKeyAddress } = body;
        if (!request) return sendJson(res, 400, { error: 'missing request' });
        if (!relayerApiKey) return sendJson(res, 400, { error: 'missing relayerApiKey' });
        const resp = await fetch(`${RELAYER}/submit`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            RELAYER_API_KEY: relayerApiKey,
            RELAYER_API_KEY_ADDRESS: relayerApiKeyAddress || request.from || '',
            'User-Agent': 'polymarket-markets-local/1.0',
          },
          body: JSON.stringify(request),
        });
        const text = await resp.text();
        let data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          data = { error: text.slice(0, 300) };
        }
        return sendJson(res, resp.ok ? 200 : resp.status, data);
      } catch (e) {
        return sendJson(res, 502, { error: e.message || String(e) });
      }
    }

    if (req.method === 'GET') {
      try {
        const resp = await fetch(upstream, {
          headers: { Accept: 'application/json', 'User-Agent': 'polymarket-markets-local/1.0' },
        });
        const text = await resp.text();
        let data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          data = { error: text.slice(0, 300) };
        }
        if (!resp.ok) {
          return sendJson(res, resp.status, {
            error: data.error || `upstream HTTP ${resp.status}`,
            path: relayerPath,
            upstream,
          });
        }
        return sendJson(res, 200, data);
      } catch (e) {
        return sendJson(res, 502, { error: e.message || String(e), upstream });
      }
    }

    return sendJson(res, 405, { error: 'method not allowed', path: relayerPath });
  }

  if (url.pathname === '/api/events') {
    const result = await proxyEvents(url.searchParams.toString());
    if (!result.ok) return sendJson(res, 502, { success: false, error: result.error, events: [] });
    return sendJson(res, 200, { success: true, events: result.data });
  }

  if (url.pathname === '/api/health/gamma') {
    const result = await proxyEvents('active=true&closed=false&limit=1');
    return sendJson(res, result.ok ? 200 : 502, { gamma: result.ok, error: result.error || null });
  }

  if (url.pathname === '/api/clob/book' || url.pathname === '/api/clob/price') {
    const tokenId = url.searchParams.get('token_id');
    if (!tokenId) return sendJson(res, 400, { error: 'missing token_id' });
    const clobPath = url.pathname === '/api/clob/price' ? 'price' : 'book';
    const qs = url.searchParams.toString();
    const proxyUrl = `${CLOB}/${clobPath}?${qs}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const resp = await fetch(proxyUrl, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'polymarket-markets-local/1.0' },
      });
      clearTimeout(timer);
      if (!resp.ok) return sendJson(res, resp.status, { error: 'CLOB HTTP ' + resp.status });
      return sendJson(res, 200, await resp.json());
    } catch (e) {
      clearTimeout(timer);
      return sendJson(res, 502, { error: e.message || String(e) });
    }
  }

  if (url.pathname === '/api/v1/leaderboard' || url.pathname === '/api/data/trades') {
    const isLeaderboard = url.pathname === '/api/v1/leaderboard';
    const pathCandidates = isLeaderboard ? ['/v1/leaderboard', '/leaderboard'] : ['/trades'];
    const qs = url.searchParams.toString();
    let lastError = 'Data API 无响应';

    function normalizeDataApiList(payload) {
      if (Array.isArray(payload)) return payload;
      if (payload && typeof payload === 'object') {
        for (const key of ['data', 'leaderboard', 'traders', 'results', 'items', 'entries']) {
          if (Array.isArray(payload[key])) return payload[key];
        }
      }
      return [];
    }

    for (const apiPath of pathCandidates) {
      const proxyUrl = `${DATA_API}${apiPath}${qs ? `?${qs}` : ''}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000);
      try {
        const resp = await fetch(proxyUrl, {
          signal: ctrl.signal,
          headers: { Accept: 'application/json', 'User-Agent': 'polymarket-markets-local/1.0' },
        });
        clearTimeout(timer);
        const text = await resp.text();
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          lastError = `JSON 解析失败 (${apiPath})`;
          continue;
        }
        if (!resp.ok) {
          lastError = parsed?.error || `Data API HTTP ${resp.status} (${apiPath})`;
          continue;
        }
        const list = normalizeDataApiList(parsed);
        const isLast = apiPath === pathCandidates[pathCandidates.length - 1];
        if (list.length > 0 || isLast) {
          return sendJson(res, 200, {
            success: true,
            data: list,
            source: apiPath,
            count: list.length,
          });
        }
        lastError = `空列表 (${apiPath})`;
      } catch (e) {
        clearTimeout(timer);
        lastError = e.message || String(e);
      }
    }

    return sendJson(res, 502, { success: false, error: lastError, data: [] });
  }

  if (
    url.pathname === '/api/positions' ||
    url.pathname === '/api/value' ||
    url.pathname === '/api/closed-positions'
  ) {
    const user = url.searchParams.get('user');
    if (!user) return sendJson(res, 400, { error: 'missing user' });
    const apiPath =
      url.pathname === '/api/value'
        ? 'value'
        : url.pathname === '/api/closed-positions'
          ? 'closed-positions'
          : 'positions';
    const qs = new URLSearchParams(url.searchParams);
    const proxyUrl = `${DATA_API}/${apiPath}?${qs.toString()}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const emptyKey =
      apiPath === 'value' ? 'value' : apiPath === 'closed-positions' ? 'closedPositions' : 'positions';
    try {
      const resp = await fetch(proxyUrl, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'polymarket-markets-local/1.0' },
      });
      clearTimeout(timer);
      if (!resp.ok) {
        return sendJson(res, resp.status, { error: 'Data API HTTP ' + resp.status, [emptyKey]: [] });
      }
      const data = await resp.json();
      return sendJson(res, 200, { success: true, [emptyKey]: data });
    } catch (e) {
      clearTimeout(timer);
      return sendJson(res, 502, { success: false, error: e.message || String(e), [emptyKey]: [] });
    }
  }

  const slotLogMatch = url.pathname.match(/^\/api\/crypto-slot-log\/(5M|15M)$/);
  if (slotLogMatch && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const text = typeof body.text === 'string' ? body.text : '';
      if (!text.trim()) return sendJson(res, 400, { success: false, error: 'empty text' });
      const kind = body.kind === 'virtual' ? 'virtual' : 'result';
      const files = CRYPTO_SLOT_LOG_FILES[slotLogMatch[1]];
      if (!files) return sendJson(res, 400, { success: false, error: 'unknown interval' });
      const target = kind === 'virtual' ? files.virtual : files.result;
      await fs.promises.appendFile(target, text.endsWith('\n') ? text : text + '\n', 'utf8');
      return sendJson(res, 200, {
        success: true,
        kind,
        interval: slotLogMatch[1],
        file: path.basename(target),
        path: target,
      });
    } catch (e) {
      return sendJson(res, 500, { success: false, error: e.message || String(e) });
    }
  }

  const virtualOrdersMatch = url.pathname.match(/^\/api\/crypto-virtual-orders\/(5M|15M)$/);
  if (virtualOrdersMatch && (req.method === 'PUT' || req.method === 'POST')) {
    try {
      const body = await readJsonBody(req);
      const csv = typeof body.csv === 'string' ? body.csv : '';
      const files = CRYPTO_SLOT_LOG_FILES[virtualOrdersMatch[1]];
      if (!files?.orders) return sendJson(res, 400, { success: false, error: 'unknown interval' });
      await fs.promises.writeFile(files.orders, csv, 'utf8');
      return sendJson(res, 200, {
        success: true,
        interval: virtualOrdersMatch[1],
        file: path.basename(files.orders),
        path: files.orders,
        bytes: Buffer.byteLength(csv, 'utf8'),
      });
    } catch (e) {
      return sendJson(res, 500, { success: false, error: e.message || String(e) });
    }
  }

  const cryptoPageMatch = url.pathname.match(/^\/api\/crypto-page\/(5M|15M)$/);
  if (cryptoPageMatch) {
    try {
      const events = await loadCryptoPageEvents(cryptoPageMatch[1]);
      return sendJson(res, 200, {
        success: true,
        interval: cryptoPageMatch[1],
        source: `https://polymarket.com/crypto/${cryptoPageMatch[1]}`,
        count: events.length,
        events,
      });
    } catch (e) {
      return sendJson(res, 502, { success: false, error: e.message || String(e), events: [] });
    }
  }

  if (url.pathname === '/api/crypto-chainlink-spot') {
    const symbol = (url.searchParams.get('symbol') || '').toLowerCase();
    const hit = getChainlinkSpot(symbol);
    if (!hit) return sendJson(res, 200, { success: true, symbol, price: null });
    return sendJson(res, 200, { success: true, symbol, price: hit.value, ts: hit.ts });
  }

  if (url.pathname === '/api/crypto-price-to-beat') {
    const slug = url.searchParams.get('slug');
    if (!slug) return sendJson(res, 400, { success: false, error: 'missing slug' });
    try {
      const ev = await fetchEventBySlug(slug);
      const gammaPtb = gammaPtbFromEvent(ev);
      if (gammaPtb == null) return sendJson(res, 200, { success: true, slug, price: null, source: null });
      return sendJson(res, 200, { success: true, slug, price: gammaPtb, source: 'gamma:eventMetadata' });
    } catch (e) {
      return sendJson(res, 502, { success: false, error: e.message || String(e) });
    }
  }

  if (url.pathname === '/api/crypto-spot-prices' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const slugs = Array.isArray(body.slugs) ? body.slugs.filter(Boolean) : [];
      if (!slugs.length) return sendJson(res, 400, { success: false, error: 'empty slugs' });
      const rows = await Promise.all(slugs.map((slug) => buildSpotPriceRow(slug)));
      const prices = {};
      for (const row of rows) prices[row.slug] = row;
      return sendJson(res, 200, { success: true, prices });
    } catch (e) {
      return sendJson(res, 502, { success: false, error: e.message || String(e) });
    }
  }

  if (url.pathname.startsWith('/api/event-slug/')) {
    const slug = decodeURIComponent(url.pathname.slice('/api/event-slug/'.length));
    try {
      const data = await fetchEventBySlug(slug);
      if (!data) return sendJson(res, 404, { success: false, error: 'not found' });
      return sendJson(res, 200, { success: true, event: data });
    } catch (e) {
      return sendJson(res, 502, { success: false, error: e.message || String(e) });
    }
  }

  let filePath = url.pathname;
  if (filePath === '/') filePath = '/polymarket_active_markets.html';
  const abs = path.join(__dirname, filePath.replace(/^\//, ''));
  if (!abs.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(abs, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found: ' + filePath);
    }
    const ext = path.extname(abs);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
  } catch (e) {
    console.error('[HTTP]', req.method, req.url, e);
    if (!res.headersSent) sendJson(res, 500, { error: e.message || String(e) });
    else res.end();
  }
}

process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

server.on('error', (e) => {
  console.error('[server]', e);
  process.exit(1);
});

startChainlinkFeed().catch((e) => console.error('[RTDS] 启动失败:', e));

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Polymarket 市场列表已启动');
  console.log(`  监听: http://${HOST}:${PORT}`);
  console.log('  在浏览器打开:');
  console.log(`  http://localhost:${PORT}/polymarket_active_markets.html`);
  console.log(`  http://localhost:${PORT}/polymarket_crypto_5m.html`);
  console.log(`  http://localhost:${PORT}/polymarket_crypto_15m.html`);
  console.log(`  http://localhost:${PORT}/polymarket_traders.html`);
  console.log(`  5M 槽结果日志: ${CRYPTO_5M_RESULT_LOG}`);
  console.log(`  5M 虚拟投注日志: ${CRYPTO_5M_VIRTUAL_LOG}`);
  console.log(`  Relayer 代理: http://localhost:${PORT}/api/relayer/relay-payload`);
  console.log('');
});
