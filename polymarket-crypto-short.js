/**
 * 加密短线市场页（5M / 15M）共用逻辑
 */
(function (global) {
  const CRYPTO_PAGE_COINS = ['btc', 'eth', 'sol', 'xrp', 'doge', 'hype', 'bnb'];
  const CRYPTO_PROB_INTERVAL_MS = 5000;

  function initPolymarketCryptoShort(cfg) {
    const {
      intervalKey,
      slotSec,
      slugMin,
      intervalNum,
      globalApiName,
      category,
      urgentMs = 60000,
      badgeClass = '',
      badgeLabel,
      sourceLabel,
      pageTitle,
      resultUrl,
      asyncBookRefresh = false,
      /** Volume / Open Interest 异步刷新（不重绘整表） */
      asyncStatsRefresh = false,
      /** 为 true 时：槽倒计时在面板标题 #slotCountdown，表格行内不显示 */
      panelSlotCountdown = false,
      /** 固定每单 USDC（如 1）；与 skipMinSizeBump 配合用于 5M/15M */
      fixedOrderUsdc = null,
      skipMinSizeBump = false,
      /** 5M：非 BTC 且 Up/Down≥threshold 时随机 $1 买入 */
      autoBuy90 = null,
      /** 5M：时间槽结束时将各市场 Up/Down 结果追加到本地 txt */
      slotResultLog = false,
      /** 5M：虚拟共识策略（见 virtualBet 配置与 getVirtualStrategyCfg） */
      virtualBet = null,
      /** 显示标的现货目标价 / 现价（需本地服务 RTDS） */
      showSpotPrices = false,
      /** 隐藏 Source 列（5M 页） */
      hideSourceColumn = false,
      /** 隐藏 Volume / Open Interest 列（5M 页） */
      hideVolumeOiColumns = false,
      /** 隐藏 Up/Down 列内 $1 市价下单按钮（5M 页） */
      hideOrderButtons = false,
      /** 5M：表格显示马尔可夫策略列 */
      showMarkovColumn = false,
    } = cfg;

    let events = [];
    let filtered = [];
    let expanded = new Set();
    let currentPage = 0;
    let loading = false;
    let filterEndHours = 0;
    let cryptoProbTimer = null;
    let cryptoCountdownTimer = null;
    let slotTs = 0;
    let auto90Busy = false;
    let auto90LastSuccessSlot = null;
    let auto90Close40Slot = null;   // 结束前 40 秒触发的槽记录
    let virtualClose40Slot = null;
    let lastLoggedSlotTs = null;
    let virtualOrdersPanelOpen = false;
    let virtualOrdersPage = 0;
    let virtualOrdersPageSize = 5;
    let virtualBetBusy = false;
    let virtualConsensusSkipToastKey = '';
    let virtualConsensusSkipToastAt = 0;
    let lastVirtualTimerCheckAt = 0;
    /** 本槽已模拟下单的 槽:市场:方向 */
    let virtualMarkovPlacedKeys = new Set();
    const storagePrefix = `pm_${intervalKey.toLowerCase()}`;
    const VIRTUAL_STORAGE_KEY = `${storagePrefix}_virtual_v1`;
    const VIRTUAL_BET_ENABLED_KEY = `${storagePrefix}_virtual_bet`;
    const ORDER_RULES_STORAGE_KEY = `${storagePrefix}_order_rules`;
    let bookBusy = false;
    let slotEndRefreshPending = false;
    let spotPriceBusy = false;
    const spotPtbCache = new Map();
    let notifiedEndingSlotTs = null;
    let notificationPermissionAsked = false;
    /** 槽切换前最后一帧盘口，用于写入马尔可夫历史（避免 loadAll 后 slug/价格已变） */
    let markovEventsSnapshot = [];

    const $ = (id) => document.getElementById(id);

    function cssEscape(s) {
      if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(String(s));
      return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    function hasProbFilterActive() {
      const min = parseFloat($('probMin')?.value);
      const max = parseFloat($('probMax')?.value);
      return (!Number.isNaN(min) && min > 0) || (!Number.isNaN(max) && max > 0 && max < 100);
    }

    function hasVolumeFilterActive() {
      return (parseFloat($('minVol')?.value) || 0) > 0;
    }

    function needsFullRenderAfterStats() {
      const f = getFilterState();
      return (
        hasProbFilterActive() ||
        hasVolumeFilterActive() ||
        f.endHours > 0 ||
        !!f.search
      );
    }

    function esc(s) {
      return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
    }

    function formatMoney(v) {
      const n = +v || 0;
      if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
      if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
      if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
      return '$' + n.toFixed(0);
    }

    function formatDate(iso) {
      if (!iso) return '—';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '—';
      return d.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function parseJsonField(val, fallback = []) {
      if (Array.isArray(val)) return val;
      if (typeof val === 'string') {
        try {
          return JSON.parse(val);
        } catch {
          return fallback;
        }
      }
      return fallback;
    }

    function getLeadProb(market) {
      if (!market?.prices?.length) return null;
      let maxP = -1;
      for (const raw of market.prices) {
        const p = parseFloat(raw);
        if (!isNaN(p) && p > maxP) maxP = p;
      }
      return maxP >= 0 ? maxP * 100 : null;
    }

    function formatMarketProb(market) {
      if (!market?.prices?.length) return '—';
      const outcomes = market.outcomes || [];
      let bestIdx = 0;
      let bestP = -1;
      market.prices.forEach((raw, i) => {
        const p = parseFloat(raw);
        if (!isNaN(p) && p > bestP) {
          bestP = p;
          bestIdx = i;
        }
      });
      if (bestP < 0) return '—';
      const label = outcomes[bestIdx] ? String(outcomes[bestIdx]) : '';
      const pct = Math.round(bestP * 100);
      return label ? `${pct}% ${label}` : `${pct}%`;
    }

    function pickPrimaryMarket(markets) {
      if (!markets.length) return null;
      return markets.reduce((best, m) => (m.volume > (best?.volume || 0) ? m : best), markets[0]);
    }

    function getCurrentSlotTs(nowSec = Math.floor(Date.now() / 1000)) {
      return Math.floor(nowSec / slotSec) * slotSec;
    }

    function getEventSlotTs(ev) {
      const slug = (ev?.slug || '').toLowerCase();
      const re = new RegExp('-updown-' + slugMin + '-(\\d+)$');
      const m = slug.match(re);
      return m ? parseInt(m[1], 10) : null;
    }

    function coinFromEventSlug(slug) {
      const m = (slug || '').toLowerCase().match(/^([a-z]+)-updown-/);
      return m ? m[1] : null;
    }

    function formatSpotUsd(n, coin) {
      if (n == null || Number.isNaN(n)) return '—';
      const c = (coin || '').toLowerCase();
      const digits = c === 'btc' || n >= 1000 ? 2 : n >= 10 ? 3 : 4;
      return '$' + n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    }

    function formatPriceToBeat(n, coin) {
      if (n == null || Number.isNaN(n)) return '—';
      return formatSpotUsd(n, coin);
    }

    function resolvedPriceToBeat(ev) {
      if (!ev) return null;
      const gamma = ev.gammaPriceToBeat;
      if (Number.isFinite(gamma) && gamma > 0) return gamma;
      const target = ev.targetPrice;
      const src = String(ev.targetSource || '').toLowerCase();
      if (Number.isFinite(target) && target > 0 && src.includes('gamma')) return target;
      return null;
    }

    function formatSpotSourceLabel(kind, source) {
      if (!source) return kind === 'target' ? '槽开盘参考价 (Price to Beat)' : 'Chainlink 现货';
      if (source.includes('gamma')) return '目标价 · Polymarket (Gamma eventMetadata)';
      if (source.includes('chainlink:slot-open')) return '目标价 · Chainlink 槽开盘捕获';
      if (source.includes('chainlink')) return '现价 · Chainlink';
      return `${kind === 'target' ? '目标价' : '现价'} · ${source}`;
    }

    function formatSpotDiff(ev) {
      if (ev.priceDiff == null || Number.isNaN(ev.priceDiff)) return '—';
      const sign = ev.priceDiff >= 0 ? '+' : '';
      const pct =
        ev.priceDiffPct != null && !Number.isNaN(ev.priceDiffPct)
          ? ` (${sign}${ev.priceDiffPct.toFixed(3)}%)`
          : '';
      return `${sign}$${Math.abs(ev.priceDiff).toFixed(2)}${pct}`;
    }

    function spotDiffClass(ev) {
      if (ev.priceDiff == null || Number.isNaN(ev.priceDiff)) return '';
      if (ev.priceDiff > 0) return 'crypto-spot-up';
      if (ev.priceDiff < 0) return 'crypto-spot-down';
      return 'crypto-spot-flat';
    }

    async function fetchSpotPricesBatch(slugs) {
      if (!global.location?.protocol?.startsWith('http') || !slugs.length) return {};
      try {
        const resp = await fetch('/api/crypto-spot-prices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slugs }),
        });
        const json = await resp.json();
        if (!resp.ok || !json.success) return {};
        return json.prices || {};
      } catch (e) {
        console.warn('[spot prices]', e);
        return {};
      }
    }

    function applySpotRowToEvent(ev, row) {
      if (!row) return;
      if (row.targetPrice != null) {
        ev.targetPrice = row.targetPrice;
        ev.targetSource = row.targetSource ?? ev.targetSource ?? null;
        if (Number.isFinite(row.targetPrice) && row.targetPrice > 0 && String(ev.targetSource || '').includes('gamma')) {
          ev.gammaPriceToBeat = row.targetPrice;
        }
        if (ev.slug) spotPtbCache.set(ev.slug, { price: ev.targetPrice, source: ev.targetSource });
      }
      if (row.currentPrice != null) {
        ev.currentPrice = row.currentPrice;
        ev.currentSource = row.currentSource ?? null;
      }
      ev.chainlinkSymbol = row.chainlinkSymbol ?? ev.chainlinkSymbol ?? null;
      if (ev.targetPrice != null && ev.currentPrice != null) {
        ev.priceDiff = ev.currentPrice - ev.targetPrice;
        ev.priceDiffPct = ev.targetPrice !== 0 ? (ev.priceDiff / ev.targetPrice) * 100 : null;
      } else if (row.diff != null || row.diffPct != null) {
        ev.priceDiff = row.diff ?? null;
        ev.priceDiffPct = row.diffPct ?? null;
      }
    }

    async function enrichEventsSpotPrices(list) {
      if (!showSpotPrices || !list?.length) return;
      const slugs = list.map((ev) => ev.slug).filter(Boolean);
      const prices = await fetchSpotPricesBatch(slugs);
      for (const ev of list) {
        const row = prices[ev.slug];
        if (row) applySpotRowToEvent(ev, row);
      }
    }

    async function enrichEventsPriceToBeat(list) {
      if (!list?.length) return;
      if (!global.location?.protocol?.startsWith('http')) return;
      const needSlugs = list.map((ev) => ev.slug).filter(Boolean);
      if (!needSlugs.length) return;
      for (const slug of needSlugs) {
        const ev = list.find((x) => x.slug === slug);
        if (!ev) continue;
        try {
          const p = await fetchGammaPriceToBeat(slug);
          if (!Number.isFinite(p) || p <= 0) continue;
          ev.gammaPriceToBeat = p;
          ev.targetPrice = p;
          ev.targetSource = 'gamma:eventMetadata';
          spotPtbCache.set(slug, { price: p, source: ev.targetSource });
        } catch (_) {}
      }
    }

    async function fetchGammaPriceToBeat(slug) {
      try {
        const resp = await fetch(`/api/crypto-price-to-beat?slug=${encodeURIComponent(slug)}&t=${Date.now()}`, { cache: 'no-store' });
        if (!resp.ok) return null;
        const json = await resp.json();
        const p = json?.price != null ? +json.price : null;
        return Number.isFinite(p) && p > 0 ? p : null;
      } catch (_) {
        return null;
      }
    }

    function patchEventSpotPricesInDom(ev) {
      if (!showSpotPrices) return false;
      const row = document.querySelector(`tr[data-ev-id="${cssEscape(String(ev.id))}"]`);
      if (!row) return false;
      const coin = coinFromEventSlug(ev.slug);
      const ptbEl = row.querySelector('[data-ptb="gamma"]');
      const targetEl = row.querySelector('[data-spot="target"]');
      const currentEl = row.querySelector('[data-spot="current"]');
      const diffEl = row.querySelector('[data-spot="diff"]');
      if (ptbEl) {
        const ptb = resolvedPriceToBeat(ev);
        ptbEl.textContent = formatPriceToBeat(ptb, coin);
        const source = ev.gammaPriceToBeat != null ? 'Gamma API eventMetadata.priceToBeat' : formatSpotSourceLabel('target', ev.targetSource);
        ptbEl.title = source || 'priceToBeat';
        flashStatCell(ptbEl);
      }
      if (targetEl) {
        targetEl.textContent = formatSpotUsd(ev.targetPrice, coin);
        targetEl.title = formatSpotSourceLabel('target', ev.targetSource);
        flashStatCell(targetEl);
      }
      if (currentEl) {
        currentEl.textContent = formatSpotUsd(ev.currentPrice, coin);
        currentEl.title = ev.currentPrice != null
          ? `${formatSpotSourceLabel('current', ev.currentSource)}${ev.chainlinkSymbol ? ` (${ev.chainlinkSymbol})` : ''}`
          : 'Chainlink 现货（等待 RTDS 推送，需重启 markets-server）';
        flashStatCell(currentEl);
      }
      if (diffEl) {
        diffEl.textContent = formatSpotDiff(ev);
        diffEl.className = `num crypto-spot-cell ${spotDiffClass(ev)}`;
        diffEl.title = '现价 − 目标价';
        flashStatCell(diffEl);
      }
      return !!(ptbEl || targetEl || currentEl || diffEl);
    }

    async function refreshSpotPricesQuiet() {
      if (!showSpotPrices || spotPriceBusy || !events.length) return;
      spotPriceBusy = true;
      try {
        await enrichEventsSpotPrices(events);
        events.forEach((ev) => patchEventSpotPricesInDom(ev));
      } finally {
        spotPriceBusy = false;
      }
    }

    function inferSlotWinner(up, down) {
      if (up == null || down == null || Number.isNaN(up) || Number.isNaN(down)) return '—';
      if (up > down) return 'Up';
      if (down > up) return 'Down';
      return '平';
    }

    function formatSlotResultTime(slotTs) {
      const d = new Date(slotTs * 1000);
      const local = d.toLocaleString('zh-CN', { hour12: false });
      const et = d.toLocaleString('en-US', {
        timeZone: 'America/New_York',
        hour12: false,
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      return `${local} (ET ${et})`;
    }

    function buildSlotResultLogText(slotTs) {
      const lines = [
        '',
        '================================================================',
        `5M 时间槽结束 · ${formatSlotResultTime(slotTs)} · slot=${slotTs}`,
        '说明：结果按槽结束时订单簿中间价判定（价高者为领先侧，非链上官方结算）',
        '----------------------------------------------------------------',
      ];
      const sorted = [...events].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      for (const ev of sorted) {
        const up = ev.upPrice;
        const down = ev.downPrice;
        const winner = inferSlotWinner(up, down);
        const upC = up != null && !Number.isNaN(up) ? Math.round(up * 100) + '¢' : '—';
        const downC = down != null && !Number.isNaN(down) ? Math.round(down * 100) + '¢' : '—';
        const coin = (ev.slug || '').split('-')[0] || '—';
        lines.push(`${coin.toUpperCase()}\t${ev.title || ev.slug}\tUp ${upC}\tDown ${downC}\t→ ${winner}`);
      }
      lines.push(`记录时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
      return lines.join('\n');
    }

    async function appendSlotResultLog(slotTs) {
      if (!slotResultLog || !slotTs) return;
      if (!global.location?.protocol?.startsWith('http')) {
        console.warn('[slot log] 需通过 http://localhost:3458 打开才能写入 txt');
        return;
      }
      const text = buildSlotResultLogText(slotTs);
      try {
        const resp = await fetch(`/api/crypto-slot-log/${intervalKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, slotTs }),
        });
        const json = await resp.json().catch(() => ({}));
        if (!resp.ok || !json.success) {
          console.warn('[slot log]', json.error || resp.status);
          return;
        }
        const fname = json.file || 'crypto-5m-slot-results.txt';
        global.PMTrade?.toast?.(`已写入槽结果 · ${fname}`, 'success', 5000);
      } catch (e) {
        console.warn('[slot log]', e);
      }
    }

    function collectEndingSlotTimestamps(endingSlotTs) {
      const slots = new Set();
      if (endingSlotTs != null) slots.add(endingSlotTs);
      const prevWall = getCurrentSlotTs() - slotSec;
      if (prevWall > 0) slots.add(prevWall);
      for (const ev of events) {
        const s = getEventSlotTs(ev);
        if (s != null) slots.add(s);
      }
      return slots;
    }

    function logEndingSlotResults(endingSlotTs) {
      if (!events.length && endingSlotTs == null) return;
      const slotsToSettle = collectEndingSlotTimestamps(endingSlotTs);
      const markovSrc =
        markovEventsSnapshot.length > 0 ? markovEventsSnapshot : events;
      for (const s of slotsToSettle) {
        if (shouldRecordMarkovHistory()) recordMarkovSlotsFromEvents(markovSrc, s);
        settleVirtualBetsForSlot(events, s);
      }
      const slotTsVal = endingSlotTs ?? getEventSlotTs(events[0]);
      if (!slotResultLog || slotTsVal == null || slotTsVal === lastLoggedSlotTs) return;
      lastLoggedSlotTs = slotTsVal;
      void appendSlotResultLog(slotTsVal);
    }

    function isCurrentSlotEvent(ev) {
      const slug = (ev?.slug || '').toLowerCase();
      const re = new RegExp('-updown-' + slugMin + '-(\\d+)$');
      const m = slug.match(re);
      return m && parseInt(m[1], 10) === getCurrentSlotTs();
    }

    /** 仅当前时间槽：已开盘、未结束、至少一个子市场可交易 */
    function isBtcEvent(ev) {
      const slug = (ev?.slug || '').toLowerCase();
      const title = (ev?.title || '').toLowerCase();
      if (/\b(bitcoin|btc)\b/.test(slug) || /\bbitcoin\b/.test(title)) return true;
      return slug.startsWith('bitcoin-') || slug.includes('-btc-');
    }

    function isAuto90Enabled() {
      if (!autoBuy90) return false;
      return localStorage.getItem('pm_5m_auto90') === '1';
    }

    function defaultOrderRules() {
      return {
        minCents: Math.round((autoBuy90?.threshold ?? 0.9) * 100),
        maxCents: Math.round((autoBuy90?.maxThreshold ?? 0.95) * 100),
        minExclusive: autoBuy90?.minInclusive !== true,
        maxExclusive: autoBuy90?.maxInclusive !== true,
        earlyBuyEnabled: false,
        lateBuyEnabled: false,
        lateBuySec: 40,
        onlyBuyBeforeEnd: false,
        tpSlEnabled: false,
        takeProfitPct: 25,
        stopLossPct: 15,
        tpSlScope: 'all',
        watchedTokenIds: {},
        tpSlLastAt: '',
        tpSlLastResult: '',
        orderUsdc: fixedOrderUsdc > 0 ? fixedOrderUsdc : 1,
        virtualOrderUsdc: virtualBet?.amountUsd > 0 ? virtualBet.amountUsd : 5,
        virtualTpSlEnabled: true,
        virtualTakeProfitPct: 5,
        virtualTakeProfitPrice: 0.98,
        virtualMaxBuyPrice: 0.98,
        virtualStopLossPct: 20,
        // 虚拟投注下单价格覆盖：单位为 1¢=0.01，留空/空值为使用盘口 pick.price
        virtualOrderPriceCents: null,
        markovEnabled: false,
        markovThreshold: 0.87,
      };
    }

    function getVirtualTpSlConfig(_bet) {
      const r = loadOrderRules();
      let tpPrice = parseFloat(r.virtualTakeProfitPrice);
      if (!Number.isFinite(tpPrice) || tpPrice <= 0 || tpPrice >= 1) {
        const cents = parseInt(r.virtualTakeProfitPriceCents, 10);
        tpPrice = Number.isFinite(cents) && cents > 0 && cents < 100 ? cents / 100 : 0.98;
      }
      return {
        enabled: r.virtualTpSlEnabled !== false,
        takeProfitPct: Math.max(0.1, parseFloat(r.virtualTakeProfitPct) || 5),
        takeProfitPrice: Math.min(0.99, Math.max(0.01, tpPrice)),
        stopLossPct: Math.max(0.1, parseFloat(r.virtualStopLossPct) || 20),
      };
    }

    function getVirtualOrderPriceCentsOverride() {
      const r = loadOrderRules();
      const raw = r.virtualOrderPriceCents;
      if (raw == null || raw === '') return null;
      const cents = parseInt(raw, 10);
      if (!Number.isFinite(cents)) return null;
      // 5M 虚拟上下文使用 0.01~0.99
      if (cents < 1 || cents > 99) return null;
      return cents;
    }

    /** 虚拟开仓最高价（含）：默认 98¢，超过则不买入 */
    function getVirtualMaxBuyPrice() {
      const r = loadOrderRules();
      let p = parseFloat(r.virtualMaxBuyPrice);
      if (!Number.isFinite(p) || p <= 0 || p >= 1) p = 0.98;
      return Math.min(0.99, Math.max(0.01, p));
    }

    function isVirtualEntryPriceAllowed(price) {
      if (price == null || Number.isNaN(price)) return false;
      return price <= getVirtualMaxBuyPrice() + 1e-9;
    }

    function findEventForVirtualBet(bet) {
      return events.find((e) => String(e.id) === String(bet.evId));
    }

    function virtualBetMarkPrice(bet, ev) {
      if (!ev || !bet?.side) return null;
      const side = String(bet.side).toLowerCase();
      const p = side === 'up' ? ev.upPrice : ev.downPrice;
      return p != null && !Number.isNaN(p) ? p : null;
    }

    function virtualBetPercentPnl(bet, currentPrice) {
      const debit = bet.totalDebit ?? bet.cost ?? 0;
      const shares = bet.shares ?? 0;
      if (!debit || !shares || currentPrice == null || Number.isNaN(currentPrice)) return null;
      const markValue = shares * currentPrice;
      return ((markValue - debit) / debit) * 100;
    }

    function moveVirtualBetsToHistory(state, settledBets) {
      state.history = state.history || [];
      for (const bet of settledBets) {
        state.history.unshift({ ...bet });
      }
      state.history = state.history.slice(0, 200);
      state.openBets = (state.openBets || []).filter((b) => !b.settled);
    }

    function settleVirtualBetEarly(state, bet, ev, action, currentPrice) {
      const debit = bet.totalDebit ?? bet.cost ?? 0;
      const markValue = Math.max(0, (bet.shares || 0) * currentPrice);
      bet.settled = true;
      bet.settledAt = Date.now();
      bet.closePrice = currentPrice;
      bet.closeUp = ev?.upPrice ?? null;
      bet.closeDown = ev?.downPrice ?? null;
      bet.exitType = action;
      bet.payout = markValue;
      bet.profit = markValue - debit;
      bet.result = action;
      state.bankroll += markValue;
      const pnlPct = virtualBetPercentPnl(bet, currentPrice);
      const logLines = [
        `[虚拟${action}] ${new Date().toLocaleString('zh-CN', { hour12: false })} · 槽 ${bet.slotTs}`,
        `  ${bet.title} · 买 ${String(bet.side).toUpperCase()} @ ${Math.round(bet.entryPrice * 100)}¢ → 平 ${Math.round(currentPrice * 100)}¢`,
        `  浮动 ${pnlPct != null ? (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(2) + '%' : '—'} · 兑付 $${markValue.toFixed(4)} · 盈亏 ${bet.profit >= 0 ? '+' : ''}$${bet.profit.toFixed(4)} · 余额 $${state.bankroll.toFixed(2)}`,
      ];
      void appendVirtualBetLog(logLines.join('\n'));
      return bet;
    }

    function checkVirtualTpSl() {
      if (!virtualBet || !isVirtualBetEnabled()) return;

      const state = loadVirtualState();
      const pending = (state.openBets || []).filter((b) => !b.settled);
      if (!pending.length) return;

      const closed = [];
      for (const bet of pending) {
        const cfg = getVirtualTpSlConfig(bet);
        if (!cfg.enabled) continue;
        const ev = findEventForVirtualBet(bet);
        if (!ev || !isCurrentlyActive(ev)) continue;
        const cp = virtualBetMarkPrice(bet, ev);
        if (cp == null) continue;
        const pnlPct = virtualBetPercentPnl(bet, cp);
        if (pnlPct == null) continue;

        let action = null;
        let actionNote = '';
        if (cfg.takeProfitPrice < 1 && cp >= cfg.takeProfitPrice) {
          action = '止盈';
          actionNote = `≥${Math.round(cfg.takeProfitPrice * 100)}¢`;
        } else if (cfg.takeProfitPct > 0 && pnlPct >= cfg.takeProfitPct) {
          action = '止盈';
          actionNote = `+${pnlPct.toFixed(1)}%`;
        } else if (cfg.stopLossPct > 0 && pnlPct <= -cfg.stopLossPct) {
          action = '止损';
          actionNote = `${pnlPct.toFixed(1)}%`;
        }
        if (!action) continue;

        settleVirtualBetEarly(state, bet, ev, action, cp);
        closed.push({ bet, action, pnlPct, actionNote, closePrice: cp });
      }

      if (!closed.length) return;

      moveVirtualBetsToHistory(state, closed.map((c) => c.bet));
      saveVirtualState(state);
      syncVirtualBetUi();
      if (virtualOrdersPanelOpen) renderVirtualOrdersPanel();

      for (const c of closed) {
        const title = (c.bet.title || '').slice(0, 28);
        const px = c.closePrice != null ? `@${Math.round(c.closePrice * 100)}¢` : '';
        const pnl =
          c.pnlPct != null ? `浮动 ${c.pnlPct >= 0 ? '+' : ''}${c.pnlPct.toFixed(1)}%` : '';
        const msg = [`虚拟${c.action} ${title}`, c.actionNote, px, pnl, `余额 $${state.bankroll.toFixed(2)}`]
          .filter(Boolean)
          .join('\n');
        if (global.PMTrade?.toastTrade) {
          global.PMTrade.toastTrade(msg, c.action, 9000);
        } else {
          global.PMTrade?.toast?.(msg, c.action === '止盈' ? 'tp' : 'sl', 9000);
        }
      }
    }

    function parseOrderUsdcVal(v, fallback = 1) {
      const n = parseFloat(v);
      if (!Number.isFinite(n) || n <= 0) return fallback;
      return Math.min(10000, Math.round(n * 100) / 100);
    }

    function getEffectiveOrderUsdc() {
      if (intervalKey !== '5M') {
        return fixedOrderUsdc > 0 ? fixedOrderUsdc : 1;
      }
      return parseOrderUsdcVal(loadOrderRules().orderUsdc, fixedOrderUsdc > 0 ? fixedOrderUsdc : 1);
    }

    /** 虚拟投注每单金额（与实盘 orderUsdc 分离，默认取 virtualBet.amountUsd） */
    function getVirtualOrderUsdc() {
      if (virtualBet?.amountUsd != null && virtualBet.amountUsd > 0) {
        return parseOrderUsdcVal(virtualBet.amountUsd, 5);
      }
      const r = loadOrderRules();
      if (r.virtualOrderUsdc != null && r.virtualOrderUsdc > 0) {
        return parseOrderUsdcVal(r.virtualOrderUsdc, 5);
      }
      return getEffectiveOrderUsdc();
    }

    function applyOrderUsdcProfile(amt) {
      if (intervalKey !== '5M') {
        if (fixedOrderUsdc > 0) {
          global.pmOrderProfile = {
            fixedUsdc: fixedOrderUsdc,
            skipMinSizeBump: !!skipMinSizeBump,
          };
        }
        return;
      }
      const usdc = amt != null ? parseOrderUsdcVal(amt) : getEffectiveOrderUsdc();
      global.pmOrderProfile = {
        fixedUsdc: usdc,
        skipMinSizeBump: !!skipMinSizeBump,
      };
      const walletEl = $('orderAmtInput');
      const schedEl = $('crypto5mOrderUsdc');
      if (walletEl) walletEl.value = String(usdc);
      if (schedEl) schedEl.value = String(usdc);
    }

    function bind5mOrderAmountInput() {
      if (intervalKey !== '5M') return;
      const el = $('orderAmtInput');
      if (!el || el._pm5mAmtBound) return;
      el._pm5mAmtBound = true;
      const commit = () => {
        const usdc = parseOrderUsdcVal(el.value);
        saveOrderRules({ orderUsdc: usdc });
        applyOrderUsdcProfile(usdc);
        syncScheduleRulesSummary();
      };
      el.addEventListener('change', commit);
      el.addEventListener('blur', commit);
    }

    function getBuyTimingConfig() {
      const r = loadOrderRules();
      return {
        earlyBuyEnabled: r.earlyBuyEnabled === true,
        lateBuyEnabled: r.lateBuyEnabled === true,
        lateBuySec: Math.max(5, Math.min(280, parseInt(r.lateBuySec, 10) || 40)),
        onlyBuyBeforeEnd: !!r.onlyBuyBeforeEnd,
      };
    }

    function isLateBuyWindow() {
      const endMs = getSlotEndMsFromCountdown();
      if (!endMs) return false;
      const remSec = (endMs - Date.now()) / 1000;
      const { lateBuySec } = getBuyTimingConfig();
      return remSec >= lateBuySec - 2 && remSec <= lateBuySec + 2;
    }

    function canRunEarlyAutoBuy() {
      const t = getBuyTimingConfig();
      if (t.onlyBuyBeforeEnd || !t.earlyBuyEnabled) return false;
      const endMs = getSlotEndMsFromCountdown();
      if (!endMs) return true;
      const remSec = (endMs - Date.now()) / 1000;
      if (remSec <= 5) return false;
      if (t.lateBuyEnabled && remSec <= t.lateBuySec + 2) return false;
      return true;
    }

    function tokenIdForAutoSide(evKey, side) {
      const m = global.pmGetMarket?.(evKey);
      if (!m?.clobTokenIds?.length) return null;
      const { upIdx, downIdx } = getUpDownIndices(m.outcomes || ['Up', 'Down']);
      const idx = side === 'up' ? upIdx : downIdx;
      return idx >= 0 ? String(m.clobTokenIds[idx]) : null;
    }

    function loadOrderRules() {
      try {
        const raw = localStorage.getItem(ORDER_RULES_STORAGE_KEY);
        if (!raw) return defaultOrderRules();
        return { ...defaultOrderRules(), ...JSON.parse(raw) };
      } catch {
        return defaultOrderRules();
      }
    }

    function saveOrderRules(rules) {
      const next = { ...loadOrderRules(), ...rules };
      localStorage.setItem(ORDER_RULES_STORAGE_KEY, JSON.stringify(next));
      if (next.orderUsdc != null) applyOrderUsdcProfile(next.orderUsdc);
      syncScheduleRulesSummary();
      return next;
    }

    function getMergedRuleCfg(ruleCfg) {
      const base = ruleCfg || autoBuy90 || virtualBet || {};
      const stored = loadOrderRules();
      const min = (stored.minCents ?? 90) / 100;
      const max = (stored.maxCents ?? 95) / 100;
      return {
        ...base,
        threshold: min,
        maxThreshold: max,
        minInclusive: stored.minExclusive === false,
        maxInclusive: stored.maxExclusive === true,
      };
    }

    function syncScheduleRulesSummary() {
      const summary = $('crypto5mRulesSummary');
      if (!summary) return;
      const cfg = getMergedRuleCfg(autoBuy90);
      const timing = getBuyTimingConfig();
      const parts = [
        formatAutoOrderPriceRule(cfg),
        '非 BTC',
        '当前 5 分钟槽',
        '随机 Up/Down',
        `每单 $${getEffectiveOrderUsdc()}`,
        '市价 FOK',
      ];
      if (timing.onlyBuyBeforeEnd) {
        parts.push(`仅结束前 ${timing.lateBuySec}s 买`);
      } else {
        if (timing.earlyBuyEnabled) parts.push('盘中可首单');
        if (timing.lateBuyEnabled) parts.push(`结束前 ${timing.lateBuySec}s 二单`);
      }
      const rules = loadOrderRules();
      if (rules.tpSlEnabled) {
        parts.push(`实盘止盈+${rules.takeProfitPct}%/止损-${rules.stopLossPct}%`);
      }
      if (virtualBet && rules.virtualTpSlEnabled !== false) {
        const tpPx = rules.virtualTakeProfitPrice ?? 0.98;
        parts.push(
          `虚拟止盈+${rules.virtualTakeProfitPct ?? 5}%或≥${Math.round(tpPx * 100)}¢/止损-${rules.virtualStopLossPct ?? 20}%`,
        );
      }
      if (virtualBet && rules.virtualOrderPriceCents != null && rules.virtualOrderPriceCents !== '') {
        parts.push(`虚拟固定价 ${rules.virtualOrderPriceCents}¢`);
      }
      if (virtualBet) {
        parts.push(`虚拟每单 $${getVirtualOrderUsdc()}`);
        parts.push(formatVirtualStrategySummary());
      }
      if (rules.markovEnabled) {
        const thr = (rules.markovThreshold ?? 0.87) * 100;
        parts.push(`马尔可夫 ≥${thr.toFixed(0)}%（按币种分别统计）`);
      }
      if (intervalKey === '5M' && global.PMAiAssist?.isEnabled?.()) {
        const aiCfg = global.PMAiAssist.loadConfig();
        parts.push(`AI 虚拟辅助 ${aiCfg.mode === 'advise' ? '建议' : '拦截'}`);
      }
      summary.textContent = parts.join(' · ');
      const autoSt = $('crypto5mAuto90Status');
      if (autoSt) {
        autoSt.textContent = isAuto90Enabled()
          ? `已开启 · ${formatAutoOrderPriceRule(cfg)}`
          : '已关闭';
        autoSt.classList.toggle('on', isAuto90Enabled());
      }
      const virtSt = $('crypto5mVirtualStatus');
      if (virtSt) {
        virtSt.textContent = isVirtualBetEnabled() ? '已开启（仅模拟）' : '已关闭';
        virtSt.classList.toggle('on', isVirtualBetEnabled());
      }
      global.PMAuto?.updateFabState?.();
    }

    function syncAuto90ToggleUi() {
      if (!autoBuy90) return;
      const on = isAuto90Enabled();
      const chk = $('crypto5mAuto90Enabled');
      if (chk) chk.checked = on;
      for (const id of ['auto90ToggleBtn', 'crypto5mAuto90ToggleBtn']) {
        const btn = $(id);
        if (!btn) continue;
        btn.classList.toggle('on', on);
        btn.textContent = on ? '自动下单：开' : '自动下单：关';
      }
      syncScheduleRulesSummary();
    }

    function setAuto90Enabled(on) {
      if (!autoBuy90) return;
      const enabled = !!on;
      localStorage.setItem('pm_5m_auto90', enabled ? '1' : '0');
      syncAuto90ToggleUi();
    }

    function toggleAuto90() {
      if (!autoBuy90) return;
      setAuto90Enabled(!isAuto90Enabled());
      global.PMTrade?.toast?.(
        isAuto90Enabled()
          ? `5M 自动下单已开启（非 BTC，${formatAutoOrderPriceRule(getMergedRuleCfg(autoBuy90))} 随机 $1）`
          : '5M 自动下单已关闭',
        'info',
      );
    }

    function defaultVirtualState() {
      const start = virtualBet?.startBankroll ?? 100;
      return { bankroll: start, startBankroll: start, openBets: [], history: [], lastBetSlot: null };
    }

    function loadVirtualState() {
      try {
        const raw = localStorage.getItem(VIRTUAL_STORAGE_KEY);
        if (!raw) return defaultVirtualState();
        const parsed = JSON.parse(raw);
        const base = defaultVirtualState();
        return {
          ...base,
          ...parsed,
          openBets: Array.isArray(parsed.openBets) ? parsed.openBets : [],
          history: Array.isArray(parsed.history) ? parsed.history : [],
        };
      } catch {
        return defaultVirtualState();
      }
    }

    function saveVirtualState(state) {
      localStorage.setItem(VIRTUAL_STORAGE_KEY, JSON.stringify(state));
      void syncVirtualOrdersCsvFile(state);
    }

    function csvEscapeCell(val) {
      if (val == null) return '';
      const s = String(val);
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    }

    function csvRow(cells) {
      return cells.map(csvEscapeCell).join(',');
    }

    const VIRTUAL_ORDERS_CSV_HEADER =
      '状态,下单槽倒计时,槽Unix,市场,方向,入场价分,份数,扣款USD,策略,下单时间,结算时间,盈亏USD,平仓价分,浮动pct';

    function virtualOrderStatusLabel(b) {
      if (!b?.settled) return '待结算';
      if (b.result === '止盈' || b.result === '止损') return b.result;
      return b.result || '已结';
    }

    function formatVirtualOrderCsvTime(ts) {
      if (!ts) return '';
      return new Date(ts).toLocaleString('zh-CN', { hour12: false });
    }

    function virtualOrderToCsvRow(b) {
      const pending = !b.settled;
      const ev = pending ? findEventForVirtualBet(b) : null;
      const markPx = pending ? virtualBetMarkPrice(b, ev) : b.closePrice;
      const floatPct = markPx != null ? virtualBetPercentPnl(b, markPx) : null;
      const entryCents = b.entryPrice != null ? Math.round(b.entryPrice * 100) : '';
      const closeCents =
        b.closePrice != null
          ? Math.round(b.closePrice * 100)
          : markPx != null
            ? Math.round(markPx * 100)
            : '';
      const debit = b.totalDebit ?? b.cost ?? '';
      const profit =
        b.profit != null
          ? (b.profit >= 0 ? '+' : '') + Number(b.profit).toFixed(4)
          : pending
            ? ''
            : '';
      return csvRow([
        virtualOrderStatusLabel(b),
        b.placedSlotCountdown || formatVirtualPlacedSlotCountdown(b),
        b.slotTs ?? '',
        (b.title || '').slice(0, 120),
        (b.side || '').toUpperCase(),
        entryCents,
        b.shares != null ? Number(b.shares).toFixed(4) : '',
        debit !== '' ? Number(debit).toFixed(4) : '',
        b.strategy || 'consensus90',
        formatVirtualOrderCsvTime(b.placedAt),
        formatVirtualOrderCsvTime(b.settledAt),
        profit,
        closeCents,
        floatPct != null ? (floatPct >= 0 ? '+' : '') + floatPct.toFixed(2) : '',
      ]);
    }

    function collectVirtualOrdersAll(state) {
      const st = state || loadVirtualState();
      const openBets = st.openBets || [];
      const pending = openBets.filter((b) => !b.settled);
      const history = st.history || [];
      return pending.concat(history);
    }

    function sortVirtualOrders(list, newestFirst) {
      return list.slice().sort((a, b) => {
        const ta = a.settledAt ?? a.placedAt ?? 0;
        const tb = b.settledAt ?? b.placedAt ?? 0;
        if (tb !== ta) return newestFirst ? tb - ta : ta - tb;
        const pa = a.placedAt ?? 0;
        const pb = b.placedAt ?? 0;
        return newestFirst ? pb - pa : pa - pb;
      });
    }

    function buildVirtualOrdersCsv(state) {
      const all = sortVirtualOrders(collectVirtualOrdersAll(state), true);
      const rows = all.map(virtualOrderToCsvRow);
      return [VIRTUAL_ORDERS_CSV_HEADER, ...rows].join('\n') + (rows.length ? '\n' : '');
    }

    function buildVirtualBankrollSeries(state) {
      const st = state || loadVirtualState();
      const start = Number(st.startBankroll ?? 100);
      const all = sortVirtualOrders(collectVirtualOrdersAll(st), false);
      const points = [];

      if (!all.length) {
        const cur = Number(st.bankroll ?? start);
        const now = Date.now();
        return {
          points: [
            { t: now - 3600000, bankroll: cur, kind: 'start' },
            { t: now, bankroll: cur, kind: 'current' },
          ],
          start,
          current: cur,
          pnl: cur - start,
          min: Math.min(start, cur),
          max: Math.max(start, cur),
        };
      }

      let bal = start;
      const firstT = all.reduce((m, b) => Math.min(m, b.placedAt ?? Infinity), Infinity);
      points.push({
        t: (Number.isFinite(firstT) ? firstT : Date.now()) - 1,
        bankroll: start,
        kind: 'start',
      });

      for (const b of all) {
        const debit = Number(b.totalDebit ?? b.cost ?? 0);
        if (b.placedAt && debit > 0) {
          bal -= debit;
          points.push({ t: b.placedAt, bankroll: bal, kind: 'open' });
        }
        if (b.settled && b.settledAt) {
          bal += Number(b.payout ?? 0);
          points.push({ t: b.settledAt, bankroll: bal, kind: 'close' });
        }
      }

      const now = Date.now();
      const current = Number(st.bankroll ?? bal);
      if (
        !points.length ||
        points[points.length - 1].t <= now - 1000 ||
        Math.abs(points[points.length - 1].bankroll - current) > 0.0001
      ) {
        points.push({ t: now, bankroll: current, kind: 'current' });
      } else {
        points[points.length - 1].bankroll = current;
        points[points.length - 1].kind = 'current';
      }

      const vals = points.map((p) => p.bankroll);
      return {
        points,
        start,
        current,
        pnl: current - start,
        min: Math.min(...vals, start),
        max: Math.max(...vals, start),
      };
    }

    function formatVirtualChartTime(ts) {
      return new Date(ts).toLocaleString('zh-CN', {
        hour12: false,
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    }

    function renderVirtualBankrollChartSvg(seriesData) {
      const { points, start, current, pnl, min, max } = seriesData;
      if (!points?.length) return '';

      const w = 480;
      const h = 132;
      const pad = { l: 42, r: 10, t: 16, b: 24 };
      const innerW = w - pad.l - pad.r;
      const innerH = h - pad.t - pad.b;

      const tMin = points[0].t;
      const tMax = points[points.length - 1].t;
      const tSpan = Math.max(tMax - tMin, 60000);

      let yMin = Math.min(min, start) * 0.995;
      let yMax = Math.max(max, start) * 1.005;
      if (yMax - yMin < 1) {
        yMin -= 0.5;
        yMax += 0.5;
      }

      const xOf = (t) => pad.l + ((t - tMin) / tSpan) * innerW;
      const yOf = (v) => pad.t + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

      const linePts = points.map((p) => `${xOf(p.t).toFixed(1)},${yOf(p.bankroll).toFixed(1)}`).join(' ');
      const areaPts = `${xOf(points[0].t).toFixed(1)},${yOf(yMin).toFixed(1)} ${linePts} ${xOf(points[points.length - 1].t).toFixed(1)},${yOf(yMin).toFixed(1)}`;

      const up = current >= start;
      const stroke = up ? '#059669' : '#dc2626';
      const fill = up ? 'rgba(5,150,105,0.12)' : 'rgba(220,38,38,0.10)';
      const pnlClass = pnl >= 0 ? 'vo-pnl-pos' : 'vo-pnl-neg';
      const pnlLabel = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`;

      const yTicks = [yMin, start, yMax];
      const yTickSvg = yTicks
        .map((v) => {
          const y = yOf(v).toFixed(1);
          const isStart = Math.abs(v - start) < 0.001;
          return `<line x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}" stroke="${isStart ? '#d1d5db' : '#f3f4f6'}" stroke-dasharray="${isStart ? '4 3' : '0'}"/>
        <text x="${pad.l - 6}" y="${y}" text-anchor="end" dominant-baseline="middle" fill="#9ca3af" font-size="9">$${v.toFixed(0)}</text>`;
        })
        .join('');

      const xLabelSvg = [
        { t: tMin, label: formatVirtualChartTime(tMin), anchor: 'start' },
        { t: tMax, label: formatVirtualChartTime(tMax), anchor: 'end' },
      ]
        .map(({ t, label, anchor }) => {
          const x = xOf(t).toFixed(1);
          return `<text x="${x}" y="${h - 4}" text-anchor="${anchor}" fill="#9ca3af" font-size="9">${esc(label)}</text>`;
        })
        .join('');

      const last = points[points.length - 1];
      const dotX = xOf(last.t).toFixed(1);
      const dotY = yOf(last.bankroll).toFixed(1);

      return `<div class="vo-chart-wrap">
    <div class="vo-chart-hd">
      <span class="vo-chart-title">余额曲线</span>
      <span class="vo-chart-meta">当前 <b>$${current.toFixed(2)}</b> · 累计 <span class="${pnlClass}">${pnlLabel}</span> · 区间 $${min.toFixed(2)}–$${max.toFixed(2)}</span>
    </div>
    <svg class="vo-chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="虚拟余额曲线">
      ${yTickSvg}
      <polygon points="${areaPts}" fill="${fill}" />
      <polyline points="${linePts}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      <circle cx="${dotX}" cy="${dotY}" r="3.5" fill="#fff" stroke="${stroke}" stroke-width="2" />
      ${xLabelSvg}
    </svg>
  </div>`;
    }

    function downloadVirtualOrdersCsv() {
      const csv = buildVirtualOrdersCsv(loadVirtualState());
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `crypto-${intervalKey.toLowerCase()}-virtual-orders.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      global.PMTrade?.toast?.('已下载虚拟订单 CSV', 'info', 4000);
    }

    async function syncVirtualOrdersCsvFile(state) {
      if (!virtualBet || !global.location?.protocol?.startsWith('http')) return;
      try {
        const csv = buildVirtualOrdersCsv(state);
        const resp = await fetch(`/api/crypto-virtual-orders/${intervalKey}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csv }),
        });
        const json = await resp.json().catch(() => ({}));
        if (!resp.ok || !json.success) {
          console.warn('[virtual orders csv]', json.error || resp.status);
        }
      } catch (e) {
        console.warn('[virtual orders csv]', e);
      }
    }

    function isVirtualBetEnabled() {
      if (!virtualBet) return false;
      const el = $('virtualBetEnabled');
      if (el) return el.checked;
      return localStorage.getItem(VIRTUAL_BET_ENABLED_KEY) === '1';
    }

    function formatVirtualTime(ts) {
      if (!ts) return '—';
      return new Date(ts).toLocaleString('zh-CN', {
        hour12: false,
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    }

    function slotEndMsFromSlotTs(slotTs) {
      if (slotTs == null) return null;
      return slotTs * 1000 + slotSec * 1000;
    }

    /** 下单瞬间本 5 分钟槽倒计时（剩余 MM:SS，与标题栏一致） */
    function snapshotVirtualPlacedSlotTime(slotTs, placedAt = Date.now()) {
      const endMs = slotEndMsFromSlotTs(slotTs);
      if (!endMs) return { placedSlotCountdown: null, placedSlotRemSec: null };
      const remMs = Math.max(0, endMs - placedAt);
      const remSec = Math.floor(remMs / 1000);
      return {
        placedSlotCountdown: formatCountdown(remMs),
        placedSlotRemSec: remSec,
      };
    }

    function formatVirtualPlacedSlotCountdown(bet) {
      if (bet?.placedSlotCountdown) return bet.placedSlotCountdown;
      if (bet?.slotTs != null && bet?.placedAt) {
        const remMs = slotEndMsFromSlotTs(bet.slotTs) - bet.placedAt;
        if (Number.isFinite(remMs)) return formatCountdown(remMs);
      }
      return '—';
    }

    function virtualOrderTimeCellHtml(b) {
      const slotTime = formatVirtualPlacedSlotCountdown(b);
      const slotLabel = b.slotTs ? formatSlotResultTime(b.slotTs).split(' (')[0] : '—';
      return `<span class="vo-slot-placed-time" title="下单时本槽倒计时剩余">${esc(slotTime)}</span><br><small class="vo-slot-label">槽 ${esc(slotLabel)}</small>`;
    }

    function virtualOrderRowHtml(b, pending) {
      let tag;
      if (pending) {
        tag = '<span class="vo-tag pending">待结算</span>';
      } else if (b.result === '止盈') {
        tag = '<span class="vo-tag tp">止盈</span>';
      } else if (b.result === '止损') {
        tag = '<span class="vo-tag sl">止损</span>';
      } else {
        tag = `<span class="vo-tag ${b.result === '赢' ? 'win' : b.result === '输' ? 'loss' : 'flat'}">${esc(b.result || '已结')}</span>`;
      }
      const price = b.entryPrice != null ? Math.round(b.entryPrice * 100) + '¢' : '—';
      const debit = b.totalDebit ?? b.cost ?? 0;
      let floatPct = '—';
      if (pending) {
        const ev = findEventForVirtualBet(b);
        const cp = virtualBetMarkPrice(b, ev);
        const pct = cp != null ? virtualBetPercentPnl(b, cp) : null;
        if (pct != null) {
          floatPct = `<span class="${pct >= 0 ? 'vo-pnl-pos' : 'vo-pnl-neg'}">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</span>`;
        }
      }
      const pnl = pending
        ? '—'
        : b.profit == null
          ? '—'
          : `<span class="${b.profit >= 0 ? 'vo-pnl-pos' : 'vo-pnl-neg'}">${b.profit >= 0 ? '+' : ''}$${b.profit.toFixed(4)}</span>`;
      return `<tr>
        <td>${tag}</td>
        <td class="vo-time">${virtualOrderTimeCellHtml(b)}</td>
        <td class="vo-market">${esc(b.title || '—')}</td>
        <td>${esc((b.side || '').toUpperCase())}</td>
        <td>${price}</td>
        <td>${b.shares != null ? Number(b.shares).toFixed(3) : '—'}</td>
        <td>$${Number(debit).toFixed(3)}</td>
        <td class="num">${floatPct}</td>
        <td>${pnl}</td>
      </tr>`;
    }

    function renderVirtualOrdersPanel() {
      if (!virtualBet) return;
      const body = $('virtualOrdersBody');
      if (!body) return;
      try {
        const st = loadVirtualState();
        const openBets = st.openBets || [];
        const pending = openBets.filter((b) => !b.settled);
        const history = st.history || [];
        const all = sortVirtualOrders(collectVirtualOrdersAll(st), true);
        const total = all.length;
        const pageCount = Math.max(1, Math.ceil(total / virtualOrdersPageSize));
        virtualOrdersPage = Math.min(Math.max(virtualOrdersPage, 0), pageCount - 1);
        const start = virtualOrdersPage * virtualOrdersPageSize;
        const end = start + virtualOrdersPageSize;
        const pageItems = all.slice(start, end);

        const badge = $('virtualOrdersBadge');
        if (badge) {
          badge.textContent = String(total);
          badge.style.display = total > 0 ? 'inline-block' : 'none';
        }

        const vTpSl = getVirtualTpSlConfig();
        const vTpSlHint = vTpSl.enabled
          ? ` · 虚拟止盈 +${vTpSl.takeProfitPct}% 或 ≥${Math.round(vTpSl.takeProfitPrice * 100)}¢ / 止损 -${vTpSl.stopLossPct}%`
          : '';
        let html = `<div class="vo-summary">余额 <b>$${st.bankroll.toFixed(2)}</b> · 初始 $${st.startBankroll.toFixed(2)} · 待结算 ${pending.length} · 历史 ${history.length}${vTpSlHint}</div>`;
        html += renderVirtualBankrollChartSvg(buildVirtualBankrollSeries(st));

        if (!total) {
          html += `<div class="vo-empty">暂无虚拟订单<br><small>${esc(formatVirtualStrategySummary())} · 每单 $${getVirtualOrderUsdc()}</small></div>`;
        } else {
          html += `<div class="vo-pagination" style="display:flex;align-items:center;gap:10px;margin:8px 0">
            <button class="btn" type="button" ${virtualOrdersPage <= 0 ? 'disabled' : ''} onclick="event.stopPropagation(); ${globalApiName}.changeVirtualOrdersPage(-1)">上一页</button>
            <span style="font-size:12px;color:#6b7280;flex:1;text-align:center">第 ${virtualOrdersPage + 1}/${pageCount} 页</span>
            <button class="btn" type="button" ${virtualOrdersPage >= pageCount - 1 ? 'disabled' : ''} onclick="event.stopPropagation(); ${globalApiName}.changeVirtualOrdersPage(1)">下一页</button>
          </div>`;
          html += `<table class="vo-table"><thead><tr>
            <th>状态</th><th title="下单时 5 分钟槽倒计时（剩余 MM:SS）">下单时间</th><th>市场</th><th>方向</th><th>价</th><th>份数</th><th>扣款</th><th>浮动%</th><th>盈亏</th>
          </thead><tbody>`;
          pageItems.forEach((b) => {
            const isPending = !b.settled;
            html += virtualOrderRowHtml(b, isPending);
          });
          html += '</tbody></table>';
        }
        body.innerHTML = html;
      } catch (e) {
        console.error('[virtual orders render]', e);
        body.innerHTML = `<div class="vo-empty">列表渲染失败：${esc(String(e.message || e))}</div>`;
      }
    }

    function toggleVirtualOrdersPanel() {
      if (!virtualBet || !isVirtualBetEnabled()) return;
      virtualOrdersPanelOpen = !virtualOrdersPanelOpen;
      const panel = $('virtualOrdersPanel');
      if (panel) {
        panel.classList.toggle('open', virtualOrdersPanelOpen);
        panel.classList.remove('virtual-orders-panel--aux-off');
        panel.setAttribute('aria-hidden', virtualOrdersPanelOpen ? 'false' : 'true');
      }
      if (virtualOrdersPanelOpen) {
        virtualOrdersPage = 0; // 打开时从最新开始
        checkVirtualTpSl();
        renderVirtualOrdersPanel();
      }
    }

    function refreshVirtualOrdersPanel() {
      checkVirtualTpSl();
      renderVirtualOrdersPanel();
    }

    function changeVirtualOrdersPage(delta) {
      const st = loadVirtualState();
      const openBets = st.openBets || [];
      const pending = openBets.filter((b) => !b.settled);
      const history = st.history || [];
      const total = pending.length + history.length;
      if (!total) return;
      const pageCount = Math.max(1, Math.ceil(total / virtualOrdersPageSize));
      virtualOrdersPage = Math.min(Math.max(virtualOrdersPage + delta, 0), pageCount - 1);
      renderVirtualOrdersPanel();
    }

    function setVirtualBetAuxVisible(on) {
      const bankrollEl = $('virtualBankrollLabel');
      const ordersBtn = $('virtualOrdersBtn');
      const ordersPanel = $('virtualOrdersPanel');
      if (bankrollEl) bankrollEl.hidden = !on;
      if (ordersBtn) ordersBtn.hidden = !on;
      if (!on) {
        virtualOrdersPanelOpen = false;
        if (ordersPanel) {
          ordersPanel.classList.add('virtual-orders-panel--aux-off');
          ordersPanel.classList.remove('open');
          ordersPanel.setAttribute('aria-hidden', 'true');
        }
      } else if (ordersPanel) {
        ordersPanel.classList.remove('virtual-orders-panel--aux-off');
      }
    }

    function syncVirtualBetUi() {
      if (!virtualBet) return;
      const on = isVirtualBetEnabled();
      const btn = $('virtualBetToggleBtn');
      if (btn) {
        btn.classList.toggle('on', on);
        btn.textContent = on ? '虚拟投注：开' : '虚拟投注：关';
        btn.title = on ? formatVirtualStrategySummary() : '开启共识90虚拟模拟（不真实扣款）';
      }
      setVirtualBetAuxVisible(on);
      const st = loadVirtualState();
      const el = $('virtualBankrollLabel');
      if (el && on) {
        const openN = (st.openBets || []).filter((b) => !b.settled).length;
        el.textContent = `虚拟余额 $${st.bankroll.toFixed(2)}${openN ? ` · 待结算 ${openN}` : ''}`;
        el.classList.toggle('positive', st.bankroll >= st.startBankroll);
        el.classList.toggle('negative', st.bankroll < st.startBankroll);
      }
      if (!on) {
        syncScheduleRulesSummary();
        return;
      }
      renderVirtualOrdersPanel();
      syncScheduleRulesSummary();
    }

    function setVirtualBetEnabled(on) {
      if (!virtualBet) return;
      localStorage.setItem(VIRTUAL_BET_ENABLED_KEY, on ? '1' : '0');
      const el = $('virtualBetEnabled');
      if (el) el.checked = on;
      syncVirtualBetUi();
    }

    function toggleVirtualBet() {
      if (!virtualBet) return;
      setVirtualBetEnabled(!isVirtualBetEnabled());
      global.PMTrade?.toast?.(
        isVirtualBetEnabled()
          ? `虚拟投注已开启（${formatVirtualStrategySummary()}）`
          : '虚拟投注已关闭',
        'info',
      );
    }

    // ─── 马尔可夫链策略过滤 ───────────────────────────────────────────────
    //
    // 状态：Up | Down（当前最优状态 j* = 盘口价更高的一侧）
    // 转移矩阵（近似）：
    //   P(j* → j*)       = 0.87  （持续概率，可在规则中配置）
    //   P(j* → 非j*)     = 0.13
    // 过滤规则：
    //   - 计算候选方向是否为当前 j*；
    //   - 从历史 N 槽滚动估计 P(state_t = j* | state_{t-1} = j*)；
    //   - 若启用且估计值 < markovThreshold，则拒绝进场。
    //
    const MARKOV_HISTORY_KEY = 'pm_5m_markov_history';
    const MARKOV_WINDOW = 30; // 滚动窗口（槽数）
    const MARKOV_MIN_SLOTS = 3; // 至少 3 个槽点 → 2 次转移才可算 P
    const MARKOV_MIN_TRANSITIONS = 2;

    /** 5M 页展示马尔可夫列时始终积累样本（与是否启用过滤无关） */
    function shouldRecordMarkovHistory() {
      return !!showMarkovColumn && intervalKey === '5M';
    }

    function isMarkovEnabled() {
      const el = $('crypto5mMarkovEnabled');
      if (el) return !!el.checked;
      return loadOrderRules().markovEnabled === true;
    }

    function refreshMarkovSnapshot() {
      if (!shouldRecordMarkovHistory() || !events.length) return;
      markovEventsSnapshot = events.map((ev) => ({
        slug: ev.slug,
        upPrice: ev.upPrice,
        downPrice: ev.downPrice,
      }));
    }

    function countMarkovSlotsForEvent(ev) {
      const slugKey = (ev?.slug || '').toLowerCase();
      const coin = coinFromEventSlug(ev?.slug);
      const hist = loadMarkovHistory();
      const slots = new Set();
      for (const h of hist) {
        const hs = (h.slug || '').toLowerCase();
        const hc = (h.c || '').toLowerCase();
        if (slugKey && hs === slugKey) slots.add(h.s);
        else if (coin && hc === coin) slots.add(h.s);
      }
      return slots.size;
    }

    function getMarkovThreshold() {
      const r = loadOrderRules();
      const t = parseFloat(r.markovThreshold);
      return Number.isFinite(t) && t > 0 && t < 1 ? t : 0.87;
    }

    // 记录每槽、每个市场（slug）结束时的 j*，各行独立统计
    function recordMarkovSlot(slotTs, winnerSide, coin, slug) {
      const slugKey = (slug || '').toLowerCase();
      const c = (coin || '').toLowerCase();
      if (!slugKey && !c) return;
      let hist = loadMarkovHistory();
      if (hist.some((h) => h.s === slotTs && (h.slug || '').toLowerCase() === slugKey)) return;
      hist.push({ s: slotTs, w: winnerSide, c, slug: slugKey });
      if (hist.length > MARKOV_WINDOW * 40) hist = hist.slice(-MARKOV_WINDOW * 40);
      localStorage.setItem(MARKOV_HISTORY_KEY, JSON.stringify(hist));
    }

    function recordMarkovSlotsFromEvents(endingEvents, slotTs) {
      if (!shouldRecordMarkovHistory() || !endingEvents?.length || slotTs == null) return;
      const seen = new Set();
      for (const ev of endingEvents) {
        const slug = (ev?.slug || '').toLowerCase();
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        const up = ev?.upPrice;
        const down = ev?.downPrice;
        if (up == null && down == null) continue;
        const w =
          up != null && down != null && !Number.isNaN(up) && !Number.isNaN(down)
            ? up > down
              ? 'up'
              : down > up
                ? 'down'
                : 'flat'
            : 'flat';
        recordMarkovSlot(slotTs, w, coinFromEventSlug(slug), slug);
      }
    }

    function loadMarkovHistory() {
      try {
        const raw = JSON.parse(localStorage.getItem(MARKOV_HISTORY_KEY) || '[]');
        return Array.isArray(raw) ? raw : [];
      } catch {
        return [];
      }
    }

    function calcMarkovProbFromSeries(recent, minTransitions = MARKOV_MIN_TRANSITIONS) {
      const slots = recent?.length || 0;
      if (slots < 2) return { prob: null, transitions: 0, slots };
      let total = 0,
        stay = 0;
      for (let i = 1; i < recent.length; i++) {
        const prev = recent[i - 1].w;
        const cur = recent[i].w;
        if (prev === 'up' || prev === 'down') {
          total++;
          if (cur === prev) stay++;
        }
      }
      if (total < minTransitions) return { prob: null, transitions: total, slots };
      return { prob: stay / total, transitions: total, slots };
    }

    /** 按本市场 slug 独立估计 P；不足 3 槽时可用 2 槽初估（各行数值会不同） */
    function estimateMarkovProbDetailed(ev, window = MARKOV_WINDOW) {
      const slugKey = (ev?.slug || '').toLowerCase();
      const coin = coinFromEventSlug(ev?.slug);
      const hist = loadMarkovHistory();
      const c = (coin || '').toLowerCase();
      let slugRecent = hist
        .filter((h) => slugKey && (h.slug || '').toLowerCase() === slugKey)
        .slice(-window);
      if (slugRecent.length < 2 && c) {
        slugRecent = hist.filter((h) => (h.c || '').toLowerCase() === c).slice(-window);
      }
      const slugFull = calcMarkovProbFromSeries(slugRecent, MARKOV_MIN_TRANSITIONS);
      if (slugFull.prob != null) {
        return { ...slugFull, source: 'market', needed: MARKOV_MIN_SLOTS };
      }
      const slugEarly = calcMarkovProbFromSeries(slugRecent, 1);
      if (slugEarly.prob != null && slugEarly.transitions >= 1) {
        return { ...slugEarly, source: 'market-early', needed: MARKOV_MIN_SLOTS };
      }

      const slotCount = countMarkovSlotsForEvent(ev);
      return {
        prob: null,
        transitions: slugEarly.transitions,
        slots: Math.max(slugRecent.length, slotCount),
        source: null,
        needed: MARKOV_MIN_SLOTS,
      };
    }

    function estimateMarkovSelfProb(evOrCoin, window = MARKOV_WINDOW) {
      const ev =
        evOrCoin && typeof evOrCoin === 'object'
          ? evOrCoin
          : { slug: '', __coin: String(evOrCoin || '') };
      return estimateMarkovProbDetailed(ev, window).prob;
    }

    // 当前最优状态 j*：返回 'up' | 'down' | null
    function currentBestState() {
      let bestUp = -Infinity, bestDown = -Infinity;
      for (const ev of events) {
        if (!isCurrentlyActive(ev) || isBtcEvent(ev)) continue;
        if (ev.upPrice != null) bestUp = Math.max(bestUp, ev.upPrice);
        if (ev.downPrice != null) bestDown = Math.max(bestDown, ev.downPrice);
      }
      if (bestUp === -Infinity && bestDown === -Infinity) return null;
      if (bestUp > bestDown) return 'up';
      if (bestDown > bestUp) return 'down';
      return null; // flat
    }

    // 主过滤函数：按本市场币种估计 P，j* 取本市场 Up/Down 领先侧
    function markovFilter(candidateSide, ev) {
      if (!isMarkovEnabled()) return { pass: true };
      const threshold = getMarkovThreshold();
      const coin = coinFromEventSlug(ev?.slug);
      const detail = estimateMarkovProbDetailed(ev);
      const prob = detail.prob;
      const jStar = eventLocalJStar(ev);

      if (prob === null) {
        return {
          pass: true,
          prob: null,
          jStar,
          coin,
          detail,
          reason: `${(coin || '?').toUpperCase()} 本市场样本 ${detail.slots}/${detail.needed} 槽，暂不过滤`,
        };
      }
      const useEarly = detail.source === 'market-early';
      if (jStar === null || jStar === 'flat') {
        return { pass: false, prob, jStar, coin, reason: '本市场无明确领先侧' };
      }
      if (candidateSide !== jStar) {
        return {
          pass: false,
          prob,
          jStar,
          coin,
          reason: `候选 ${candidateSide} ≠ 本市场 j*=${jStar}`,
        };
      }
      if (!useEarly && prob < threshold) {
        return {
          pass: false,
          prob,
          jStar,
          coin,
          detail,
          reason: `${(coin || '').toUpperCase()} 持续 ${(prob * 100).toFixed(1)}% < 阈值 ${(threshold * 100).toFixed(0)}%`,
        };
      }
      if (useEarly) {
        return {
          pass: true,
          prob,
          jStar,
          coin,
          detail,
          reason: `${(coin || '').toUpperCase()} 初估 ${(prob * 100).toFixed(1)}%（样本未满，暂不过滤）`,
        };
      }
      return {
        pass: true,
        prob,
        jStar,
        coin,
        detail,
        reason: `${(coin || '').toUpperCase()} 持续 ${(prob * 100).toFixed(1)}% ≥ ${(threshold * 100).toFixed(0)}%`,
      };
    }

    function eventLocalJStar(ev) {
      const up = ev?.upPrice;
      const down = ev?.downPrice;
      if (up == null || down == null || Number.isNaN(up) || Number.isNaN(down)) return null;
      if (up > down) return 'up';
      if (down > up) return 'down';
      return 'flat';
    }

    /** 与马尔可夫列 Up✓ / Dn✓ 完全一致：启用 + 价格在区间内 + markovFilter 通过 */
    function isVirtualMarkovCheckSide(ev, side) {
      if (!isMarkovEnabled()) return false;
      const snap = getMarkovCellSnapshot(ev);
      if (!snap.enabled) return false;
      if (side === 'up') return !!(snap.upInRange && snap.upPass);
      if (side === 'down') return !!(snap.downInRange && snap.downPass);
      return false;
    }

    function virtualBetPlacementKey(slotTs, evId, side) {
      return `${slotTs}:${evId}:${side}`;
    }

    /** 本槽已开过仓的市场+方向（含已平仓/刷新页面后从 localStorage 恢复） */
    function virtualBetUsedKeysForSlot(slot, state) {
      const keys = new Set();
      const addBet = (b) => {
        if (b?.slotTs === slot && b?.evId != null && b?.side) {
          keys.add(virtualBetPlacementKey(slot, b.evId, b.side));
        }
      };
      for (const b of state?.openBets || []) addBet(b);
      for (const b of state?.history || []) addBet(b);
      for (const k of virtualMarkovPlacedKeys) {
        if (k.startsWith(`${slot}:`)) keys.add(k);
      }
      return keys;
    }

    function restoreVirtualPlacedKeysForSlot(slotTs) {
      if (slotTs == null) return;
      const state = loadVirtualState();
      for (const k of virtualBetUsedKeysForSlot(slotTs, state)) {
        virtualMarkovPlacedKeys.add(k);
      }
    }

    function clearVirtualMarkovPlacedKeys(slotTs) {
      if (slotTs == null) {
        virtualMarkovPlacedKeys.clear();
        return;
      }
      const prefix = `${slotTs}:`;
      for (const k of [...virtualMarkovPlacedKeys]) {
        if (k.startsWith(prefix)) virtualMarkovPlacedKeys.delete(k);
      }
    }

    function getMarkovCellSnapshot(ev) {
      const enabled = isMarkovEnabled();
      const threshold = getMarkovThreshold();
      const coin = coinFromEventSlug(ev?.slug);
      const detail = estimateMarkovProbDetailed(ev);
      const prob = detail.prob;
      const jStar = eventLocalJStar(ev);
      const localJ = jStar;
      const cfg = getMergedRuleCfg(autoBuy90 || virtualBet);
      const upInRange = isPriceInAutoOrderRange(ev?.upPrice, cfg);
      const downInRange = isPriceInAutoOrderRange(ev?.downPrice, cfg);
      const upPass = enabled && upInRange ? markovFilter('up', ev).pass : null;
      const downPass = enabled && downInRange ? markovFilter('down', ev).pass : null;
      const btc = isBtcEvent(ev);
      return {
        enabled,
        threshold,
        prob,
        detail,
        jStar,
        localJ,
        coin,
        btc,
        upInRange,
        downInRange,
        upPass,
        downPass,
      };
    }

    function markovCellInnerHtml(ev) {
      if (!showMarkovColumn) return '—';
      const snap = getMarkovCellSnapshot(ev);
      if (!snap.enabled) {
        const slots = countMarkovSlotsForEvent(ev);
        const probStrOff = slots > 0 ? `${slots}/${MARKOV_MIN_SLOTS}槽` : '0/3槽';
        return `<span class="markov-cell markov-off" title="未勾选「启用马尔可夫策略过滤」：仅积累样本，不按概率拦单">
        <span class="markov-p">${probStrOff}</span>
        <span class="markov-meta">过滤关 · 样本积累中</span>
      </span>`;
      }

      const thrPct = Math.round(snap.threshold * 100);
      const needed = snap.detail?.needed ?? MARKOV_MIN_SLOTS;
      const slots = Math.max(snap.detail?.slots ?? 0, countMarkovSlotsForEvent(ev));
      let probStr;
      if (snap.prob != null) {
        const early = snap.detail?.source === 'market-early';
        probStr = `${(snap.prob * 100).toFixed(1)}%${early ? '†' : ''}`;
      } else {
        probStr = `${slots}/${needed}槽`;
      }
      const probCls =
        snap.prob == null
          ? 'markov-warn'
          : snap.prob >= snap.threshold
            ? 'markov-pass'
            : 'markov-fail';

      const jLabel = snap.jStar && snap.jStar !== 'flat' ? snap.jStar.toUpperCase() : '—';
      const coinLabel = snap.coin ? snap.coin.toUpperCase() : '—';

      const sideTags = [];
      if (snap.upInRange) {
        sideTags.push(
          `<span class="markov-side ${snap.upPass ? 'ok' : 'no'}">Up${snap.upPass ? '✓' : '✗'}</span>`,
        );
      }
      if (snap.downInRange) {
        sideTags.push(
          `<span class="markov-side ${snap.downPass ? 'ok' : 'no'}">Dn${snap.downPass ? '✓' : '✗'}</span>`,
        );
      }

      const srcLabel =
        snap.detail?.source === 'market'
          ? '本市场独立统计'
          : snap.detail?.source === 'market-early'
            ? '本市场初估（≥2槽，未满3槽不过滤）'
            : snap.detail?.source === 'coin-legacy'
              ? '旧版按币种缓存'
              : '';
      const title = [
        snap.prob != null
          ? `${coinLabel} · P(j*→j*)：${probStr}（${srcLabel}）`
          : `${coinLabel} · 本市场样本 ${slots}/${needed} 槽（每槽结束 +1，各行独立）`,
        `阈值 ≥${thrPct}%`,
        `本市场 j*：${jLabel}`,
        snap.prob == null ? '样本不足时：策略暂不过滤，允许进场' : '',
        snap.btc ? 'BTC 仅展示，不参与自动/虚拟下单' : '',
        snap.upInRange ? `Up 进场：${snap.upPass ? '允许' : '拒绝'}` : '',
        snap.downInRange ? `Down 进场：${snap.downPass ? '允许' : '拒绝'}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      return `<span class="markov-cell ${probCls}" title="${esc(title)}">
        <span class="markov-p">${probStr}</span>
        <span class="markov-meta">${esc(coinLabel)} · j* ${esc(jLabel)}${snap.prob == null ? ' · 积累中' : snap.detail?.source === 'market-early' ? ' · 初估' : ''}${snap.btc ? ' · 不下单' : ''}</span>
        ${sideTags.length ? `<span class="markov-sides">${sideTags.join('')}</span>` : ''}
      </span>`;
    }

    function patchMarkovCellInDom(ev) {
      if (!showMarkovColumn) return false;
      const row = document.querySelector(`tr[data-ev-id="${cssEscape(String(ev.id))}"]`);
      if (!row) return false;
      const cell = row.querySelector('[data-markov="1"]');
      if (!cell) return false;
      cell.innerHTML = markovCellInnerHtml(ev);
      return true;
    }
    // ─────────────────────────────────────────────────────────────────────

    /** 是否在自动/虚拟下单价格区间内（默认仅 min；配置 maxThreshold 后为区间） */
    function isPriceInAutoOrderRange(price, cfg) {
      if (price == null || Number.isNaN(price)) return false;
      const min = cfg.threshold ?? cfg.minThreshold ?? 0.9;
      const max = cfg.maxThreshold;
      if (max == null || max <= min) return price >= min;
      const minOk = cfg.minInclusive === true ? price >= min : price > min;
      const maxOk = cfg.maxInclusive === true ? price <= max : price < max;
      return minOk && maxOk;
    }

    function formatAutoOrderPriceRule(cfg) {
      const min = cfg?.threshold ?? cfg?.minThreshold ?? 0.9;
      const max = cfg?.maxThreshold;
      if (max == null || max <= min) return `≥${Math.round(min * 100)}¢`;
      const lo = cfg?.minInclusive === true ? '≥' : '>';
      const hi = cfg?.maxInclusive === true ? '≤' : '<';
      return `${lo}${Math.round(min * 100)}¢ 且 ${hi}${Math.round(max * 100)}¢`;
    }

    function collectAuto90Candidates(ruleCfg) {
      const cfg = getMergedRuleCfg(ruleCfg || autoBuy90 || virtualBet);
      const excludeBtc = cfg.excludeBtc !== false;
      const candidates = [];
      for (const ev of events) {
        if (!isCurrentlyActive(ev)) continue;
        if (excludeBtc && isBtcEvent(ev)) continue;
        if (!ev.primaryMarket) continue;
        const up = ev.upPrice;
        const down = ev.downPrice;
        if (isPriceInAutoOrderRange(up, cfg)) {
          const mf = markovFilter('up', ev);
          if (mf.pass) candidates.push({ ev, side: 'up', price: up, markov: mf });
          else if (isMarkovEnabled()) console.log(`[Markov] 过滤 up: ${mf.reason}`);
        }
        if (isPriceInAutoOrderRange(down, cfg)) {
          const mf = markovFilter('down', ev);
          if (mf.pass) candidates.push({ ev, side: 'down', price: down, markov: mf });
          else if (isMarkovEnabled()) console.log(`[Markov] 过滤 down: ${mf.reason}`);
        }
      }
      return candidates;
    }

    function getVirtualStrategyCfg() {
      const v = virtualBet || {};
      const minSlotRemSec =
        v.minSlotRemSec != null && v.minSlotRemSec > 0
          ? v.minSlotRemSec
          : Math.max(60, Math.ceil((urgentMs || 60000) / 1000));
      return {
        triggerMin: v.triggerMin >= 2 ? v.triggerMin : 2,
        triggerCents: v.triggerCents ?? 90,
        entryMinCents: v.entryMinCents ?? 70,
        entryMaxCents: v.entryMaxCents ?? 98,
        holdMinCents: v.holdMinCents ?? 85,
        divergenceBelowCents: v.divergenceBelowCents ?? 20,
        minSlotRemSec,
      };
    }

    function formatVirtualStrategySummary() {
      const c = getVirtualStrategyCfg();
      return (
        `共识：≥${c.triggerMin}个同边≥${c.triggerCents}¢→各市场${c.entryMinCents}¢<价<${c.entryMaxCents}¢ $${getVirtualOrderUsdc()}/笔` +
        ` · 槽剩≥${formatCountdown(c.minSlotRemSec * 1000)}` +
        ` · 同边≥${c.holdMinCents}¢仍≥${c.triggerMin}个` +
        ` · 任一同边<${c.divergenceBelowCents}¢本槽跳过`
      );
    }

    function virtualPriceCents(price) {
      if (price == null || Number.isNaN(price)) return null;
      return Math.round(price * 100);
    }

    function virtualConsensusEntryOk(cents, cfg) {
      const c = cfg || getVirtualStrategyCfg();
      return (
        cents != null &&
        cents > c.entryMinCents &&
        cents < c.entryMaxCents
      );
    }

    function getVirtualSlotRemainingMs() {
      const endMs = getSlotEndMsFromCountdown();
      if (endMs) return endMs - Date.now();
      const end = slotEndMsFromSlotTs(getCurrentSlotTs());
      return end ? end - Date.now() : null;
    }

    function virtualConsensusTimeGate(cfg) {
      const c = cfg || getVirtualStrategyCfg();
      const remMs = getVirtualSlotRemainingMs();
      if (remMs == null) return { ok: true, remMs: null };
      const minMs = c.minSlotRemSec * 1000;
      if (remMs <= minMs) {
        return {
          ok: false,
          remMs,
          skipReason: `槽剩余 ${formatCountdown(remMs)} ≤ ${formatCountdown(minMs)}，槽末不开新仓`,
        };
      }
      return { ok: true, remMs };
    }

    function checkVirtualConsensusTiming(cfg) {
      return virtualConsensusTimeGate(cfg);
    }

    function countSideAtOrAboveCents(list, side, cents) {
      let n = 0;
      for (const ev of list) {
        const p = virtualPriceCents(virtualSidePrice(ev, side));
        if (p != null && p >= cents) n++;
      }
      return n;
    }

    function virtualSidePrice(ev, side) {
      return side === 'up' ? ev.upPrice : ev.downPrice;
    }

    function activeVirtualConsensusEvents() {
      const list = [];
      for (const ev of events) {
        if (!isCurrentSlotEvent(ev)) continue;
        if (!ev.primaryMarket) continue;
        list.push(ev);
      }
      return list;
    }

    /** 虚拟模拟估单：同步本地计算，不依赖 CLOB 异步接口 */
    function estimateVirtualBetSync(amountUsd, entryPrice) {
      const buy = global.PMTrade?.estimateMarketBuy;
      if (!buy) return null;
      const price = entryPrice > 0 && entryPrice < 1 ? entryPrice : 0.5;
      const worstPrice = Math.min(0.99, Math.max(0.01, price * 1.02));
      const rough = buy(amountUsd, worstPrice);
      if (!rough || rough.shares <= 0 || rough.costUsdc <= 0) return null;
      const feeUsdc =
        rough.feeUsdc ?? global.PMTrade?.calcTakerFeeUsdc?.(rough.shares, price, 0.07) ?? 0;
      const totalDebit =
        rough.totalDebit ?? Math.round((rough.costUsdc + feeUsdc) * 1e4) / 1e4;
      return {
        costUsdc: rough.costUsdc,
        shares: rough.shares,
        marketPrice: price,
        worstPrice,
        feeUsdc,
        totalDebit,
        minShares: 5,
        meetsMinSize: rough.shares + 1e-9 >= 5,
        fromBook: false,
      };
    }

    function isLosingVirtualBet(b) {
      if (!b?.settled) return false;
      if (b.result === '输' || b.result === '止损') return true;
      if (b.profit != null && Number(b.profit) < -0.0001) return true;
      return false;
    }

    function buildVirtualLossAuditPayload(limit = 40) {
      const state = loadVirtualState();
      const all = sortVirtualOrders(collectVirtualOrdersAll(state), true);
      const settled = all.filter((b) => b.settled);
      const losses = settled.filter(isLosingVirtualBet).slice(0, limit);
      const wins = settled.filter((b) => b.result === '赢' || b.result === '止盈' || (b.profit != null && b.profit > 0));
      const totalLossUsd = losses.reduce((s, b) => s + Math.abs(Number(b.profit) || 0), 0);
      const totalWinUsd = wins.reduce((s, b) => s + Math.max(0, Number(b.profit) || 0), 0);

      const bySide = { up: 0, down: 0 };
      const byResult = {};
      for (const b of losses) {
        const side = (b.side || '').toLowerCase();
        if (side === 'up' || side === 'down') bySide[side]++;
        const r = b.result || '亏';
        byResult[r] = (byResult[r] || 0) + 1;
      }

      return {
        interval: intervalKey,
        strategySummary: formatVirtualStrategySummary(),
        strategy: getVirtualStrategyCfg(),
        virtualRiskRules: {
          tpSlEnabled: loadOrderRules().virtualTpSlEnabled !== false,
          takeProfitPct: loadOrderRules().virtualTakeProfitPct ?? 5,
          stopLossPct: loadOrderRules().virtualStopLossPct ?? 20,
        },
        stats: {
          settledOrders: settled.length,
          lossCount: losses.length,
          winCount: wins.length,
          winRatePct: settled.length ? Math.round((wins.length / settled.length) * 1000) / 10 : null,
          totalLossUsd: Math.round(totalLossUsd * 100) / 100,
          totalWinUsd: Math.round(totalWinUsd * 100) / 100,
          netUsd: Math.round((totalWinUsd - totalLossUsd) * 100) / 100,
          bankrollUsd: Math.round((state.bankroll || 0) * 100) / 100,
          startBankrollUsd: state.startBankroll ?? null,
          lossBySide: bySide,
          lossByResult: byResult,
        },
        losingOrders: losses.map((b) => ({
          title: (b.title || '').slice(0, 56),
          side: (b.side || '').toUpperCase(),
          result: b.result || '亏',
          entryCents: b.entryPrice != null ? Math.round(b.entryPrice * 100) : null,
          closeUpCents: b.closeUp != null ? Math.round(b.closeUp * 100) : null,
          closeDownCents: b.closeDown != null ? Math.round(b.closeDown * 100) : null,
          winner: b.winner || null,
          profitUsd: b.profit != null ? Math.round(b.profit * 10000) / 10000 : null,
          debitUsd: b.totalDebit ?? b.cost ?? null,
          placedSlotRemSec: b.placedSlotRemSec ?? null,
          placedSlotCountdown: b.placedSlotCountdown || null,
          strategy: b.strategy || 'consensus90',
          slotTs: b.slotTs ?? null,
          settledAt: b.settledAt ? formatVirtualOrderCsvTime(b.settledAt) : null,
          reversed:
            b.winner && b.side
              ? b.winner.toLowerCase() !== String(b.side).toLowerCase() && b.winner !== '平' && b.winner !== '—'
              : null,
        })),
      };
    }

    function buildVirtualAiContext(analysis) {
      const list = activeVirtualConsensusEvents();
      const a = analysis || analyzeVirtualConsensus(list);
      const cfg = getVirtualStrategyCfg();
      const state = loadVirtualState();
      const slot = getCurrentSlotTs();
      const rules = loadOrderRules();
      const amount = getVirtualOrderUsdc();
      const usedKeys = virtualBetUsedKeysForSlot(slot, state);

      function enrichEvent(ev) {
        const upC = virtualPriceCents(ev.upPrice);
        const downC = virtualPriceCents(ev.downPrice);
        const coin = coinFromEventSlug(ev.slug);
        const mk = estimateMarkovProbDetailed(ev);
        const depth = (side) => {
          const d = side === 'up' ? ev.upDepth : ev.downDepth;
          if (!d) return null;
          return {
            bidSz: d.bidSize ?? d.bidSz ?? null,
            askSz: d.askSize ?? d.askSz ?? null,
            mid: d.mid ?? null,
          };
        };
        return {
          title: (ev.title || '').slice(0, 48),
          slug: ev.slug || '',
          coin: coin || '',
          upCents: upC,
          downCents: downC,
          spreadCents: upC != null && downC != null ? Math.abs(upC - downC) : null,
          volume24hUsd: ev.volume24hr || 0,
          totalVolumeUsd: ev.volume || 0,
          openInterestUsd: ev.openInterest || 0,
          liquidityUsd: ev.liquidity || 0,
          targetPriceUsd: ev.targetPrice ?? ev.gammaPriceToBeat ?? null,
          spotPriceUsd: ev.currentPrice ?? ev.spotPrice ?? null,
          priceDiffUsd: ev.priceDiff ?? null,
          upDepth: depth('up'),
          downDepth: depth('down'),
          markov: {
            probStay: mk.prob != null ? Math.round(mk.prob * 1000) / 1000 : null,
            slots: mk.slots,
            transitions: mk.transitions,
            source: mk.source,
            localLeader: eventLocalJStar(ev),
          },
          isBtc: isBtcEvent(ev),
          tradable: isCurrentlyActive(ev),
        };
      }

      const candidates = (a.candidates || []).map((pick) => {
        const ev = pick.ev;
        const evKey = String(ev.id);
        const est = estimateVirtualBetSync(amount, pick.price);
        return {
          ...enrichEvent(ev),
          betSide: pick.side,
          entryCents: virtualPriceCents(pick.price),
          strategy: pick.strategy || 'consensus90',
          estDebitUsd: est?.totalDebit ?? null,
          estShares: est?.shares ?? null,
          alreadyPlacedThisSlot: usedKeys.has(virtualBetPlacementKey(slot, evKey, pick.side)),
        };
      });

      const pendingSlot = (state.openBets || []).filter((b) => b.slotTs === slot && !b.settled);
      const recentHistory = (state.history || []).slice(-5).map((b) => ({
        result: b.result,
        side: b.side,
        title: (b.title || '').slice(0, 32),
        profitUsd: b.profit,
      }));

      return {
        slotTimestamp: slot,
        slotRemainingSec: a.slotRemMs != null ? Math.round(a.slotRemMs / 1000) : null,
        strategy: cfg,
        strategySummary: formatVirtualStrategySummary(),
        consensus: {
          triggerSides: a.triggerSides || [],
          triggerLabel: a.triggerSide || null,
          activeMarketCount: a.activeN,
          skipReason: a.skipReason || null,
          weakened: a.weakened || [],
          slotDivergence: !!a.slotDivergence,
          upAtTriggerCents: countSideAtOrAboveCents(list, 'up', cfg.triggerCents),
          downAtTriggerCents: countSideAtOrAboveCents(list, 'down', cfg.triggerCents),
          upAtHoldCents: countSideAtOrAboveCents(list, 'up', cfg.holdMinCents),
          downAtHoldCents: countSideAtOrAboveCents(list, 'down', cfg.holdMinCents),
          candidateCount: (a.candidates || []).length,
        },
        globalMarkovLeader: currentBestState(),
        virtualWallet: {
          bankrollUsd: Math.round((state.bankroll || 0) * 100) / 100,
          startBankrollUsd: state.startBankroll ?? null,
          orderUsdcPerBet: amount,
          openBetsTotal: (state.openBets || []).filter((b) => !b.settled).length,
          pendingThisSlot: pendingSlot.length,
          recentResults: recentHistory,
        },
        virtualRiskRules: {
          tpSlEnabled: rules.virtualTpSlEnabled !== false,
          takeProfitPct: rules.virtualTakeProfitPct ?? 5,
          takeProfitPriceCents:
            rules.virtualTakeProfitPrice != null ? Math.round(rules.virtualTakeProfitPrice * 100) : 98,
          stopLossPct: rules.virtualStopLossPct ?? 20,
        },
        allMarkets: list.map(enrichEvent),
        candidates,
      };
    }

    function buildVirtualConsensusDebug() {
      const list = activeVirtualConsensusEvents();
      const analysis = analyzeVirtualConsensus(list);
      const slot = getCurrentSlotTs();
      const state = loadVirtualState();
      const usedKeys = [...virtualBetUsedKeysForSlot(slot, state)];
      const overrideCents = getVirtualOrderPriceCentsOverride();
      return {
        virtualEnabled: isVirtualBetEnabled(),
        virtualBusy: virtualBetBusy,
        bookBusy,
        loading,
        slot,
        overrideCents,
        bankroll: state.bankroll,
        ...analysis,
        usedKeys,
        markets: list.map((ev) => {
          const upC = virtualPriceCents(ev.upPrice);
          const downC = virtualPriceCents(ev.downPrice);
          return {
            title: (ev.title || '').slice(0, 40),
            upC,
            downC,
            tradable: isCurrentlyActive(ev),
          };
        }),
      };
    }

    function countVirtualConsensusTrigger(list, side, cfg) {
      const c = cfg || getVirtualStrategyCfg();
      return countSideAtOrAboveCents(list, side, c.triggerCents);
    }

    function getVirtualConsensusTriggeredSides(list, cfg) {
      const c = cfg || getVirtualStrategyCfg();
      const sides = [];
      if (countVirtualConsensusTrigger(list, 'up', c) >= c.triggerMin) sides.push('up');
      if (countVirtualConsensusTrigger(list, 'down', c) >= c.triggerMin) sides.push('down');
      return sides;
    }

    function getVirtualConsensusSideWeakReason(list, side, cfg) {
      const c = cfg || getVirtualStrategyCfg();
      const atTrigger = countSideAtOrAboveCents(list, side, c.triggerCents);
      if (atTrigger < c.triggerMin) {
        return `${side.toUpperCase()} 仅 ${atTrigger} 个≥${c.triggerCents}¢，共识消失`;
      }
      const atHold = countSideAtOrAboveCents(list, side, c.holdMinCents);
      if (atHold < c.triggerMin) {
        return `${side.toUpperCase()} ≥${c.holdMinCents}¢ 仅 ${atHold} 个，共识瓦解`;
      }
      return null;
    }

    /** 共识已触发，但任一同边价低于阈值 → 本槽整局跳过 */
    function getVirtualSlotDivergenceSkipReason(list, triggerSides, cfg) {
      const c = cfg || getVirtualStrategyCfg();
      const threshold = c.divergenceBelowCents ?? 20;
      const reasons = [];
      for (const side of triggerSides) {
        let hit = null;
        for (const ev of list) {
          const cents = virtualPriceCents(virtualSidePrice(ev, side));
          if (cents != null && cents < threshold) {
            hit = { title: (ev.title || ev.slug || '市场').slice(0, 28), cents };
            break;
          }
        }
        if (hit) {
          reasons.push(
            `${side.toUpperCase()} 已≥${c.triggerMin}个≥${c.triggerCents}¢，但「${hit.title}」${side.toUpperCase()}=${hit.cents}¢<${threshold}¢，本槽不投`,
          );
        }
      }
      return reasons.length ? reasons.join('；') : null;
    }

    function analyzeVirtualConsensus(activeList) {
      const cfg = getVirtualStrategyCfg();
      const list = activeList || activeVirtualConsensusEvents();
      const timing = checkVirtualConsensusTiming();
      if (!timing.ok) {
        return {
          triggerSide: null,
          triggerSides: [],
          activeN: list.length,
          triggerIds: new Set(),
          candidates: [],
          skipReason: timing.skipReason,
          slotRemMs: timing.remMs,
        };
      }

      const triggerSides = getVirtualConsensusTriggeredSides(list, cfg);
      const triggerSide = triggerSides.length ? triggerSides.join('+') : null;
      if (!triggerSides.length) {
        return {
          triggerSide: null,
          triggerSides: [],
          activeN: list.length,
          triggerIds: new Set(),
          candidates: [],
          skipReason:
            list.length < 2
              ? '当前槽市场不足 2 个'
              : `尚无 ≥${cfg.triggerMin} 个市场 Up/Down 达到 ${cfg.triggerCents}¢`,
          slotRemMs: timing.remMs,
        };
      }

      const divergenceSkip = getVirtualSlotDivergenceSkipReason(list, triggerSides, cfg);
      if (divergenceSkip) {
        return {
          triggerSide,
          triggerSides,
          activeN: list.length,
          triggerIds: new Set(),
          candidates: [],
          skipReason: divergenceSkip,
          slotRemMs: timing.remMs,
          slotDivergence: true,
        };
      }

      const triggerIds = new Set();
      const candidates = [];
      const weakened = [];
      for (const side of triggerSides) {
        const weak = getVirtualConsensusSideWeakReason(list, side, cfg);
        if (weak) {
          weakened.push(weak);
          continue;
        }
        for (const ev of list) {
          const c = virtualPriceCents(virtualSidePrice(ev, side));
          if (c != null && c >= cfg.triggerCents) triggerIds.add(`${String(ev.id)}:${side}`);
        }
        for (const ev of list) {
          const price = virtualSidePrice(ev, side);
          const c = virtualPriceCents(price);
          if (!virtualConsensusEntryOk(c, cfg)) continue;
          candidates.push({ ev, side, price, strategy: 'consensus90' });
        }
      }

      let skipReason = '';
      if (!candidates.length) {
        if (weakened.length) {
          skipReason = weakened.join('；');
        } else {
          const labels = triggerSides.map((s) => s.toUpperCase()).join('、');
          skipReason = `已触发 ${labels}，但同边价均不在 >${cfg.entryMinCents}¢ 且 <${cfg.entryMaxCents}¢`;
        }
      }
      return {
        triggerSide,
        triggerSides,
        activeN: list.length,
        triggerIds,
        candidates,
        skipReason,
        slotRemMs: timing.remMs,
        weakened,
      };
    }

    /** 虚拟投注：共识触发 + 槽末/瓦解风控（见 getVirtualStrategyCfg） */
    function collectVirtualBetCandidates() {
      return analyzeVirtualConsensus().candidates;
    }

    function toastVirtualConsensusSkip(reason, key) {
      if (!reason || !global.PMTrade?.toast) return;
      const now = Date.now();
      const k = key || reason;
      if (virtualConsensusSkipToastKey === k && now - virtualConsensusSkipToastAt < 20000) return;
      virtualConsensusSkipToastKey = k;
      virtualConsensusSkipToastAt = now;
      console.log('[virtual] 未下单:', reason);
      global.PMTrade.toast(`虚拟未下单：${reason}`, 'warn', 8000);
    }

    function sortVirtualBetCandidates(list) {
      return list.slice().sort((a, b) => {
        const pA = Number.isFinite(a?.price) ? a.price : 0;
        const pB = Number.isFinite(b?.price) ? b.price : 0;
        if (pA !== pB) return pB - pA;
        return String(a?.ev?.id ?? '').localeCompare(String(b?.ev?.id ?? ''));
      });
    }

    async function appendVirtualBetLog(text) {
      if (!global.location?.protocol?.startsWith('http')) return;
      try {
        await fetch(`/api/crypto-slot-log/${intervalKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, kind: 'virtual' }),
        });
      } catch (e) {
        console.warn('[virtual log]', e);
      }
    }

    function settleVirtualBetsForSlot(endingEvents, slotTs) {
      if (!virtualBet) return;
      const state = loadVirtualState();
      const pending = (state.openBets || []).filter((b) => b.slotTs === slotTs && !b.settled);
      if (!pending.length) return;

      const lines = [
        '',
        '--- 虚拟投注结算 ---',
        `槽 ${formatSlotResultTime(slotTs)} · slot=${slotTs}`,
        '结算：槽结束盘口价高者为胜方；赢=份数×$1−扣款，输=扣款归零（扣款=成本+手续费）',
      ];
      let slotProfit = 0;

      for (const bet of pending) {
        const ev = endingEvents.find((e) => String(e.id) === String(bet.evId));
        const closeUp = ev?.upPrice;
        const closeDown = ev?.downPrice;
        const winner = inferSlotWinner(closeUp, closeDown);
        bet.settled = true;
        bet.closeUp = closeUp;
        bet.closeDown = closeDown;
        bet.winner = winner;
        bet.settledAt = Date.now();

        const debit = bet.totalDebit ?? bet.cost;
        if (winner === '平' || winner === '—') {
          state.bankroll += debit;
          bet.profit = 0;
          bet.payout = debit;
          bet.result = '退本';
        } else if (bet.side === winner.toLowerCase()) {
          const payout = bet.shares;
          state.bankroll += payout;
          bet.payout = payout;
          bet.profit = payout - debit;
          bet.result = '赢';
        } else {
          bet.payout = 0;
          bet.profit = -debit;
          bet.result = '输';
        }
        slotProfit += bet.profit;
        const upC = closeUp != null ? Math.round(closeUp * 100) + '¢' : '—';
        const downC = closeDown != null ? Math.round(closeDown * 100) + '¢' : '—';
        lines.push(
          `${bet.result}\t${bet.title}\t买 ${bet.side.toUpperCase()} @ ${Math.round(bet.entryPrice * 100)}¢\t` +
            `份 ${(Number(bet.shares) || 0).toFixed(4)}\t成本 $${(Number(bet.cost) || 0).toFixed(2)}+费 $${(Number(bet.feeUsdc) || 0).toFixed(5)}\t` +
            `兑付 $${(bet.payout || 0).toFixed(4)}\t盈亏 ${bet.profit >= 0 ? '+' : ''}$${bet.profit.toFixed(4)}\t` +
            `收盘 Up ${upC} Down ${downC} → ${winner}`,
        );
      }

      moveVirtualBetsToHistory(state, pending);
      lines.push(`本槽虚拟盈亏合计: ${slotProfit >= 0 ? '+' : ''}$${slotProfit.toFixed(2)} · 余额 $${state.bankroll.toFixed(2)}`);
      saveVirtualState(state);
      syncVirtualBetUi();
      void appendVirtualBetLog(lines.join('\n'));
      if (pending.length) {
        const w = pending.filter((b) => b.result === '赢').length;
        const l = pending.filter((b) => b.result === '输').length;
        global.PMTrade?.toast?.(
          `虚拟结算 ${pending.length} 笔 · 赢${w} 输${l} · 本槽 ${slotProfit >= 0 ? '+' : ''}$${slotProfit.toFixed(2)} · 余额 $${state.bankroll.toFixed(2)}`,
          slotProfit >= 0 ? 'success' : 'warn',
          9000,
        );
      }
    }

    function tryVirtualBetOnTimer() {
      if (!virtualBet || virtualBetBusy || loading) return;
      const now = Date.now();
      if (now - lastVirtualTimerCheckAt < 2000) return;
      lastVirtualTimerCheckAt = now;
      if (!isVirtualBetEnabled()) {
        toastVirtualConsensusSkip(
          '虚拟投注未开启，请点击右上角「虚拟投注：开」',
          `off-${getCurrentSlotTs()}`,
        );
        return;
      }
      const analysis = analyzeVirtualConsensus();
      if (!analysis.triggerSides?.length) return;
      if (!analysis.candidates.length) {
        if (analysis.skipReason) {
          toastVirtualConsensusSkip(analysis.skipReason, `skip-${getCurrentSlotTs()}-${analysis.skipReason}`);
        }
        return;
      }
      void runVirtualBet90(false);
    }

    async function executeVirtualBetPlacements(candidates, options) {
      const {
        skipReason = null,
        triggerLabel = '',
        validatePick = () => true,
        logTag = '虚拟',
        toastStrategyLabel = '',
        skipPriceMsg = '价格不在入场区间',
      } = options || {};

      const sorted = sortVirtualBetCandidates(candidates);
      if (!sorted.length) {
        if (skipReason) {
          toastVirtualConsensusSkip(
            skipReason,
            `empty-${getCurrentSlotTs()}-${triggerLabel || 'none'}`,
          );
        }
        return;
      }

      const slot = getCurrentSlotTs();
      const amount = getVirtualOrderUsdc();
      const state = loadVirtualState();
      const usedKeys = virtualBetUsedKeysForSlot(slot, state);

      virtualBetBusy = true;
      let placed = 0;
      let skippedPlaced = 0;
      let skippedEst = 0;
      let skippedPrice = 0;
      try {
        for (const pick of sorted) {
          const evKey = String(pick.ev.id);
          const placeKey = virtualBetPlacementKey(slot, evKey, pick.side);
          if (usedKeys.has(placeKey)) {
            skippedPlaced++;
            continue;
          }

          const entryPrice = pick.price;
          if (entryPrice == null || Number.isNaN(entryPrice)) {
            skippedPrice++;
            continue;
          }
          const entryCentsCheck = virtualPriceCents(entryPrice);
          if (!validatePick(pick, entryCentsCheck)) {
            skippedPrice++;
            continue;
          }
          const entryCents = entryCentsCheck;
          const worstPrice = Math.min(0.99, Math.max(0.01, entryPrice * 1.02));
          const label = (pick.ev.title || '').slice(0, 48);

          let est = estimateVirtualBetSync(amount, entryPrice);
          if (!est) {
            skippedEst++;
            console.warn('[virtual] 估单失败', label, pick.side, entryCents, '¢');
            continue;
          }

          const live = loadVirtualState();
          if (live.bankroll + 1e-9 < est.totalDebit) {
            global.PMTrade?.toast?.(
              `虚拟余额不足（需 $${est.totalDebit.toFixed(4)}，当前 $${live.bankroll.toFixed(2)}）`,
              'warn',
            );
            break;
          }

          live.bankroll -= est.totalDebit;
          live.openBets = live.openBets || [];
          const betId = `vb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const placedAt = Date.now();
          const slotPlace = snapshotVirtualPlacedSlotTime(slot, placedAt);
          live.openBets.push({
            id: betId,
            slotTs: slot,
            evId: evKey,
            title: label,
            side: pick.side,
            entryPrice: est.marketPrice ?? entryPrice,
            worstPrice: est.worstPrice ?? worstPrice,
            cost: est.costUsdc,
            feeUsdc: est.feeUsdc,
            totalDebit: est.totalDebit,
            shares: est.shares,
            minShares: est.minShares,
            meetsMinSize: est.meetsMinSize,
            placedAt,
            placedSlotCountdown: slotPlace.placedSlotCountdown,
            placedSlotRemSec: slotPlace.placedSlotRemSec,
            settled: false,
            strategy: pick.strategy || 'consensus90',
          });
          live.lastBetSlot = slot;
          saveVirtualState(live);
          virtualMarkovPlacedKeys.add(placeKey);
          usedKeys.add(placeKey);
          placed++;

          const crossNote =
            pick.crossFrom != null && pick.crossTo != null
              ? `（${pick.crossFrom}→${pick.crossTo}¢）`
              : '';
          const estLineForLog =
            global.PMTrade?.formatBuyEstimateLine?.(est) ||
            `份 ${est.shares.toFixed(4)} · 扣款 $${est.totalDebit.toFixed(4)}`;
          const logLines = [
            `[开仓·${logTag}] ${new Date().toLocaleString('zh-CN', { hour12: false })} · 槽 ${slot}`,
            `  ${label} · 买 ${pick.side.toUpperCase()} @ ${entryCents}¢${crossNote} · ${estLineForLog}`,
          ];
          void appendVirtualBetLog(logLines.join('\n'));

          const estLine = global.PMTrade?.formatBuyEstimateLine
            ? global.PMTrade.formatBuyEstimateLine(est)
            : `份 ${est.shares.toFixed(4)} · 扣款 $${est.totalDebit.toFixed(4)}`;
          const stratLabel = toastStrategyLabel ? `（${toastStrategyLabel}）` : '';
          const buyMsg = `虚拟买入 ${pick.side.toUpperCase()} @ ${entryCents}¢${stratLabel}\n${estLine}\n余额 $${live.bankroll.toFixed(2)}`;
          if (global.PMTrade?.toastTrade) {
            global.PMTrade.toastTrade(buyMsg, '买入', 9000);
          } else {
            global.PMTrade?.toast?.(buyMsg, 'buy', 9000);
          }
        }
        if (placed) syncVirtualBetUi();
        else if (sorted.length) {
          const parts = [];
          if (skippedPlaced) parts.push(`${skippedPlaced} 个本槽已下过`);
          if (skippedPrice) parts.push(`${skippedPrice} 个${skipPriceMsg}`);
          if (skippedEst) parts.push(`${skippedEst} 个估单失败`);
          if (parts.length) {
            toastVirtualConsensusSkip(
              `${triggerLabel ? triggerLabel + ' ' : ''}有 ${sorted.length} 个候选，但均未成交（${parts.join('；')}）`,
              `fail-${slot}-${parts.join('|')}`,
            );
          }
        }
      } catch (e) {
        console.error('[virtual bet]', e);
        global.PMTrade?.toast?.('虚拟投注失败：' + (e.message || e), 'error');
      } finally {
        virtualBetBusy = false;
      }
    }

    let virtualAiCacheSlot = null;
    let virtualAiCacheResult = null;

    async function maybeAiGateVirtualBet(analysis) {
      if (intervalKey !== '5M') return true;
      const ai = global.PMAiAssist;
      if (!ai?.isEnabled?.()) return true;
      if (!analysis?.candidates?.length) return true;

      const slot = getCurrentSlotTs();
      if (virtualAiCacheSlot === slot && virtualAiCacheResult) {
        return applyVirtualAiResult(virtualAiCacheResult);
      }

      global.PMAiAssist?.setStatus?.('分析中…', '#2563eb');
      try {
        const list = activeVirtualConsensusEvents();
        const result = await ai.analyzeVirtualBet(analysis, {
          context: buildVirtualAiContext(analysis),
        });
        virtualAiCacheSlot = slot;
        virtualAiCacheResult = result;
        return applyVirtualAiResult(result);
      } catch (e) {
        console.warn('[virtual ai]', e);
        global.PMTrade?.toast?.('AI 分析失败：' + (e.message || e), 'error', 10000);
        global.PMAiAssist?.syncStatusEl?.();
        return !ai.isGateMode?.();
      }
    }

    function applyVirtualAiResult(result) {
      const gate = global.PMAiAssist?.isGateMode?.() !== false;
      const statusEl = document.getElementById('crypto5mAiStatus');
      if (statusEl && result?.reason) {
        const label = result.decision === 'bet' ? '建议投注' : '建议不投';
        statusEl.textContent = `${label}：${result.reason}`;
        statusEl.style.color = result.decision === 'bet' ? '#059669' : '#d97706';
      }
      if (result?.decision === 'skip') {
        if (gate) {
          toastVirtualConsensusSkip(
            `AI 建议不投：${global.PMAiAssist?.formatDecisionToast?.(result) || result.reason}`,
            `ai-skip-${getCurrentSlotTs()}`,
          );
          return false;
        }
        global.PMTrade?.toast?.(`AI 提示不投（仍将下单）：${result.reason}`, 'warn', 9000);
        return true;
      }
      global.PMTrade?.toast?.(`AI 建议投注：${global.PMAiAssist?.formatDecisionToast?.(result) || result.reason || '通过'}`, 'info', 9000);
      return true;
    }

    async function runVirtualBet90(_isLateBuy = false) {
      if (!virtualBet || !isVirtualBetEnabled()) return;
      if (virtualBetBusy || loading) return;
      const analysis = analyzeVirtualConsensus();
      if (analysis.candidates.length) {
        const ok = await maybeAiGateVirtualBet(analysis);
        if (!ok) return;
      }
      await executeVirtualBetPlacements(analysis.candidates, {
        skipReason: analysis.skipReason,
        triggerLabel: analysis.triggerSide || 'consensus',
        validatePick: (_pick, cents) => virtualConsensusEntryOk(cents, getVirtualStrategyCfg()),
        logTag: '共识90',
        toastStrategyLabel: '共识90',
        skipPriceMsg: '盘口价不在 >70¢ 且 <98¢',
      });
    }

    async function runAutoBuy90(isLateBuy = false) {
      if (!autoBuy90 || !isAuto90Enabled()) return;
      if (auto90Busy || bookBusy || loading) return;
      if (!global.PMTrade?.isReady?.()) return;
      if (isLateBuy) {
        if (!getBuyTimingConfig().lateBuyEnabled || !isLateBuyWindow()) return;
      } else if (!canRunEarlyAutoBuy()) {
        return;
      }

      const slot = getCurrentSlotTs();
      // 结束前二单：允许本槽再下一笔
      if (!isLateBuy && autoBuy90.oncePerSlot && auto90LastSuccessSlot === slot) return;

      const amount = autoBuy90.amountUsd ?? getEffectiveOrderUsdc();
      const candidates = collectAuto90Candidates(autoBuy90);
      if (!candidates.length) return;

      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      const evKey = String(pick.ev.id);
      const label = (pick.ev.title || '').slice(0, 48);
      const cents = Math.round(pick.price * 100);

      const est = await global.PMTrade?.estimateBuyForSide?.(evKey, pick.side, amount, pick.price);
      if (est && !est.meetsMinSize) {
        global.PMTrade?.toast?.(
          `自动下单 $${amount} · ${label} · ${pick.side.toUpperCase()} ${cents}¢\n${global.PMTrade.formatBuyEstimateLine(est)}\n仍将尝试提交（CLOB 可能拒单）`,
          'warn',
          10000,
        );
      }

      auto90Busy = true;
      try {
        await global.PMTrade.placeOrderBySide(evKey, pick.side);
        if (!isLateBuy && autoBuy90.oncePerSlot) auto90LastSuccessSlot = slot;
        const tid = tokenIdForAutoSide(evKey, pick.side);
        if (tid) global.PMAuto?.registerCrypto5mBought?.(tid, label, evKey);
      } catch (_) {
        /* placeOrderBySide 已 toast */
      } finally {
        auto90Busy = false;
      }
    }

    function isCurrentlyActive(ev) {
      if (!isCurrentSlotEvent(ev)) return false;
      if (ev.closed === true || ev.active === false) return false;
      const now = Date.now();
      if (ev.endDate && new Date(ev.endDate).getTime() <= now) return false;
      const tradeStart = ev.eventStartTime || ev.startTime;
      const startMs = tradeStart
        ? new Date(tradeStart).getTime()
        : ev.startDate
          ? new Date(ev.startDate).getTime()
          : 0;
      if (startMs && startMs > now) return false;
      const markets = ev.markets || [];
      if (!markets.length) return false;
      return markets.some(
        (m) => m.closed !== true && m.active !== false && m.acceptingOrders !== false,
      );
    }

    function normalizeCryptoPageEvent(raw) {
      const markets = (raw.markets || []).map((m) => ({
        id: m.id,
        slug: m.slug,
        question: m.question || m.groupItemTitle || '',
        volume: parseFloat(m.volume || m.volumeNum || 0),
        outcomes: parseJsonField(m.outcomes, ['Up', 'Down']),
        prices: parseJsonField(m.outcomePrices, []).map((p) => parseFloat(p) || 0),
        clobTokenIds: parseJsonField(m.clobTokenIds, []),
        conditionId: m.conditionId || null,
        negRisk: !!m.negRisk,
        active: m.active,
        closed: m.closed,
        acceptingOrders: m.acceptingOrders,
      }));
      const tags = (raw.tags || [])
        .map((t) => (typeof t === 'string' ? t : t.label || t.slug || ''))
        .filter(Boolean);
      const primary = pickPrimaryMarket(markets);
      const norm = {
        id: raw.id,
        slug: raw.slug,
        title: (raw.title || '').trim(),
        description: raw.description || '',
        image: raw.image || raw.icon || '',
        startDate: raw.startDate,
        endDate: raw.endDate,
        active: raw.active,
        closed: raw.closed,
        volume: parseFloat(raw.volume || 0),
        volume24hr: parseFloat(raw.volume24hr || 0),
        openInterest: parseFloat(raw.openInterest || 0),
        liquidity: parseFloat(raw.liquidity || 0),
        tags,
        category: 'crypto',
        cryptoInterval: intervalNum,
        cryptoPage: intervalKey,
        leadProb: getLeadProb(primary),
        markets,
        primaryMarket: primary,
        url: 'https://polymarket.com/event/' + (raw.slug || ''),
        eventStartTime: raw.eventStartTime || raw.startTime || null,
        startTime: raw.startTime || raw.eventStartTime || null,
        upPrice: null,
        downPrice: null,
        upDepth: null,
        downDepth: null,
        priceFromBook: false,
        gammaPriceToBeat: null,
        targetPrice: null,
        currentPrice: null,
        priceDiff: null,
        priceDiffPct: null,
        targetSource: null,
        currentSource: null,
        chainlinkSymbol: null,
      };
      const meta = raw.eventMetadata || {};
      const gammaPtb = meta.priceToBeat != null ? +meta.priceToBeat : null;
      if (Number.isFinite(gammaPtb) && gammaPtb > 0) {
        norm.gammaPriceToBeat = gammaPtb;
        norm.targetPrice = gammaPtb;
        norm.targetSource = 'gamma:eventMetadata';
        const coin = coinFromEventSlug(norm.slug);
        norm.chainlinkSymbol = coin ? ({ btc: 'btc/usd', eth: 'eth/usd', sol: 'sol/usd', xrp: 'xrp/usd', doge: 'doge/usd', hype: 'hype/usd', bnb: 'bnb/usd' }[coin] || null) : null;
      }
      syncEventUpDown(norm);
      return norm;
    }

    async function fetchEventBySlug(slug) {
      const urls = [];
      if (global.location?.protocol?.startsWith('http')) {
        urls.push('/api/event-slug/' + encodeURIComponent(slug));
      }
      urls.push('https://gamma-api.polymarket.com/events?slug=' + encodeURIComponent(slug));
      urls.push('https://gamma-api.polymarket.com/events/slug/' + encodeURIComponent(slug));
      for (const url of urls) {
        try {
          const resp = await fetch(url);
          if (resp.status === 404) return null;
          if (!resp.ok) continue;
          const json = await resp.json();
          if (Array.isArray(json) && json.length && json[0]?.id) return json[0];
          if (json?.event) return json.event;
          if (json?.id) return json;
        } catch (_) {}
      }
      return null;
    }

    async function loadCryptoPageFallback() {
      const currentTs = getCurrentSlotTs();
      const found = [];
      for (const coin of CRYPTO_PAGE_COINS) {
        const slug = `${coin}-updown-${slugMin}-${currentTs}`;
        try {
          const raw = await fetchEventBySlug(slug);
          if (!raw) continue;
          const norm = normalizeCryptoPageEvent(raw);
          if (isCurrentlyActive(norm)) found.push(norm);
        } catch (_) {}
      }
      return found;
    }

    async function fetchCryptoPage() {
      if (global.location?.protocol?.startsWith('http')) {
        try {
          const resp = await fetch('/api/crypto-page/' + intervalKey);
          const json = await resp.json();
          if (resp.ok && json.success && Array.isArray(json.events)) {
            return json.events.map(normalizeCryptoPageEvent).filter(isCurrentlyActive);
          }
        } catch (e) {
          console.warn('[' + intervalKey + ' API]', e.message);
        }
      }
      return loadCryptoPageFallback();
    }

    function getFilterState() {
      const probMin = $('probMin')?.value.trim() ?? '';
      const probMax = $('probMax')?.value.trim() ?? '';
      return {
        endHours: filterEndHours,
        probMin: probMin === '' ? null : parseFloat(probMin),
        probMax: probMax === '' ? null : parseFloat(probMax),
        volType: $('volType')?.value || 'total',
        minVol: parseFloat($('minVol')?.value) || 0,
        search: ($('searchInput')?.value || '').trim().toLowerCase(),
        category,
      };
    }

    function passesFilters(ev, f) {
      if (!isCurrentlyActive(ev)) return false;
      if (f.search) {
        const q = f.search;
        const hit =
          (ev.title || '').toLowerCase().includes(q) ||
          ev.tags.some((t) => t.toLowerCase().includes(q)) ||
          ev.markets.some((m) => (m.question || '').toLowerCase().includes(q));
        if (!hit) return false;
      }
      if (f.endHours > 0 && ev.endDate) {
        const maxEnd = Date.now() + f.endHours * 3600000;
        if (new Date(ev.endDate).getTime() > maxEnd) return false;
      }
      if (f.probMin != null || f.probMax != null) {
        const p = ev.leadProb;
        if (p == null) return false;
        if (f.probMin != null && p < f.probMin) return false;
        if (f.probMax != null && p > f.probMax) return false;
      }
      if (f.minVol > 0) {
        const vol = f.volType === '24h' ? ev.volume24hr : ev.volume;
        if (vol < f.minVol) return false;
      }
      return true;
    }

    function getLeadOutcomeIndex(market) {
      if (!market?.prices?.length) return { idx: 0, prob: 0 };
      let bestIdx = 0;
      let bestP = -1;
      market.prices.forEach((raw, i) => {
        const p = parseFloat(raw);
        if (!isNaN(p) && p > bestP) {
          bestP = p;
          bestIdx = i;
        }
      });
      return { idx: bestIdx, prob: bestP >= 0 ? bestP : 0 };
    }

    function getUpDownIndices(outcomes) {
      let upIdx = -1;
      let downIdx = -1;
      (outcomes || []).forEach((o, i) => {
        const label = String(o).toLowerCase();
        if (label === 'up') upIdx = i;
        if (label === 'down') downIdx = i;
      });
      if (upIdx < 0 && downIdx < 0 && (outcomes || []).length === 2) {
        upIdx = 0;
        downIdx = 1;
      }
      return { upIdx, downIdx };
    }

    function getPrimaryMarket(ev) {
      return ev.primaryMarket || (ev.markets && ev.markets[0]) || null;
    }

    function summarizeBookDepth(book, depthLevels = 5) {
      const clob = global.PMClob;
      if (!book || !clob?.parseBookLevels) return null;
      const bids = clob.parseBookLevels(book, 'SELL');
      const asks = clob.parseBookLevels(book, 'BUY');
      const sliceSum = (arr, n, usd) =>
        arr.slice(0, n).reduce((s, l) => s + (usd ? l.p * l.s : l.s), 0);
      return {
        bestBid: bids[0] || null,
        bestAsk: asks[0] || null,
        bidDepthShares: sliceSum(bids, depthLevels, false),
        askDepthShares: sliceSum(asks, depthLevels, false),
        bidDepthUsd: sliceSum(bids, depthLevels, true),
        askDepthUsd: sliceSum(asks, depthLevels, true),
        bidLevels: bids.slice(0, depthLevels),
        askLevels: asks.slice(0, depthLevels),
      };
    }

    function formatDepthSize(shares) {
      const n = +shares || 0;
      if (n <= 0) return '—';
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
      return n.toFixed(0);
    }

    function formatDepthUsd(usd) {
      const n = +usd || 0;
      if (n <= 0) return '—';
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
      return n.toFixed(0);
    }

    function syncEventUpDown(ev) {
      const m = getPrimaryMarket(ev);
      if (!m) {
        ev.upPrice = null;
        ev.downPrice = null;
        ev.upDepth = null;
        ev.downDepth = null;
        return;
      }
      const { upIdx, downIdx } = getUpDownIndices(m.outcomes);
      ev.upPrice = upIdx >= 0 ? m.prices[upIdx] : null;
      ev.downPrice = downIdx >= 0 ? m.prices[downIdx] : null;
      ev.upDepth = m.bookDepth?.up || null;
      ev.downDepth = m.bookDepth?.down || null;
      ev.priceFromBook = !!m.priceFromBook;
      ev.leadProb = getLeadProb(m);
    }

    function getSlotEndMs(ev) {
      if (ev?.endDate) {
        const t = new Date(ev.endDate).getTime();
        if (!Number.isNaN(t)) return t;
      }
      const tradeStart = ev?.eventStartTime || ev?.startTime;
      if (tradeStart) {
        const t = new Date(tradeStart).getTime();
        if (!Number.isNaN(t)) return t + slotSec * 1000;
      }
      const slug = (ev?.slug || '').toLowerCase();
      const re = new RegExp('-updown-' + slugMin + '-(\\d+)');
      const m = slug.match(re);
      if (m) return parseInt(m[1], 10) * 1000 + slotSec * 1000;
      const slotStart = Math.floor(Date.now() / 1000 / slotSec) * slotSec;
      return slotStart * 1000 + slotSec * 1000;
    }

    function formatCountdown(ms) {
      const sec = Math.max(0, Math.floor(ms / 1000));
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    function getSlotEndMsFromCountdown() {
      const el = $('slotCountdown');
      if (el?.dataset?.end) {
        const v = parseInt(el.dataset.end, 10);
        if (Number.isFinite(v) && v > 0) return v;
      }
      const ev = (filtered && filtered[0]) || (events && events[0]);
      if (ev) return getSlotEndMs(ev);
      return null;
    }

    function checkLateBuyTrigger() {
      const timing = getBuyTimingConfig();
      if (!timing.lateBuyEnabled || !isLateBuyWindow()) return;

      const slot = getCurrentSlotTs();

      if (autoBuy90 && isAuto90Enabled() && auto90Close40Slot !== slot) {
        auto90Close40Slot = slot;
        void runAutoBuy90(true);
      }
      if (virtualBet && isVirtualBetEnabled() && virtualClose40Slot !== slot) {
        virtualClose40Slot = slot;
        void runVirtualBet90(true);
      }
    }

    function updateCountdowns() {
      const now = Date.now();
      let slotEnded = false;
      document.querySelectorAll('.crypto-countdown[data-end]').forEach((el) => {
        const raw = el.dataset.end;
        if (raw === '' || raw === undefined) return;
        const end = parseInt(raw, 10);
        if (!Number.isFinite(end)) return;
        const rem = end - now;
        el.textContent = formatCountdown(rem);
        const urgent = rem > 0 && rem <= urgentMs;
        el.classList.toggle('urgent', urgent);
        maybeNotifySlotEnding(rem, end);
        if (rem <= 0) {
          el.classList.add('urgent');
          slotEnded = true;
        }
      });
      if (slotEnded) {
        refreshMarkovSnapshot();
        triggerSlotEndRefresh();
      }
      else {
        checkLateBuyTrigger();
        if (virtualBet && isVirtualBetEnabled()) {
          checkVirtualTpSl();
          tryVirtualBetOnTimer();
        }
      }
    }

    function maybeNotifySlotEnding(remMs, endMs) {
      if (intervalKey !== '5M') return;
      if (!(remMs > 0 && remMs <= urgentMs)) return;
      const endingSlotTs = Math.floor(endMs / 1000) - slotSec;
      if (!Number.isFinite(endingSlotTs) || endingSlotTs <= 0) return;
      if (notifiedEndingSlotTs === endingSlotTs) return;
      notifiedEndingSlotTs = endingSlotTs;
      if (typeof Notification === 'undefined') return;
      const remainSec = Math.max(1, Math.ceil(remMs / 1000));
      const title = 'Polymarket 5分钟提醒';
      const body = `当前时间槽将在 ${remainSec} 秒后结束`;
      const showNotice = () => {
        try {
          new Notification(title, {
            body,
            tag: `pm-5m-slot-${endingSlotTs}`,
            renotify: false,
          });
        } catch (_) {}
      };
      if (Notification.permission === 'granted') {
        showNotice();
        return;
      }
      if (Notification.permission === 'default' && !notificationPermissionAsked) {
        notificationPermissionAsked = true;
        Notification.requestPermission()
          .then((perm) => {
            if (perm === 'granted') showNotice();
          })
          .catch(() => {});
      }
    }

    function syncPanelSlotCountdown() {
      if (!panelSlotCountdown) return;
      const el = $('slotCountdown');
      if (!el) return;
      const ev = (filtered && filtered[0]) || (events && events[0]);
      const endMs = ev
        ? getSlotEndMs(ev)
        : Math.floor(Date.now() / 1000 / slotSec) * slotSec * 1000 + slotSec * 1000;
      el.dataset.end = String(endMs);
      el.textContent = formatCountdown(endMs - Date.now());
    }

    function triggerSlotEndRefresh() {
      if (slotEndRefreshPending || loading) return;
      slotEndRefreshPending = true;
      logEndingSlotResults(slotTs);
      const ts = Math.floor(Date.now() / 1000 / slotSec) * slotSec;
      if (ts !== slotTs) slotTs = ts;
      setStatus('busy', `${intervalKey} 时间槽结束，正在加载新市场…`);
      loadAll(true);
    }

    function checkSlotRollover() {
      const ts = Math.floor(Date.now() / 1000 / slotSec) * slotSec;
      if (ts === slotTs) return;
      const endingSlot = slotTs;
      refreshMarkovSnapshot();
      logEndingSlotResults(endingSlot);
      clearVirtualMarkovPlacedKeys();
      slotTs = ts;
      if (loading) return;
      slotEndRefreshPending = true;
      loadAll(true);
    }

    async function applyBookPricesToMarket(m) {
      const clob = global.PMClob;
      if (!clob?.fetchBook || !m?.clobTokenIds?.length) return false;
      const { upIdx, downIdx } = getUpDownIndices(m.outcomes);
      while (m.prices.length < (m.outcomes?.length || 0)) m.prices.push(0);

      if (upIdx >= 0 && downIdx >= 0) {
        const upToken = m.clobTokenIds[upIdx];
        const downToken = m.clobTokenIds[downIdx];
        if (!upToken || !downToken) return false;
        const [upBook, downBook] = await Promise.all([
          clob.fetchBook(upToken),
          clob.fetchBook(downToken),
        ]);
        m.bookDepth = {
          up: summarizeBookDepth(upBook),
          down: summarizeBookDepth(downBook),
        };
        const upMid = clob.midPriceFromBook(upBook);
        const downMid = clob.midPriceFromBook(downBook);
        let ok = false;
        if (upMid != null && upMid > 0 && upMid < 1) {
          m.prices[upIdx] = upMid;
          ok = true;
        }
        if (downMid != null && downMid > 0 && downMid < 1) {
          m.prices[downIdx] = downMid;
          ok = true;
        }
        if (ok && m.outcomes.length === 2) {
          if (upMid != null && upMid > 0 && upMid < 1 && (downMid == null || downMid <= 0 || downMid >= 1)) {
            m.prices[downIdx] = Math.max(0, Math.min(1, 1 - upMid));
          } else if (downMid != null && downMid > 0 && downMid < 1 && (upMid == null || upMid <= 0 || upMid >= 1)) {
            m.prices[upIdx] = Math.max(0, Math.min(1, 1 - downMid));
          }
        }
        m.priceFromBook = ok;
        return ok;
      }

      const { idx } = getLeadOutcomeIndex(m);
      const tokenId = m.clobTokenIds[idx];
      if (!tokenId) return false;
      const book = await clob.fetchBook(tokenId);
      const depth = summarizeBookDepth(book);
      if (!m.bookDepth) m.bookDepth = { up: null, down: null };
      const { upIdx: uI, downIdx: dI } = getUpDownIndices(m.outcomes);
      if (idx === uI) m.bookDepth.up = depth;
      else if (idx === dI) m.bookDepth.down = depth;
      const mid = clob.midPriceFromBook(book);
      if (mid == null || mid <= 0 || mid >= 1) return false;
      m.prices[idx] = mid;
      if (m.outcomes.length === 2) {
        const other = idx === 0 ? 1 : 0;
        m.prices[other] = Math.max(0, Math.min(1, 1 - mid));
      }
      m.priceFromBook = true;
      return true;
    }

    async function applyBookPricesToEvent(ev) {
      let ok = false;
      for (const m of ev.markets || []) {
        if (await applyBookPricesToMarket(m)) ok = true;
      }
      ev.primaryMarket = pickPrimaryMarket(ev.markets);
      syncEventUpDown(ev);
      return ok;
    }

    function orderButtonHtml(evKey, tradeSide) {
      if (hideOrderButtons) return '';
      const amt = global.pmOrderProfile?.fixedUsdc ?? global.PMTrade?.getOrderAmount?.() ?? 1;
      return `<button type="button" class="btn btn-crypto-sm ${tradeSide}" title="CLOB 市价买入 FOK，固定 $${amt}" onclick="PMTrade.placeOrderBySide('${esc(evKey)}','${tradeSide}')">$${amt}</button>`;
    }

    function patchUpDownCellContent(cell, price, depth, side, fromBook, evKey) {
      if (!cell) return;
      const tradeSide = side === 'up' ? 'up' : 'down';
      cell.innerHTML =
        sidePriceHtml(price, side, fromBook) +
        depthBlockHtml(depth, fromBook) +
        orderButtonHtml(evKey, tradeSide);
      cell.classList.add('price-tick');
      clearTimeout(cell._priceTickTimer);
      cell._priceTickTimer = setTimeout(() => cell.classList.remove('price-tick'), 400);
    }

    function mergeEventStatsFrom(freshList) {
      if (!Array.isArray(freshList) || !freshList.length) return 0;
      const byId = new Map(freshList.map((e) => [String(e.id), e]));
      const bySlug = new Map(freshList.map((e) => [String(e.slug || '').toLowerCase(), e]));
      let n = 0;
      for (const ev of events) {
        const src =
          byId.get(String(ev.id)) || bySlug.get(String(ev.slug || '').toLowerCase());
        if (!src) continue;
        ev.volume = parseFloat(src.volume || 0);
        ev.volume24hr = parseFloat(src.volume24hr || 0);
        ev.openInterest = parseFloat(src.openInterest || 0);
        ev.liquidity = parseFloat(src.liquidity || 0);
        const srcMeta = src.eventMetadata || {};
        const srcPtb = srcMeta.priceToBeat != null ? +srcMeta.priceToBeat : null;
        if (Number.isFinite(srcPtb) && srcPtb > 0) {
          ev.gammaPriceToBeat = srcPtb;
        }
        if (Array.isArray(src.markets) && Array.isArray(ev.markets)) {
          const mById = new Map(src.markets.map((m) => [String(m.id), m]));
          ev.markets.forEach((m) => {
            const sm = mById.get(String(m.id));
            if (!sm) return;
            m.volume = parseFloat(sm.volume || 0);
          });
        }
        ev.primaryMarket = pickPrimaryMarket(ev.markets);
        n++;
      }
      return n;
    }

    function flashStatCell(el) {
      if (!el) return;
      el.classList.add('stat-tick');
      clearTimeout(el._statTickTimer);
      el._statTickTimer = setTimeout(() => el.classList.remove('stat-tick'), 400);
    }

    function patchEventVolOiInDom(ev) {
      const row = document.querySelector(`tr[data-ev-id="${cssEscape(String(ev.id))}"]`);
      if (!row) return false;
      const volEl = row.querySelector('[data-stat="volume"]');
      const oiEl = row.querySelector('[data-stat="open-interest"]');
      if (volEl) {
        volEl.textContent = formatMoney(ev.volume);
        flashStatCell(volEl);
      }
      if (oiEl) {
        oiEl.textContent = formatMoney(ev.openInterest);
        flashStatCell(oiEl);
      }
      return !!(volEl || oiEl);
    }

    async function refreshEventStats() {
      if (!asyncStatsRefresh || hideVolumeOiColumns || !events.length) return false;
      try {
        const fresh = await fetchCryptoPage();
        if (!fresh.length) return false;
        return mergeEventStatsFrom(fresh) > 0;
      } catch (e) {
        console.warn('[' + intervalKey + ' stats]', e);
        return false;
      }
    }

    function patchEventPricesInDom(ev) {
      const evKey = String(ev.id);
      const row = document.querySelector(`tr[data-ev-id="${cssEscape(evKey)}"]`);
      if (!row) return false;
      const fromBook = !!ev.priceFromBook;
      patchUpDownCellContent(
        row.querySelector('.updown-cell[data-updown="up"]'),
        ev.upPrice,
        ev.upDepth,
        'up',
        fromBook,
        evKey,
      );
      patchUpDownCellContent(
        row.querySelector('.updown-cell[data-updown="down"]'),
        ev.downPrice,
        ev.downDepth,
        'down',
        fromBook,
        evKey,
      );
      patchMarkovCellInDom(ev);
      return true;
    }

    async function refreshOrderbooks(silent = true) {
      if (!global.PMClob || bookBusy) return;
      bookBusy = true;
      try {
        const bookTask = asyncBookRefresh
          ? Promise.all(
              events.map(async (ev) => {
                await applyBookPricesToEvent(ev);
                patchEventPricesInDom(ev);
              }),
            )
          : Promise.all(events.map((ev) => applyBookPricesToEvent(ev)));
        const statsTask = asyncStatsRefresh ? refreshEventStats() : Promise.resolve(false);
        await Promise.all([bookTask, statsTask]);

        if (asyncBookRefresh || asyncStatsRefresh) {
          if (needsFullRenderAfterStats()) {
            applyFilterAndRender();
          } else {
            if (asyncStatsRefresh) events.forEach((ev) => patchEventVolOiInDom(ev));
            updateStats();
          }
        }
        if (silent) {
          const parts = [];
          if (asyncBookRefresh) parts.push('盘口');
          if (asyncStatsRefresh) parts.push('Vol/OI');
          const label = parts.length ? parts.join('+') : '订单簿';
          setStatus(
            'ok',
            `${label} · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`,
          );
        }
        if (!asyncBookRefresh && !asyncStatsRefresh) applyFilterAndRender();
      } catch (e) {
        console.warn('[' + intervalKey + ' orderbook]', e);
      } finally {
        bookBusy = false;
        refreshMarkovSnapshot();
        if (showMarkovColumn) events.forEach((ev) => patchMarkovCellInDom(ev));
        if (virtualBet) {
          checkVirtualTpSl();
          void runVirtualBet90();
        }
        if (autoBuy90) void runAutoBuy90();
        void refreshSpotPricesQuiet();
      }
    }

    function stopTimers() {
      if (cryptoProbTimer) {
        clearInterval(cryptoProbTimer);
        cryptoProbTimer = null;
      }
      if (cryptoCountdownTimer) {
        clearInterval(cryptoCountdownTimer);
        cryptoCountdownTimer = null;
      }
    }

    function startTimers() {
      stopTimers();
      slotTs = Math.floor(Date.now() / 1000 / slotSec) * slotSec;
      clearVirtualMarkovPlacedKeys();
      restoreVirtualPlacedKeysForSlot(slotTs);
      auto90LastSuccessSlot = null;
      refreshOrderbooks(true);
      cryptoProbTimer = setInterval(() => refreshOrderbooks(true), CRYPTO_PROB_INTERVAL_MS);
      updateCountdowns();
      cryptoCountdownTimer = setInterval(() => {
        updateCountdowns();
        checkSlotRollover();
      }, 1000);
    }

    function probBadgeHtml(pct, fromBook) {
      if (pct == null) return '<span class="prob-badge">—</span>';
      const n = Math.round(pct);
      const cls = (n >= 70 ? '' : n >= 30 ? ' mid' : ' low') + (fromBook ? ' book' : '');
      return `<span class="prob-badge${cls}" title="${fromBook ? '订单簿中间价' : ''}">${n}%</span>`;
    }

    function sidePriceHtml(price, side, fromBook) {
      if (price == null || Number.isNaN(price)) return '<span class="side-price empty">—</span>';
      const n = Math.round(price * 100);
      const cls = side === 'up' ? 'side-price up' : 'side-price down';
      const book = fromBook ? ' book' : '';
      return `<span class="${cls}${book}" title="${fromBook ? '订单簿中间价' : 'Gamma 报价'}">${n}¢</span>`;
    }

    function depthBlockHtml(depth, fromBook) {
      if (!depth || (!depth.bestBid && !depth.bestAsk)) {
        return '<span class="book-depth empty">深度 —</span>';
      }
      const parts = [];
      if (depth.bestBid) {
        parts.push(
          `<span class="depth-lvl bid" title="买一"><span class="dlab">买</span><b>${Math.round(depth.bestBid.p * 100)}¢</b><span class="dsz">${formatDepthSize(depth.bestBid.s)}</span></span>`,
        );
      }
      if (depth.bestAsk) {
        parts.push(
          `<span class="depth-lvl ask" title="卖一"><span class="dlab">卖</span><b>${Math.round(depth.bestAsk.p * 100)}¢</b><span class="dsz">${formatDepthSize(depth.bestAsk.s)}</span></span>`,
        );
      }
      const totalUsd = (depth.bidDepthUsd || 0) + (depth.askDepthUsd || 0);
      if (totalUsd > 0) {
        parts.push(
          `<span class="depth-sum" title="前5档买盘+卖盘约">5档 ${formatDepthUsd(totalUsd)}</span>`,
        );
      }
      return `<span class="book-depth${fromBook ? ' live' : ''}">${parts.join('')}</span>`;
    }

    function upDownCellHtml(price, depth, side, fromBook, evKey) {
      const sideKey = side === 'up' ? 'up' : 'down';
      return `<div class="updown-cell" data-updown="${sideKey}">
        ${sidePriceHtml(price, side, fromBook)}
        ${depthBlockHtml(depth, fromBook)}
        ${orderButtonHtml(evKey, sideKey)}
      </div>`;
    }

    function setStatus(type, text) {
      const dot = $('statusDot');
      if (dot) dot.className = 'status-dot' + (type === 'ok' ? ' ok' : type === 'busy' ? ' busy' : '');
      if ($('statusText')) $('statusText').textContent = text;
    }

    function updateStats() {
      const f = getFilterState();
      const list = events.filter((ev) => passesFilters(ev, f));
      let vol = 0;
      let oi = 0;
      let vol24 = 0;
      list.forEach((ev) => {
        vol += ev.volume;
        oi += ev.openInterest;
        vol24 += ev.volume24hr;
      });
      if ($('statCount')) $('statCount').textContent = list.length.toLocaleString();
      if ($('statVolume')) $('statVolume').textContent = formatMoney(vol);
      if ($('statOI')) $('statOI').textContent = formatMoney(oi);
      if ($('statVol24')) $('statVol24').textContent = formatMoney(vol24);
    }

    function applyFilterAndRender() {
      const f = getFilterState();
      filtered = events.filter((ev) => passesFilters(ev, f));
      updateStats();
      filtered.sort((a, b) => new Date(a.endDate) - new Date(b.endDate));
      renderTable();
    }

    function renderTable() {
      const pageSize = parseInt($('pageSizeSelect')?.value, 10) || 50;
      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      currentPage = Math.min(currentPage, totalPages - 1);
      const start = currentPage * pageSize;
      const page = filtered.slice(start, start + pageSize);

      $('resultLabel').textContent = total
        ? `显示 ${start + 1}–${Math.min(start + pageSize, total)}，共 ${total} 条（${resultUrl}）`
        : `当前 ${intervalKey} 时间槽暂无可交易市场，请稍后刷新`;

      if (total === 0) {
        const viaFile = !global.location?.protocol?.startsWith('http');
        const pageName =
          intervalKey === '5M' ? 'polymarket_crypto_5m.html' : 'polymarket_crypto_15m.html';
        const hint = viaFile
          ? `<br><br><b>请用本地服务打开：</b>双击 <code>start-markets.bat</code>，再访问 <code>http://localhost:3458/${pageName}</code>`
          : events.length === 0
            ? '<br><br>当前时间槽可能尚未在 Gamma 上架，请稍后点「刷新」；若持续为空，请确认能访问 gamma-api.polymarket.com'
            : '';
        $('tableArea').innerHTML =
          `<div class="empty">没有符合条件的市场（已拉取 ${events.length} 个，筛选后 0）${hint}</div>`;
        $('paginationBar').style.display = 'none';
        syncPanelSlotCountdown();
        return;
      }

      const rows = page
        .map((ev) => {
          const evKey = String(ev.id);
          const isExp = expanded.has(evKey);
          const hasSubs = ev.markets.length > 1;
          const img = ev.image
            ? `<img class="market-img" src="${esc(ev.image)}" alt="" loading="lazy" onerror="this.style.display='none'">`
            : '<div class="market-img"></div>';
          let subHtml = '';
          if (hasSubs && isExp) {
            subHtml =
              '<div class="sub-markets">' +
              ev.markets
                .map((m) => {
                  const leadP = formatMarketProb(m);
                  return `<div class="sub-row">
          <span style="flex:1">${esc(m.question)}</span>
          <span class="sub-price">${esc(leadP)}</span>
          <span class="num" style="min-width:70px">${formatMoney(m.volume)}</span>
        </div>`;
                })
                .join('') +
              '</div>';
          }
          const expandBtn = hasSubs
            ? `<button class="expand-btn${isExp ? ' open' : ''}" onclick="${globalApiName}.toggleExpand('${evKey}')" title="展开子市场">${isExp ? '−' : '+'}</button>`
            : '<span style="width:28px"></span>';
          const endMs = getSlotEndMs(ev);
          const countdownHtml = panelSlotCountdown
            ? ''
            : `<span class="crypto-countdown" data-end="${endMs}">${formatCountdown(endMs - Date.now())}</span>`;
          const badge = `<span class="interval-badge${badgeClass}">${badgeLabel}</span>`;

          return `<tr class="${isExp ? 'expanded' : ''}" data-ev-id="${esc(evKey)}">
      <td style="width:36px">
        <input type="checkbox" class="sel-checkbox" value="${esc(evKey)}" onchange="PMTrade.updateBatchBar()" ${ev.primaryMarket ? '' : 'disabled'}>
      </td>
      <td class="market-td-crypto">
        ${countdownHtml}
        <div class="market-cell">
          ${expandBtn}
          ${img}
          <div style="flex:1;min-width:0">
            <a class="market-title" href="${esc(ev.url)}" target="_blank" rel="noopener">${esc(ev.title)}${badge}</a>
            ${subHtml}
          </div>
        </div>
      </td>
      ${hideSourceColumn ? '' : `<td><span class="source-badge">${sourceLabel}</span></td>`}
      ${
        showSpotPrices
          ? `<td class="num crypto-spot-cell" data-spot="target" title="槽开盘参考价">${formatSpotUsd(ev.targetPrice, coinFromEventSlug(ev.slug))}</td>
      <td class="num crypto-spot-cell" data-spot="current" title="Chainlink 现价">${formatSpotUsd(ev.currentPrice, coinFromEventSlug(ev.slug))}</td>
      <td class="num crypto-spot-cell ${spotDiffClass(ev)}" data-spot="diff" title="现价 − 目标价">${formatSpotDiff(ev)}</td>`
          : ''
      }
      <td class="num updown-price-cell">${upDownCellHtml(ev.upPrice, ev.upDepth, 'up', ev.priceFromBook, evKey)}</td>
      <td class="num updown-price-cell">${upDownCellHtml(ev.downPrice, ev.downDepth, 'down', ev.priceFromBook, evKey)}</td>
      ${showMarkovColumn ? `<td class="num markov-td" data-markov="1">${markovCellInnerHtml(ev)}</td>` : ''}
      ${
        hideVolumeOiColumns
          ? ''
          : `<td class="num" data-stat="volume">${formatMoney(ev.volume)}</td>
      <td class="num" data-stat="open-interest">${formatMoney(ev.openInterest)}</td>`
      }
    </tr>`;
        })
        .join('');

      $('tableArea').innerHTML = `
    <div class="tbl-wrap">
      <table>
        <thead>
          <tr>
            <th style="width:36px"><input type="checkbox" class="sel-checkbox" onchange="PMTrade.toggleSelectAll(this)" title="全选本页"></th>
            <th class="th-market">Market</th>
            ${hideSourceColumn ? '' : '<th>Source</th>'}
            ${showSpotPrices ? '<th>目标价</th><th>现价</th><th>价差</th>' : ''}
            <th>Up <span class="th-sub">${hideOrderButtons ? '价·深度' : '价·深度·市价'}</span></th>
            <th>Down <span class="th-sub">${hideOrderButtons ? '价·深度' : '价·深度·市价'}</span></th>
            ${showMarkovColumn ? '<th class="th-markov">马尔可夫<br><span class="th-sub">P·j*·进场</span></th>' : ''}
            ${hideVolumeOiColumns ? '' : '<th>Volume</th><th>Open Interest</th>'}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

      $('paginationBar').style.display = totalPages > 1 ? 'flex' : 'none';
      $('pageInfo').textContent = `Page ${currentPage + 1} of ${totalPages}`;
      $('prevBtn').disabled = currentPage === 0;
      $('nextBtn').disabled = currentPage >= totalPages - 1;
      syncPanelSlotCountdown();
    }

    async function loadAll(slotOnly = false) {
      if (loading) return;
      loading = true;
      stopTimers();
      if (!slotOnly) {
        expanded.clear();
        $('refreshBtn').disabled = true;
        $('tableArea').innerHTML = `<div class="loading"><div class="spin"></div>正在同步 ${intervalKey} 市场...</div>`;
        $('paginationBar').style.display = 'none';
      }
      setStatus('busy', slotOnly ? '切换时间槽...' : `拉取 ${intervalKey} 数据...`);
      try {
        events = await fetchCryptoPage();
        if (intervalKey === '5M') await enrichEventsPriceToBeat(events);
        if (showSpotPrices) await enrichEventsSpotPrices(events);
        applyFilterAndRender();
        refreshMarkovSnapshot();
        if (showSpotPrices) events.forEach((ev) => patchEventSpotPricesInDom(ev));
        startTimers();
        if (!events.length) {
          setStatus('', `未找到可交易的 ${intervalKey} 市场`);
        } else {
          setStatus('ok', `已更新 ${events.length} 个市场`);
        }
      } catch (e) {
        console.error(e);
        setStatus('', '加载失败');
        const hint = !global.location?.protocol?.startsWith('http')
          ? '<br><br>请用 <code>start-markets.bat</code> 启动后通过 http://localhost:3458 打开'
          : '';
        $('tableArea').innerHTML = `<div class="err"><strong>加载失败</strong><br>${esc(e.message)}${hint}</div>`;
      } finally {
        loading = false;
        slotEndRefreshPending = false;
        $('refreshBtn').disabled = false;
      }
    }

    function setEndFilter(hours, el) {
      filterEndHours = hours;
      document.querySelectorAll('[data-end]').forEach((c) => c.classList.remove('on'));
      el.classList.add('on');
      currentPage = 0;
      applyFilterAndRender();
    }

    function setProbPreset(min, max) {
      $('probMin').value = min;
      $('probMax').value = max === 100 ? '' : max;
      currentPage = 0;
      applyFilterAndRender();
    }

    function resetFilters() {
      stopTimers();
      filterEndHours = 0;
      $('probMin').value = '';
      $('probMax').value = '';
      $('minVol').value = '0';
      $('volType').value = 'total';
      $('searchInput').value = '';
      document.querySelectorAll('[data-end]').forEach((c) => c.classList.toggle('on', c.dataset.end === '0'));
      currentPage = 0;
      loadAll();
    }

    function onSearch() {
      currentPage = 0;
      applyFilterAndRender();
    }

    function changePage(delta) {
      const pageSize = parseInt($('pageSizeSelect').value, 10);
      const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
      currentPage = Math.min(Math.max(0, currentPage + delta), totalPages - 1);
      renderTable();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function toggleExpand(id) {
      id = String(id);
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      renderTable();
    }

    global.pmGetMarket = function (eventId) {
      const ev = events.find((e) => String(e.id) === String(eventId));
      if (!ev?.primaryMarket) return null;
      const p = ev.primaryMarket;
      return {
        id: ev.id,
        title: ev.title,
        outcomes: p.outcomes,
        prices: p.prices,
        clobTokenIds: p.clobTokenIds,
        conditionId: p.conditionId || null,
        negRisk: p.negRisk || !!ev.markets?.some((m) => m.negRisk),
      };
    };

    global.getFilterState = getFilterState;

    global.getMarketsMatchingFilters = function (f) {
      const filters = f || getFilterState();
      return events
        .filter((ev) => passesFilters(ev, filters))
        .filter((ev) => ev.primaryMarket)
        .map((ev) => String(ev.id));
    };

    global.prepareDataForAutoTrade = async function () {
      let wait = 0;
      while (loading && wait < 180) {
        await new Promise((r) => setTimeout(r, 1000));
        wait++;
      }
      await loadAll();
    };

    global.pmGetMarketByTokenId = function (tokenId) {
      const tid = String(tokenId || '');
      if (!tid) return null;
      for (const ev of events) {
        for (const m of ev.markets || []) {
          const ids = m.clobTokenIds || [];
          const idx = ids.findIndex((id) => String(id) === tid);
          if (idx >= 0) {
            return {
              title: ev.title,
              outcome: (m.outcomes || [])[idx] || m.question || '',
              eventId: ev.id,
              negRisk: !!m.negRisk,
            };
          }
        }
      }
      return null;
    };

    const api = {
      loadAll,
      toggleExpand,
      changePage,
      setEndFilter,
      setProbPreset,
      resetFilters,
      onSearch,
      applyFilterAndRender,
      getEvents: () => events,
    };
    if (autoBuy90) {
      api.toggleAuto90 = toggleAuto90;
      api.setAuto90Enabled = setAuto90Enabled;
      api.syncAuto90ToggleUi = syncAuto90ToggleUi;
      api.getOrderRules = loadOrderRules;
      api.saveOrderRules = saveOrderRules;
      api.getMergedRuleCfg = () => getMergedRuleCfg(autoBuy90);
      api.syncScheduleRulesSummary = syncScheduleRulesSummary;
      api.applyOrderUsdcProfile = applyOrderUsdcProfile;
      api.getEffectiveOrderUsdc = getEffectiveOrderUsdc;
      api.checkVirtualTpSl = checkVirtualTpSl;
      api.currentBestState = currentBestState;
      api.estimateMarkovSelfProb = estimateMarkovSelfProb;
      api.estimateMarkovProbDetailed = estimateMarkovProbDetailed;
      api.getMarkovHistory = loadMarkovHistory;
    }
    if (virtualBet) {
      api.toggleVirtualBet = toggleVirtualBet;
      api.debugVirtualConsensus = () => {
        const d = buildVirtualConsensusDebug();
        console.log('[virtual consensus]', d);
        return d;
      };
      api.setVirtualBetEnabled = setVirtualBetEnabled;
      api.toggleVirtualOrdersPanel = toggleVirtualOrdersPanel;
      api.refreshVirtualOrdersPanel = refreshVirtualOrdersPanel;
      api.changeVirtualOrdersPage = changeVirtualOrdersPage;
      function resetVirtualAll(skipConfirm) {
        const start = virtualBet?.startBankroll ?? 100;
        if (
          !skipConfirm &&
          !global.confirm(
            `确定重置 ${intervalNum} 分钟虚拟投注？\n\n· 虚拟余额恢复为 $${start}\n· 清空待结算与历史虚拟订单\n· 清除本槽跟单记录`,
          )
        ) {
          return;
        }
        saveVirtualState(defaultVirtualState());
        virtualMarkovPlacedKeys.clear();
        virtualClose40Slot = null;
        virtualOrdersPage = 0;
        syncVirtualBetUi();
        if (virtualOrdersPanelOpen) renderVirtualOrdersPanel();
        global.PMTrade?.toast?.(
          `已重置：虚拟余额 $${start}，订单列表已清空`,
          'info',
          8000,
        );
      }

      api.resetVirtualBankroll = () => resetVirtualAll(true);
      api.resetVirtualAll = () => resetVirtualAll(false);
      api.syncVirtualOrdersCsv = () => syncVirtualOrdersCsvFile(loadVirtualState());
      api.buildVirtualOrdersCsv = buildVirtualOrdersCsv;
      api.downloadVirtualOrdersCsv = downloadVirtualOrdersCsv;
      api.buildVirtualBankrollSeries = buildVirtualBankrollSeries;
      api.getVirtualStrategySummary = () => formatVirtualStrategySummary();
      api.buildVirtualAiContext = buildVirtualAiContext;
      api.buildVirtualLossAuditPayload = buildVirtualLossAuditPayload;
    }

    function clearLocalCache() {
      const lines = [
        '· 钱包 / API Key / 私钥 (pm_wallet)',
        `· ${intervalNum} 分钟虚拟投注与开关`,
        '· 自动下单与下单规则',
      ];
      if (intervalKey === '5M') lines.push('· 马尔可夫历史 · AI 配置');
      if (
        !global.confirm(
          `将清除本页所有本地缓存并刷新页面：\n\n${lines.join('\n')}\n\n此操作不可恢复，是否继续？`,
        )
      ) {
        return;
      }
      localStorage.removeItem('pm_wallet');
      localStorage.removeItem(VIRTUAL_STORAGE_KEY);
      localStorage.removeItem(VIRTUAL_BET_ENABLED_KEY);
      localStorage.removeItem(ORDER_RULES_STORAGE_KEY);
      localStorage.removeItem(`${storagePrefix}_auto90`);
      if (intervalKey === '5M') localStorage.removeItem(MARKOV_HISTORY_KEY);
      if (intervalKey === '5M') localStorage.removeItem('pm_5m_ai_assist');
      global.location.reload();
    }
    api.clearLocalCache = clearLocalCache;

    global[globalApiName] = api;

    function boot() {
      global.PMTrade?.init();
      applyOrderUsdcProfile();
      bind5mOrderAmountInput();
      if (autoBuy90 || virtualBet) {
        global.PMAuto?.mountCrypto5mSection?.();
        applyOrderUsdcProfile();
      }
      if (autoBuy90) {
        setAuto90Enabled(localStorage.getItem('pm_5m_auto90') === '1');
      }
      if (virtualBet) {
        setVirtualBetEnabled(localStorage.getItem(VIRTUAL_BET_ENABLED_KEY) === '1');
        syncVirtualBetUi();
        void syncVirtualOrdersCsvFile(loadVirtualState());
        document.addEventListener('click', (e) => {
          if (!virtualOrdersPanelOpen) return;
          const panel = $('virtualOrdersPanel');
          const btn = $('virtualOrdersBtn');
          if (panel?.contains(e.target) || btn?.contains(e.target)) return;
          virtualOrdersPanelOpen = false;
          if (panel) {
            panel.classList.remove('open');
            panel.setAttribute('aria-hidden', 'true');
          }
        });
      }
      loadAll();
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopTimers();
        else startTimers();
      });
      window.addEventListener('beforeunload', stopTimers);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }

  global.initPolymarketCryptoShort = initPolymarketCryptoShort;
})(window);
