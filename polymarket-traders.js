/**
 * 交易列表 · Polymarket Data API
 */
(function (global) {
  const $ = (id) => document.getElementById(id);

  const LB_CATEGORY_ZH = {
    OVERALL: '全部',
    CRYPTO: '加密',
    POLITICS: '政治',
    SPORTS: '体育',
    CULTURE: '文化',
    MENTIONS: '提及',
    WEATHER: '天气',
    ECONOMICS: '经济',
    TECH: '科技',
    FINANCE: '金融',
  };

  const LB_PERIOD_ZH = {
    DAY: '今日',
    WEEK: '本周',
    MONTH: '本月',
    ALL: '全部时间',
  };

  const LB_ORDER_ZH = { PNL: '盈亏', VOL: '成交量' };

  const SIDE_ZH = { BUY: '买入', SELL: '卖出' };

  const MARKETS_PORT = '3457';
  const DATA_API_ORIGIN = 'https://data-api.polymarket.com';
  const ADV_FILTER_COLLAPSE_KEY = 'pm_traders_adv_filter_collapsed';

  const FILTER_DEFS = [
    { id: 'pnl', label: '总盈亏 PNL', needsStats: false, get: (r) => parseFloat(r.pnl) },
    { id: 'netWorth', label: '当前净值', needsStats: true, get: (r) => r.stats?.netWorth },
    { id: 'active', label: '活跃持仓', needsStats: true, get: (r) => r.stats?.activeCount, integer: true },
    { id: 'gain', label: '总盈利', needsStats: true, get: (r) => r.stats?.gain },
    { id: 'loss', label: '总亏损', needsStats: true, get: (r) => r.stats?.loss },
    { id: 'positions', label: '持仓数', needsStats: true, get: (r) => r.stats?.positionCount, integer: true },
    { id: 'winPct', label: '胜率 %', needsStats: true, get: (r) => r.stats?.winPct, pct: true },
  ];

  const state = {
    view: 'leaderboard',
    loading: false,
    leaderboard: [],
    leaderboardAll: [],
    trades: [],
    selectedWallet: null,
    offset: 0,
    limit: 50,
    lastFetchSource: '',
    clientFilterActive: false,
    watchSet: new Set(),
    filterBounds: {},
  };

  /** 行情页本地服务；非 3457 端口打开 html 时也必须指向 markets-server */
  function apiBase() {
    const custom = (localStorage.getItem('pm_markets_api_base') || '').replace(/\/$/, '');
    if (custom) return custom;
    if (location.protocol === 'file:') return `http://localhost:${MARKETS_PORT}`;
    const host = location.hostname || 'localhost';
    const port = location.port || (location.protocol === 'https:' ? '443' : '80');
    if ((host === 'localhost' || host === '127.0.0.1') && port === MARKETS_PORT) {
      return '';
    }
    if (host === 'localhost' || host === '127.0.0.1') {
      return `http://${host}:${MARKETS_PORT}`;
    }
    return '';
  }

  function showPageOriginHint() {
    const el = $('pageOriginHint');
    if (!el) return;
    const port = location.port || (location.protocol === 'https:' ? '443' : '80');
    const onMarkets =
      location.protocol !== 'file:' &&
      (location.port === MARKETS_PORT || (location.port === '' && location.hostname === 'localhost'));
    if (onMarkets) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.innerHTML = `当前页面不在 <code>http://localhost:${MARKETS_PORT}</code> 打开。数据将走本地代理 <code>${esc(apiBase() || `http://localhost:${MARKETS_PORT}`)}</code>；请先运行 <code>start-markets.bat</code>。`;
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function shortAddr(addr) {
    if (!addr || addr.length < 12) return addr || '—';
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  }

  function formatUsd(n) {
    if (n == null || Number.isNaN(n)) return '—';
    const abs = Math.abs(Number(n));
    const sign = Number(n) < 0 ? '-' : '';
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
    return `${sign}$${abs.toFixed(2)}`;
  }

  function formatUsdPlain(n) {
    if (n == null || Number.isNaN(n)) return '—';
    return `$${Number(n).toFixed(2)}`;
  }

  async function refreshTradersBalance() {
    const usdcEl = $('tradersBalanceUsdc');
    const totalEl = $('tradersBalanceTotal');
    const pill = $('tradersBalancePill');
    if (!usdcEl) return;
    const trade = global.PMTrade;
    if (!trade?.isReady?.()) {
      usdcEl.textContent = '未连接';
      if (totalEl) totalEl.textContent = '—';
      pill?.classList.add('disconnected');
      usdcEl.title = '请配置钱包并连接';
      return;
    }
    pill?.classList.remove('disconnected');
    usdcEl.textContent = '…';
    if (totalEl) totalEl.textContent = '…';
    try {
      const usdc = await trade.fetchUsdcBalance();
      usdcEl.textContent = formatUsdPlain(usdc);
      usdcEl.title = '';
      if (totalEl && trade.fetchPortfolioSummary) {
        const sum = await trade.fetchPortfolioSummary();
        totalEl.textContent =
          sum.portfolioValue != null ? formatUsdPlain(sum.portfolioValue) : '—';
        if (sum.balanceError) totalEl.title = sum.balanceError;
        else totalEl.title = `持仓市值 ${formatUsdPlain(sum.positionsValue)} + 可用 ${formatUsdPlain(usdc)}`;
      }
    } catch (e) {
      usdcEl.textContent = '—';
      usdcEl.title = e.message || String(e);
      if (totalEl) totalEl.textContent = '—';
    }
  }

  function bindAdvancedFilterCollapse() {
    const panel = $('leaderboardClientFilters');
    const toggle = $('advancedFilterToggle');
    const body = $('advancedFilterBody');
    if (!panel || !toggle || !body) return;
    const collapsed = localStorage.getItem(ADV_FILTER_COLLAPSE_KEY) === '1';
    panel.classList.toggle('collapsed', collapsed);
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.addEventListener('click', () => {
      const next = !panel.classList.contains('collapsed');
      panel.classList.toggle('collapsed', next);
      toggle.setAttribute('aria-expanded', next ? 'false' : 'true');
      localStorage.setItem(ADV_FILTER_COLLAPSE_KEY, next ? '1' : '0');
    });
  }

  function formatPnl(n) {
    if (n == null || Number.isNaN(n)) return '—';
    const cls = Number(n) >= 0 ? 'traders-pnl-pos' : 'traders-pnl-neg';
    const sign = Number(n) >= 0 ? '+' : '';
    return `<span class="${cls}">${sign}${formatUsd(n)}</span>`;
  }

  function formatTs(ts) {
    if (ts == null) return '—';
    const ms = ts > 1e12 ? ts : ts * 1000;
    return new Date(ms).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }

  function profileUrl(wallet) {
    if (!wallet) return '#';
    return `https://polymarket.com/profile/${wallet}`;
  }

  function formatRankHtml(rank) {
    const r = parseInt(rank, 10);
    if (!Number.isFinite(r)) return '<span class="traders-rank-badge">—</span>';
    const top = r >= 1 && r <= 3 ? ` rank-${r}` : '';
    return `<span class="traders-rank-badge${top}">${esc(String(r))}</span>`;
  }

  function normalizeApiList(json) {
    if (Array.isArray(json)) return json;
    if (!json || typeof json !== 'object') return [];
    if (Array.isArray(json.data)) return json.data;
    if (json.data && typeof json.data === 'object') {
      const nested = normalizeApiList(json.data);
      if (nested.length) return nested;
    }
    for (const key of ['data', 'leaderboard', 'traders', 'results', 'items', 'entries']) {
      if (Array.isArray(json[key])) return json[key];
    }
    return [];
  }

  async function fetchDirectDataApi(apiPath, params) {
    const url = `${DATA_API_ORIGIN}${apiPath}?${params.toString()}`;
    const r = await fetch(url, { headers: { Accept: 'application/json' }, mode: 'cors' });
    let json;
    try {
      json = await r.json();
    } catch {
      throw new Error(`官方 API 返回非 JSON（HTTP ${r.status}）`);
    }
    if (!r.ok) {
      throw new Error(json?.error || `官方 API HTTP ${r.status}`);
    }
    const list = normalizeApiList(json);
    state.lastFetchSource = '官方 Data API';
    return list;
  }

  async function fetchLocalProxy(path, params) {
    const base = apiBase();
    const url = `${base}${path}?${params.toString()}`;
    const r = await fetch(url);
    let json;
    try {
      json = await r.json();
    } catch {
      throw new Error(`本地代理返回非 JSON（HTTP ${r.status}），请重启 start-markets.bat`);
    }
    if (!r.ok || json.success === false) {
      throw new Error(json.error || `本地代理 HTTP ${r.status}`);
    }
    const list = normalizeApiList(json);
    state.lastFetchSource = base ? `本地代理 ${base}` : '本地代理';
    return list;
  }

  async function fetchApiList(path, params) {
    const dataPath =
      path === '/api/v1/leaderboard' ? '/v1/leaderboard' : path === '/api/data/trades' ? '/trades' : null;

    let localErr = null;
    try {
      const rows = await fetchLocalProxy(path, params);
      if (rows.length) return rows;
      localErr = new Error('本地代理返回 0 条');
    } catch (e) {
      localErr = e;
      console.warn('[交易列表] 本地代理', e);
    }

    if (dataPath) {
      try {
        return await fetchDirectDataApi(dataPath, params);
      } catch (e) {
        console.warn('[交易列表] 官方 API', e);
        throw new Error(
          `${localErr?.message || '本地代理失败'}；直连官方 API 也失败：${e.message || e}`,
        );
      }
    }

    throw localErr || new Error('请求失败');
  }

  function normalizeLeaderboardRow(row, idx) {
    const wallet = row.proxyWallet || row.address || row.wallet || '';
    return {
      rank: row.rank ?? idx + 1,
      proxyWallet: wallet,
      userName: row.userName || row.username || row.name || '',
      xUsername: row.xUsername || row.twitterUsername || '',
      profileImage: row.profileImage || row.profileImageOptimized || '',
      verifiedBadge: !!row.verifiedBadge,
      pnl: row.pnl ?? row.profit ?? row.PnL ?? null,
      vol: row.vol ?? row.volume ?? row.VOL ?? null,
      stats: null,
      statsLoading: false,
      statsError: false,
    };
  }

  function formatWinPct(pct) {
    if (pct == null || Number.isNaN(pct)) return '—';
    const cls = pct >= 55 ? 'traders-win' : pct >= 45 ? 'traders-win-low' : 'traders-win-neg';
    return `<span class="${cls}">${pct.toFixed(1)}%</span>`;
  }

  function formatGainLoss(gain, loss) {
    const g =
      gain != null && gain > 0
        ? `<span class="traders-pnl-pos">+${formatUsd(gain)}</span>`
        : '<span style="color:#9ca3af">—</span>';
    const l =
      loss != null && loss > 0
        ? `<span class="traders-pnl-neg">-${formatUsd(loss)}</span>`
        : '<span style="color:#9ca3af">—</span>';
    return `<span class="traders-gl">${g}<span class="traders-gl-sep">/</span>${l}</span>`;
  }

  function metricPending() {
    return '<span class="traders-metric-pending">…</span>';
  }

  async function fetchJsonUrl(url) {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, mode: 'cors' });
    let json;
    try {
      json = await r.json();
    } catch {
      throw new Error(`非 JSON · HTTP ${r.status}`);
    }
    if (!r.ok) throw new Error(json?.error || `HTTP ${r.status}`);
    return json;
  }

  async function fetchUserPositions(wallet) {
    const params = new URLSearchParams({
      user: wallet,
      limit: '500',
      sizeThreshold: '0',
    });
    const base = apiBase();
    try {
      const json = await fetchJsonUrl(`${base}/api/positions?${params}`);
      const raw = json.positions ?? json.data ?? json;
      return Array.isArray(raw) ? raw : [];
    } catch (e) {
      console.warn('[交易列表] positions 本地', wallet.slice(0, 8), e);
    }
    const json = await fetchJsonUrl(`${DATA_API_ORIGIN}/positions?${params}`);
    return Array.isArray(json) ? json : normalizeApiList(json);
  }

  async function fetchUserClosedPositions(wallet) {
    const params = new URLSearchParams({ user: wallet, limit: '300' });
    const base = apiBase();
    try {
      const json = await fetchJsonUrl(`${base}/api/closed-positions?${params}`);
      const raw = json.closedPositions ?? json.positions ?? json.data ?? json;
      return Array.isArray(raw) ? raw : [];
    } catch (e) {
      console.warn('[交易列表] closed 本地', wallet.slice(0, 8), e);
    }
    try {
      const json = await fetchJsonUrl(`${DATA_API_ORIGIN}/closed-positions?${params}`);
      return Array.isArray(json) ? json : normalizeApiList(json);
    } catch {
      return [];
    }
  }

  async function fetchUserNetWorth(wallet) {
    const params = new URLSearchParams({ user: wallet });
    const base = apiBase();
    try {
      const json = await fetchJsonUrl(`${base}/api/value?${params}`);
      const rows = json.value ?? json.data ?? json;
      const row = Array.isArray(rows) ? rows[0] : rows;
      const v = parseFloat(row?.value);
      return Number.isFinite(v) ? v : 0;
    } catch (e) {
      console.warn('[交易列表] value 本地', wallet.slice(0, 8), e);
    }
    const json = await fetchJsonUrl(`${DATA_API_ORIGIN}/value?${params}`);
    const rows = Array.isArray(json) ? json : json?.value ?? [];
    const row = Array.isArray(rows) ? rows[0] : rows;
    const v = parseFloat(row?.value);
    return Number.isFinite(v) ? v : 0;
  }

  function isActivePosition(p) {
    const sz = parseFloat(p.size) || 0;
    const cv = parseFloat(p.currentValue) || 0;
    const cp = parseFloat(p.curPrice) || 0;
    return sz > 0 && cp > 0.001 && cv > 0.5 && !p.redeemable;
  }

  function computeTraderStats(positions, closed, netWorth) {
    const open = (positions || []).filter((p) => (parseFloat(p.size) || 0) > 0);
    let gain = 0;
    let loss = 0;
    for (const p of open) {
      const pnl = parseFloat(p.cashPnl) || 0;
      if (pnl >= 0) gain += pnl;
      else loss += Math.abs(pnl);
    }
    let wins = 0;
    let losses = 0;
    for (const c of closed || []) {
      const rp = parseFloat(c.realizedPnl) || 0;
      if (rp > 0) {
        wins++;
        gain += rp;
      } else if (rp < 0) {
        losses++;
        loss += Math.abs(rp);
      }
    }
    const winPct = wins + losses > 0 ? (wins / (wins + losses)) * 100 : null;
    return {
      positionCount: open.length,
      activeCount: open.filter(isActivePosition).length,
      gain,
      loss,
      winPct,
      netWorth: Number.isFinite(netWorth) ? netWorth : null,
      closedCount: (closed || []).length,
      wins,
      losses,
    };
  }

  async function loadTraderStats(wallet) {
    const [positions, closed, netWorth] = await Promise.all([
      fetchUserPositions(wallet),
      fetchUserClosedPositions(wallet),
      fetchUserNetWorth(wallet),
    ]);
    return computeTraderStats(positions, closed, netWorth);
  }

  async function enrichLeaderboardStats() {
    const rows = state.leaderboardAll.filter((r) => r.proxyWallet);
    if (!rows.length) return;
    const concurrency = 4;
    for (let i = 0; i < rows.length; i += concurrency) {
      const chunk = rows.slice(i, i + concurrency);
      chunk.forEach((r) => {
        r.statsLoading = true;
      });
      if (state.clientFilterActive) applyClientFilters();
      else renderLeaderboardTable();
      await Promise.all(
        chunk.map(async (row) => {
          try {
            row.stats = await loadTraderStats(row.proxyWallet);
            row.statsError = false;
          } catch (e) {
            console.warn('[交易列表] 指标', row.proxyWallet, e);
            row.stats = null;
            row.statsError = true;
          } finally {
            row.statsLoading = false;
          }
        }),
      );
    }
    updateFilterBounds();
    if (state.clientFilterActive) applyClientFilters();
    else {
      state.leaderboard = state.leaderboardAll.slice();
      renderLeaderboardTable();
    }
  }

  function setStatus(text, ok) {
    const dot = $('statusDot');
    const el = $('statusText');
    if (el) el.textContent = text;
    if (dot) {
      dot.classList.toggle('ok', ok === true);
      dot.classList.toggle('busy', ok === null);
    }
  }

  function readLeaderboardParams() {
    const params = new URLSearchParams();
    params.set('category', $('lbCategory')?.value || 'OVERALL');
    params.set('timePeriod', $('lbPeriod')?.value || 'DAY');
    params.set('orderBy', $('lbOrderBy')?.value || 'PNL');
    params.set('limit', String(Math.min(50, Math.max(1, parseInt($('lbLimit')?.value, 10) || 25))));
    params.set('offset', String(state.offset));
    const user = ($('lbUser')?.value || '').trim();
    if (/^0x[a-fA-F0-9]{40}$/i.test(user)) params.set('user', user);
    return params;
  }

  function readTradesParams(extra) {
    const params = new URLSearchParams();
    params.set('limit', String(Math.min(100, Math.max(1, parseInt($('trLimit')?.value, 10) || 50))));
    params.set('offset', String(extra?.offset ?? state.offset));
    params.set('takerOnly', $('trTakerOnly')?.checked !== false ? 'true' : 'false');
    const side = $('trSide')?.value;
    if (side) params.set('side', side);
    const user = (extra?.user || $('trUser')?.value || '').trim();
    if (/^0x[a-fA-F0-9]{40}$/i.test(user)) params.set('user', user);
    return params;
  }

  function leaderboardSummaryText(params) {
    const cat = LB_CATEGORY_ZH[params.get('category')] || params.get('category');
    const period = LB_PERIOD_ZH[params.get('timePeriod')] || params.get('timePeriod');
    const order = LB_ORDER_ZH[params.get('orderBy')] || params.get('orderBy');
    return `${cat} · ${period} · 按${order}排序`;
  }

  function parseFilterNum(raw) {
    if (raw == null || raw === '') return null;
    const s = String(raw).trim().replace(/,/g, '').replace(/\$/g, '');
    if (s.endsWith('%')) {
      const n = parseFloat(s.slice(0, -1));
      return Number.isFinite(n) ? n : null;
    }
    const mul = s.endsWith('M') || s.endsWith('m') ? 1e6 : s.endsWith('K') || s.endsWith('k') ? 1e3 : 1;
    const core = mul === 1 ? s : s.slice(0, -1);
    const n = parseFloat(core);
    return Number.isFinite(n) ? n * mul : null;
  }

  function formatFilterBound(n, def) {
    if (n == null || Number.isNaN(n)) return '—';
    if (def?.pct) return `${n.toFixed(0)}%`;
    if (def?.integer) return String(Math.round(n));
    return formatUsd(n);
  }

  function buildFilterGrid() {
    const grid = $('traderFilterGrid');
    if (!grid || grid.dataset.built === '1') return;
    grid.dataset.built = '1';
    grid.innerHTML = FILTER_DEFS.map(
      (def) => `
      <div class="traders-range-block" data-filter="${def.id}">
        <div class="traders-range-label">${esc(def.label)}</div>
        <div class="traders-range-inputs">
          <input type="text" class="filter-input traders-range-min" data-filter="${def.id}" placeholder="最小">
          <span class="traders-range-sep">—</span>
          <input type="text" class="filter-input traders-range-max" data-filter="${def.id}" placeholder="最大">
        </div>
        <input type="range" class="traders-range-slider" data-filter="${def.id}" min="0" max="100" value="100">
        <div class="traders-range-hint" data-hint="${def.id}">—</div>
      </div>`,
    ).join('');
  }

  function updateFilterBounds() {
    const rows = state.leaderboardAll.length ? state.leaderboardAll : state.leaderboard;
    const bounds = {};
    for (const def of FILTER_DEFS) {
      const vals = [];
      for (const row of rows) {
        if (def.needsStats && !row.stats) continue;
        const v = def.get(row);
        if (v != null && !Number.isNaN(v)) vals.push(v);
      }
      if (!vals.length) {
        bounds[def.id] = null;
        continue;
      }
      bounds[def.id] = { min: Math.min(...vals), max: Math.max(...vals) };
    }
    state.filterBounds = bounds;
    for (const def of FILTER_DEFS) {
      const b = bounds[def.id];
      const hint = document.querySelector(`[data-hint="${def.id}"]`);
      const minIn = document.querySelector(`.traders-range-min[data-filter="${def.id}"]`);
      const maxIn = document.querySelector(`.traders-range-max[data-filter="${def.id}"]`);
      const slider = document.querySelector(`.traders-range-slider[data-filter="${def.id}"]`);
      if (!b) {
        if (hint) hint.textContent = '无数据（需加载持仓指标）';
        continue;
      }
      if (hint) hint.textContent = `${formatFilterBound(b.min, def)} — ${formatFilterBound(b.max, def)}`;
      if (minIn && !state.clientFilterActive) minIn.placeholder = formatFilterBound(b.min, def);
      if (maxIn && !state.clientFilterActive) maxIn.placeholder = formatFilterBound(b.max, def);
      if (slider) {
        slider.min = '0';
        slider.max = '100';
        slider.value = '100';
      }
    }
  }

  function readClientFilterValues() {
    const out = { search: ($('traderSearch')?.value || '').trim().toLowerCase() };
    for (const def of FILTER_DEFS) {
      const min = parseFilterNum(document.querySelector(`.traders-range-min[data-filter="${def.id}"]`)?.value);
      const max = parseFilterNum(document.querySelector(`.traders-range-max[data-filter="${def.id}"]`)?.value);
      out[def.id] = { min, max };
    }
    return out;
  }

  function rowPassesClientFilters(row, f) {
    if (f.search) {
      const hay = [row.userName, row.xUsername, row.proxyWallet]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(f.search)) return false;
    }
    for (const def of FILTER_DEFS) {
      const range = f[def.id];
      if (!range || (range.min == null && range.max == null)) continue;
      if (def.needsStats && !row.stats) return false;
      const v = def.get(row);
      if (v == null || Number.isNaN(v)) return false;
      if (range.min != null && v < range.min) return false;
      if (range.max != null && v > range.max) return false;
    }
    return true;
  }

  function applyClientFilters() {
    const f = readClientFilterValues();
    const hasRange = FILTER_DEFS.some((def) => {
      const r = f[def.id];
      return r && (r.min != null || r.max != null);
    });
    state.clientFilterActive = hasRange || !!f.search;
    state.leaderboard = state.leaderboardAll.filter((row) => rowPassesClientFilters(row, f));
    renderLeaderboardTable();
    updateLeaderboardSubFilterHint();
    global.PMTradersCopy?.onWatchSetChanged?.();
  }

  function updateLeaderboardSubFilterHint() {
    const sub = $('leaderboardSub');
    if (!sub) return;
    const base = sub.textContent.split('· 筛选后')[0].trim();
    if (state.clientFilterActive && state.leaderboardAll.length) {
      sub.textContent = `${base} · 筛选后 ${state.leaderboard.length}/${state.leaderboardAll.length} 人`;
    } else {
      sub.textContent = base;
    }
  }

  async function applyAllFilters() {
    if (state.view !== 'leaderboard' || state.loading) return;
    state.offset = 0;
    await refresh({ reapplyClientFilters: true });
  }

  function clearClientFilters() {
    state.clientFilterActive = false;
    for (const def of FILTER_DEFS) {
      const minIn = document.querySelector(`.traders-range-min[data-filter="${def.id}"]`);
      const maxIn = document.querySelector(`.traders-range-max[data-filter="${def.id}"]`);
      if (minIn) minIn.value = '';
      if (maxIn) maxIn.value = '';
    }
    if ($('traderSearch')) $('traderSearch').value = '';
    state.leaderboard = state.leaderboardAll.slice();
    renderLeaderboardTable();
    updateFilterBounds();
    updateLeaderboardSubFilterHint();
  }

  function renderLeaderboardTable() {
    const body = $('leaderboardBody');
    if (!body) return;
    body.innerHTML = renderLeaderboardRows(state.leaderboard);
    bindLeaderboardClicks();
    bindWatchCheckboxes();
  }

  function bindWatchCheckboxes() {
    const all = $('watchAll');
    if (all) {
      all.onchange = () => {
        document.querySelectorAll('.traders-watch-cb').forEach((cb) => {
          cb.checked = all.checked;
          const w = cb.dataset.wallet;
          if (!w) return;
          if (all.checked) state.watchSet.add(w.toLowerCase());
          else state.watchSet.delete(w.toLowerCase());
        });
        global.PMTradersCopy?.onWatchSetChanged?.();
      };
    }
    document.querySelectorAll('.traders-watch-cb').forEach((cb) => {
      const w = (cb.dataset.wallet || '').toLowerCase();
      cb.checked = state.watchSet.has(w);
      cb.onclick = (e) => {
        e.stopPropagation();
        if (cb.checked) state.watchSet.add(w);
        else state.watchSet.delete(w);
        global.PMTradersCopy?.onWatchSetChanged?.();
      };
    });
  }

  function syncWatchFromFiltered() {
    for (const row of state.leaderboard) {
      if (row.proxyWallet) state.watchSet.add(row.proxyWallet.toLowerCase());
    }
    renderLeaderboardTable();
    global.PMTradersCopy?.syncWatchFromTable?.();
    global.PMTradersCopy?.onWatchSetChanged?.();
  }

  async function fetchLeaderboard() {
    const params = readLeaderboardParams();
    let rows = await fetchApiList('/api/v1/leaderboard', params);
    let note = '';
    if (!rows.length && params.get('category') !== 'OVERALL') {
      const fallback = new URLSearchParams(params);
      fallback.set('category', 'OVERALL');
      rows = await fetchApiList('/api/v1/leaderboard', fallback);
      if (rows.length) note = '（当前分类无数据，已改显示「全部」）';
    }
    return {
      rows: rows.map((row, i) => normalizeLeaderboardRow(row, i)),
      note,
    };
  }

  async function fetchTrades(extra) {
    return fetchApiList('/api/data/trades', readTradesParams(extra));
  }

  function renderLeaderboardRows(rows) {
    if (!rows.length) {
      return `<tr><td colspan="12" class="traders-empty">暂无排行榜数据<br><small>可尝试：放宽筛选条件、分类选「全部」；并确认已用 start-markets.bat 启动服务</small></td></tr>`;
    }
    const loadStats = $('lbLoadStats')?.checked !== false;
    return rows
      .map((row) => {
        const wallet = row.proxyWallet || '';
        const selected = wallet && wallet.toLowerCase() === (state.selectedWallet || '').toLowerCase();
        const name = row.userName || row.xUsername || shortAddr(wallet);
        const img = row.profileImage
          ? `<img class="traders-avatar" src="${esc(row.profileImage)}" alt="" loading="lazy" onerror="this.style.display='none'">`
          : '<span class="traders-avatar"></span>';
        const st = row.stats;
        const pending = loadStats && row.statsLoading;
        const posCell = pending
          ? metricPending()
          : st
            ? String(st.positionCount)
            : row.statsError
              ? '—'
              : loadStats
                ? metricPending()
                : '—';
        const activeCell = pending
          ? metricPending()
          : st
            ? String(st.activeCount)
            : row.statsError
              ? '—'
              : loadStats
                ? metricPending()
                : '—';
        const glCell = pending
          ? metricPending()
          : st
            ? formatGainLoss(st.gain, st.loss)
            : row.statsError
              ? '—'
              : loadStats
                ? metricPending()
                : '—';
        const winCell = pending
          ? metricPending()
          : st
            ? formatWinPct(st.winPct) +
              (st.closedCount ? `<span class="traders-win-n">n=${st.closedCount}</span>` : '')
            : row.statsError
              ? '—'
              : loadStats
                ? metricPending()
                : '—';
        const worthCell = pending
          ? metricPending()
          : st && st.netWorth != null
            ? formatUsd(st.netWorth)
            : row.statsError
              ? '—'
              : loadStats
                ? metricPending()
                : '—';
        const watched = wallet && state.watchSet.has(wallet.toLowerCase());
        return `<tr data-wallet="${esc(wallet)}" class="${selected ? 'selected' : ''}">
          <td class="traders-watch-td" onclick="event.stopPropagation()">
            <input type="checkbox" class="traders-watch-cb" data-wallet="${esc(wallet)}" ${watched ? 'checked' : ''} title="加入跟单监视">
          </td>
          <td class="traders-rank">${formatRankHtml(row.rank)}</td>
          <td>
            <div class="traders-user">
              ${img}
              <div>
                <div class="traders-user-name">${esc(name)}${row.verifiedBadge ? ' ✓' : ''}</div>
                <div class="traders-user-sub">${esc(shortAddr(wallet))}</div>
              </div>
            </div>
          </td>
          <td class="num">${posCell}</td>
          <td class="num">${activeCell}</td>
          <td class="num">${glCell}</td>
          <td class="num">${winCell}</td>
          <td class="num">${worthCell}</td>
          <td class="num">${formatPnl(row.pnl)}</td>
          <td class="num">${formatUsd(row.vol)}</td>
          <td>${row.xUsername ? `<a href="https://x.com/${esc(row.xUsername)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">@${esc(row.xUsername)}</a>` : '—'}</td>
          <td><a class="traders-link" href="${profileUrl(wallet)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">主页</a></td>
        </tr>`;
      })
      .join('');
  }

  function renderTradeRows(rows) {
    if (!rows.length) {
      return '<tr><td colspan="7" class="traders-empty">暂无成交记录</td></tr>';
    }
    return rows
      .map((t) => {
        const side = (t.side || '').toUpperCase();
        const sideLabel = SIDE_ZH[side] || side || '—';
        const sideCls = side === 'BUY' ? 'traders-side-buy' : 'traders-side-sell';
        const wallet = t.proxyWallet || t.address || '';
        const title = t.title || t.slug || t.eventSlug || '—';
        const userLabel = t.name || t.pseudonym || t.userName || shortAddr(wallet);
        const usd = t.size != null && t.price != null ? t.size * t.price : null;
        return `<tr data-wallet="${esc(wallet)}">
          <td>${formatTs(t.timestamp)}</td>
          <td class="traders-market-cell" title="${esc(title)}">${esc(title)}</td>
          <td>${t.outcome ? esc(t.outcome) : '—'}</td>
          <td class="${sideCls}">${esc(sideLabel)}</td>
          <td>${t.price != null ? `${(t.price * 100).toFixed(1)}¢` : '—'}</td>
          <td>${t.size != null ? Number(t.size).toFixed(2) : '—'}${usd != null ? ` <span style="color:#9ca3af">(${formatUsd(usd)})</span>` : ''}</td>
          <td>
            <div class="traders-user-name">${esc(userLabel)}</div>
            <div class="traders-user-sub">${esc(shortAddr(wallet))}</div>
          </td>
        </tr>`;
      })
      .join('');
  }

  function bindLeaderboardClicks() {
    const tbody = $('leaderboardBody');
    if (!tbody) return;
    tbody.querySelectorAll('tr[data-wallet]').forEach((tr) => {
      tr.addEventListener('click', () => {
        const w = tr.dataset.wallet;
        if (!w) return;
        state.selectedWallet = w;
        if ($('trUser')) $('trUser').value = w;
        loadTraderTrades(w);
        tbody.querySelectorAll('tr').forEach((r) => r.classList.toggle('selected', r.dataset.wallet === w));
      });
    });
  }

  async function loadTraderTrades(wallet) {
    const panel = $('traderDetailPanel');
    const body = $('traderDetailBody');
    if (!panel || !body) return;
    panel.hidden = false;
    body.innerHTML = '<div class="traders-empty">加载该地址成交…</div>';
    try {
      const rows = await fetchTrades({ user: wallet, offset: 0 });
      body.innerHTML = `<div class="traders-table-wrap"><table class="traders-table">
        <thead><tr><th>时间</th><th>市场</th><th>结果</th><th>方向</th><th>价格</th><th>数量</th></tr></thead>
        <tbody>${renderTradeRows(rows)}</tbody>
      </table></div>`;
      const title = $('traderDetailTitle');
      if (title) {
        const row = (state.leaderboardAll.length ? state.leaderboardAll : state.leaderboard).find(
          (r) => (r.proxyWallet || '').toLowerCase() === wallet.toLowerCase(),
        );
        title.textContent = row?.userName
          ? `${row.userName} · 近期成交`
          : `${shortAddr(wallet)} · 近期成交`;
      }
    } catch (e) {
      body.innerHTML = `<div class="traders-empty">加载失败：${esc(e.message || e)}</div>`;
    }
  }

  function updateFoot() {
    const foot = $('tradersFoot');
    if (!foot) return;
    const total = state.view === 'leaderboard' ? state.leaderboard.length : state.trades.length;
    foot.innerHTML = `<span>本页 ${total} 条 · 偏移 ${state.offset}</span>
      <span>
        <button type="button" class="btn" id="tradersPrevBtn" ${state.offset <= 0 ? 'disabled' : ''}>上一页</button>
        <button type="button" class="btn" id="tradersNextBtn">下一页</button>
      </span>`;
    $('tradersPrevBtn')?.addEventListener('click', () => {
      state.offset = Math.max(0, state.offset - state.limit);
      refresh();
    });
    $('tradersNextBtn')?.addEventListener('click', () => {
      state.offset += state.limit;
      refresh();
    });
  }

  function setView(view) {
    state.view = view;
    state.offset = 0;
    document.querySelectorAll('.traders-tab').forEach((el) => {
      el.classList.toggle('on', el.dataset.view === view);
    });
    const lb = $('leaderboardSection');
    const tr = $('tradesSection');
    const lbF = $('leaderboardFilters');
    const trF = $('tradesFilters');
    if (lb) lb.hidden = view !== 'leaderboard';
    if (tr) tr.hidden = view !== 'trades';
    if (lbF) lbF.hidden = view !== 'leaderboard';
    if (trF) trF.hidden = view !== 'trades';
    refresh();
  }

  async function refresh(opts = {}) {
    if (state.loading) return;
    state.loading = true;
    setStatus('加载中…', null);
    const btn = $('refreshBtn');
    const applyBtn = $('filterApply');
    if (btn) btn.disabled = true;
    if (applyBtn) applyBtn.disabled = true;
    try {
      if (state.view === 'leaderboard') {
        state.limit = Math.min(50, parseInt($('lbLimit')?.value, 10) || 25);
        const params = readLeaderboardParams();
        const lbResult = await fetchLeaderboard();
        state.leaderboardAll = lbResult.rows;
        const sub = $('leaderboardSub');
        if (sub) {
          const src = state.lastFetchSource ? ` · ${state.lastFetchSource}` : '';
          sub.textContent = `${leaderboardSummaryText(params)} · 共 ${state.leaderboardAll.length} 人${lbResult.note || ''}${src}`;
        }
        if (opts.reapplyClientFilters) {
          applyClientFilters();
        } else {
          state.leaderboard = lbResult.rows.slice();
          state.clientFilterActive = false;
          renderLeaderboardTable();
        }
        if ($('lbLoadStats')?.checked !== false) {
          setStatus('加载持仓指标…', null);
          await enrichLeaderboardStats();
        } else {
          updateFilterBounds();
        }
      } else {
        state.limit = Math.min(100, parseInt($('trLimit')?.value, 10) || 50);
        state.trades = await fetchTrades();
        const body = $('tradesBody');
        if (body) body.innerHTML = renderTradeRows(state.trades);
        const sub = $('tradesSub');
        if (sub) {
          const src = state.lastFetchSource ? ` · ${state.lastFetchSource}` : '';
          sub.textContent = state.trades.length ? `全站近期成交 · ${state.trades.length} 条${src}` : '—';
        }
      }
      setStatus('已更新 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }), true);
      void refreshTradersBalance();
    } catch (e) {
      console.warn('[交易列表]', e);
      setStatus('加载失败', false);
      const err = esc(e.message || e);
      if (state.view === 'leaderboard' && $('leaderboardBody')) {
        $('leaderboardBody').innerHTML = `<tr><td colspan="12" class="traders-empty">${err}<br><small>请用 start-markets.bat 启动本地服务后访问 http://localhost:3457/polymarket_traders.html</small></td></tr>`;
      }
      if (state.view === 'trades' && $('tradesBody')) {
        $('tradesBody').innerHTML = `<tr><td colspan="7" class="traders-empty">${err}</td></tr>`;
      }
    } finally {
      state.loading = false;
      if (btn) btn.disabled = false;
      if (applyBtn) applyBtn.disabled = false;
      updateFoot();
    }
  }

  function init() {
    showPageOriginHint();
    buildFilterGrid();
    bindAdvancedFilterCollapse();
    $('tradersBalanceRefresh')?.addEventListener('click', () => void refreshTradersBalance());
    void refreshTradersBalance();
    document.querySelectorAll('.traders-tab').forEach((tab) => {
      tab.addEventListener('click', () => setView(tab.dataset.view));
    });
    $('filterApply')?.addEventListener('click', () => void applyAllFilters());
    $('filterClear')?.addEventListener('click', () => clearClientFilters());
    $('filterWatchFiltered')?.addEventListener('click', () => syncWatchFromFiltered());
    $('traderSearch')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void applyAllFilters();
    });
    $('lbUser')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void applyAllFilters();
    });
    $('trApply')?.addEventListener('click', () => {
      state.offset = 0;
      state.selectedWallet = null;
      const panel = $('traderDetailPanel');
      if (panel) panel.hidden = true;
      refresh();
    });
    $('closeTraderDetail')?.addEventListener('click', () => {
      state.selectedWallet = null;
      const panel = $('traderDetailPanel');
      if (panel) panel.hidden = true;
      $('leaderboardBody')?.querySelectorAll('tr.selected').forEach((r) => r.classList.remove('selected'));
    });
    $('refreshBtn')?.addEventListener('click', () => {
      if (state.view === 'leaderboard') void applyAllFilters();
      else refresh();
    });
    setView('leaderboard');
  }

  global.PMTraders = {
    refresh,
    setView,
    loadTraderTrades,
    applyClientFilters,
    applyAllFilters,
    clearClientFilters,
    syncWatchFromFiltered,
    getLeaderboardAll: () => state.leaderboardAll,
    getWatchSet: () => state.watchSet,
    apiBase,
    refreshTradersBalance,
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
