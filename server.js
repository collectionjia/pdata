const express = require('express');
const { createClient } = require('redis');
const path = require('path');

const app = express();
const PORT = 3456;
const REDIS_URL = 'redis://:xytl2024**@1.95.118.218:9002';
const CACHE_KEY = 'polymarket:events';
const CACHE_META_KEY = 'polymarket:meta';
const UPDATE_INTERVAL = 60 * 1000; // 1分钟更新一次

const redis = createClient({ url: REDIS_URL });

// Gamma API 拉取
async function fetchFromGamma(params = {}) {
  const url = new URL('https://gamma-api.polymarket.com/events');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const resp = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error('Gamma API HTTP ' + resp.status);
  const data = await resp.json();
  return Array.isArray(data) ? data : (data.events || data.data || []);
}

// 全量更新缓存
async function refreshCache() {
  try {
    console.log('[刷新] 开始从 Gamma API 拉取数据...');
    const startTime = Date.now();

    let allEvents = [];
    let offset = 0;
    const pageSize = 100;
    const maxPages = 30;

    for (let page = 0; page < maxPages; page++) {
      const batch = await fetchFromGamma({
        active: 'true', closed: 'false',
        limit: String(pageSize),
        offset: String(offset),
        order: 'end_date',
        ascending: 'true'
      });

      allEvents = allEvents.concat(batch);
      if (batch.length < pageSize) break;
      offset += pageSize;
    }

    // 精简数据：只保留前端需要的字段
    const slim = allEvents.map(ev => ({
      id: ev.id,
      slug: ev.slug,
      title: ev.title,
      image: ev.image || ev.icon || '',
      endDate: ev.endDate,
      volume: ev.volume,
      volume24hr: ev.volume24hr,
      liquidity: ev.liquidity,
      openInterest: ev.openInterest,
      tags: (ev.tags || []).map(t => t.label || t.slug || t),
      markets: (ev.markets || []).map(m => ({
        id: m.id,
        slug: m.slug,
        question: m.question,
        groupItemTitle: m.groupItemTitle,
        outcomes: typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : (m.outcomes || []),
        outcomePrices: typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : (m.outcomePrices || []),
        volume: m.volume || m.volumeNum,
        clobTokenIds: typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : (m.clobTokenIds || []),
        negRisk: !!m.negRisk,
        active: m.active,
        closed: m.closed
      }))
    }));

    const json = JSON.stringify(slim);
    await redis.set(CACHE_KEY, json);
    await redis.set(CACHE_META_KEY, JSON.stringify({
      updatedAt: new Date().toISOString(),
      count: slim.length,
      fetchTimeMs: Date.now() - startTime
    }));

    console.log(`[刷新] 完成，共 ${slim.length} 个事件，耗时 ${Date.now() - startTime}ms`);
  } catch (e) {
    console.error('[刷新] 失败:', e.message);
  }
}

// API 路由
app.get('/api/events', async (req, res) => {
  try {
    const data = await redis.get(CACHE_KEY);
    if (!data) {
      return res.json({ success: false, error: '缓存为空，请等待首次刷新', events: [] });
    }
    const events = JSON.parse(data);

    // 支持服务端筛选
    let result = events;
    const { tag, search, minVol, hours, sort, page, limit } = req.query;

    if (tag && tag !== 'all') {
      const TAG_MAP = {
        politics: ['Politics', 'Geopolitics', 'Elections', 'Global Elections', 'US Election', 'Main Election', 'Foreign Policy', 'World Elections', 'Primaries'],
        crypto: ['Crypto', 'Airdrops'],
        finance: ['Finance', 'Business', 'Stocks', 'IPOs', 'exchange', 'Earn 4%', 'Pre-Market'],
        tech: ['Tech', 'AI'],
        culture: ['Culture', 'Entertainment'],
        economy: ['Economy'],
        weather: ['Weather'],
      };
      const matchTags = TAG_MAP[tag] || [];
      if (matchTags.length > 0) {
        result = result.filter(ev => ev.tags.some(t => matchTags.includes(t)));
      }
    }

    if (search) {
      const q = search.toLowerCase();
      result = result.filter(ev => (ev.title || '').toLowerCase().includes(q));
    }

    if (minVol) {
      const mv = parseFloat(minVol);
      result = result.filter(ev => parseFloat(ev.volume || 0) >= mv);
    }

    if (hours) {
      const h = parseFloat(hours);
      if (h > 0) {
        const maxEnd = new Date(Date.now() + h * 3600000).toISOString();
        result = result.filter(ev => ev.endDate <= maxEnd);
      }
    }

    // 排序
    if (sort === 'volume') result.sort((a, b) => parseFloat(b.volume || 0) - parseFloat(a.volume || 0));
    else if (sort === 'volume24hr') result.sort((a, b) => parseFloat(b.volume24hr || 0) - parseFloat(a.volume24hr || 0));
    else if (sort === 'liquidity') result.sort((a, b) => parseFloat(b.liquidity || 0) - parseFloat(a.liquidity || 0));
    else result.sort((a, b) => new Date(a.endDate) - new Date(b.endDate)); // 默认按结束时间升序

    const total = result.length;
    const p = parseInt(page) || 1;
    const l = parseInt(limit) || 50;
    const start = (p - 1) * l;
    const paged = result.slice(start, start + l);

    // 元数据
    const metaRaw = await redis.get(CACHE_META_KEY);
    const meta = metaRaw ? JSON.parse(metaRaw) : {};

    res.json({
      success: true,
      total,
      page: p,
      limit: l,
      totalPages: Math.ceil(total / l),
      updatedAt: meta.updatedAt,
      cacheCount: meta.count,
      events: paged
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 缓存状态
app.get('/api/status', async (req, res) => {
  const metaRaw = await redis.get(CACHE_META_KEY);
  const meta = metaRaw ? JSON.parse(metaRaw) : {};
  res.json({
    redis: 'connected',
    cacheKey: CACHE_KEY,
    updatedAt: meta.updatedAt || null,
    eventCount: meta.count || 0,
    fetchTimeMs: meta.fetchTimeMs || 0,
    updateInterval: UPDATE_INTERVAL
  });
});

// 手动触发刷新
app.post('/api/refresh', async (req, res) => {
  refreshCache();
  res.json({ success: true, message: '刷新已触发' });
});

// 静态文件
app.use(express.static(path.join(__dirname)));

async function main() {
  await redis.connect();
  console.log('[Redis] 已连接');

  // 首次加载
  await refreshCache();

  // 定时刷新
  setInterval(refreshCache, UPDATE_INTERVAL);

  app.listen(PORT, () => {
    console.log(`[服务] http://localhost:${PORT}`);
    console.log(`[服务] 市场查询页面: http://localhost:${PORT}/polymarket_market_query.html`);
    console.log(`[服务] API: http://localhost:${PORT}/api/events`);
    console.log(`[服务] 缓存每 ${UPDATE_INTERVAL / 1000}s 自动刷新`);
  });
}

main().catch(e => {
  console.error('启动失败:', e);
  process.exit(1);
});
