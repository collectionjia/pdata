/**
 * 每日定时自动下单 + 止盈止损监控（需保持本页面打开）
 */
(function (global) {
  const STORAGE_KEY = 'pm_auto_schedule';
  const SIM_STORAGE_KEY = 'pm_auto_schedule_sim_v1';
  const TICK_MS = 30000;
  const TP_SL_COOLDOWN_MS = 120000;

  let config = defaultConfig();
  let tickTimer = null;
  let running = false;
  let tpSlRunning = false;
  const tpSlCooldown = new Map();

  const $ = (id) => document.getElementById(id);

  function defaultConfig() {
    return {
      enabled: false,
      runTime: '09:00',
      side: 'BUY',
      simulate: false,
      amount: 1,
      maxOrders: 20,
      filters: null,
      lastRunDate: '',
      lastRunAt: '',
      lastResult: '',
      tpSlEnabled: false,
      takeProfitPct: 25,
      stopLossPct: 15,
      tpSlScope: 'auto',
      watchedTokenIds: {},
      tpSlLastAt: '',
      tpSlLastResult: '',
    };
  }

  function loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        config = { ...defaultConfig(), ...parsed };
        if (!config.watchedTokenIds || typeof config.watchedTokenIds !== 'object') {
          config.watchedTokenIds = {};
        }
      }
    } catch (_) {
      config = defaultConfig();
    }
  }

  function saveConfig() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    updateFabState();
    syncFormFromConfig();
  }

  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function defaultSimState() {
    return {
      startCash: 100,
      cash: 100,
      positions: [],
      history: [],
      lastRunSummary: '',
      updatedAt: 0,
    };
  }

  function loadSimState() {
    try {
      const raw = localStorage.getItem(SIM_STORAGE_KEY);
      if (!raw) return defaultSimState();
      const parsed = JSON.parse(raw);
      return {
        ...defaultSimState(),
        ...parsed,
        positions: Array.isArray(parsed?.positions) ? parsed.positions : [],
        history: Array.isArray(parsed?.history) ? parsed.history : [],
      };
    } catch {
      return defaultSimState();
    }
  }

  function saveSimState(state) {
    localStorage.setItem(SIM_STORAGE_KEY, JSON.stringify(state));
  }

  function filterSummary(f) {
    if (!f) return '（未保存条件）';
    const parts = [];
    if (f.category && f.category !== 'all') {
      const names = {
        crypto5m: '加密5M', crypto15m: '加密15M', crypto: '加密', politics: '政治',
        finance: '财务', tech: '科技', culture: '文化', economy: '经济', weather: '天气', other: '其他',
      };
      parts.push(names[f.category] || f.category);
    }
    if (f.endHours > 0) parts.push(`${f.endHours}h内结束`);
    if (f.probMin != null || f.probMax != null) {
      parts.push(`赢率${f.probMin ?? 0}–${f.probMax ?? 100}%`);
    }
    if (f.minVol > 0) parts.push(`量≥$${f.minVol}`);
    if (f.search) parts.push(`搜:${f.search}`);
    return parts.length ? parts.join(' · ') : '全部活跃市场';
  }

  function registerBoughtTokens(bought) {
    if (!Array.isArray(bought) || !bought.length) return;
    config.watchedTokenIds = config.watchedTokenIds || {};
    const now = Date.now();
    for (const b of bought) {
      if (!b?.tokenId) continue;
      config.watchedTokenIds[String(b.tokenId)] = {
        label: b.label || '',
        at: now,
        marketId: b.marketId || '',
      };
    }
  }

  function pruneWatched(openPositions) {
    const open = new Set((openPositions || []).map((p) => String(p.tokenId)));
    for (const id of Object.keys(config.watchedTokenIds || {})) {
      if (!open.has(id)) delete config.watchedTokenIds[id];
    }
  }

  function syncFormFromConfig() {
    if ($('autoEnabled')) $('autoEnabled').checked = !!config.enabled;
    if ($('autoRunTime')) $('autoRunTime').value = config.runTime || '09:00';
    if ($('autoSide')) $('autoSide').value = config.side || 'BUY';
    if ($('autoSimulate')) $('autoSimulate').checked = !!config.simulate;
    config.amount = 1;
    if ($('autoMaxOrders')) $('autoMaxOrders').value = config.maxOrders ?? 20;
    if ($('autoFilterSummary')) $('autoFilterSummary').textContent = filterSummary(config.filters);
    if ($('autoLastRun')) {
      $('autoLastRun').textContent = config.lastRunAt
        ? `${config.lastRunDate} ${config.lastRunAt}${config.lastResult ? ' · ' + config.lastResult : ''}`
        : '尚未执行';
    }
    if ($('autoTpSlEnabled')) $('autoTpSlEnabled').checked = !!config.tpSlEnabled;
    if ($('autoTakeProfit')) $('autoTakeProfit').value = config.takeProfitPct ?? 25;
    if ($('autoStopLoss')) $('autoStopLoss').value = config.stopLossPct ?? 15;
    if ($('autoTpSlScope')) $('autoTpSlScope').value = config.tpSlScope || 'auto';
    if ($('autoTpSlStatus')) {
      const n = Object.keys(config.watchedTokenIds || {}).length;
      const base = config.tpSlLastAt
        ? `${config.tpSlLastAt}${config.tpSlLastResult ? ' · ' + config.tpSlLastResult : ''}`
        : '尚未触发';
      $('autoTpSlStatus').textContent =
        config.tpSlScope === 'auto' ? `${base}（监控 ${n} 个定时仓位）` : base;
    }
    updateFabState();
  }

  function readFormToConfig() {
    config.enabled = !!$('autoEnabled')?.checked;
    config.runTime = $('autoRunTime')?.value || '09:00';
    config.side = $('autoSide')?.value || 'BUY';
    config.simulate = !!$('autoSimulate')?.checked;
    config.amount = 1;
    config.maxOrders = parseInt($('autoMaxOrders')?.value, 10) || 20;
    config.tpSlEnabled = !!$('autoTpSlEnabled')?.checked;
    config.takeProfitPct = Math.max(1, parseFloat($('autoTakeProfit')?.value) || 25);
    config.stopLossPct = Math.max(1, parseFloat($('autoStopLoss')?.value) || 15);
    config.tpSlScope = $('autoTpSlScope')?.value || 'auto';
    saveConfig();
  }

  function captureCurrentFilters() {
    if (typeof global.getFilterState === 'function') {
      config.filters = global.getFilterState();
      saveConfig();
      global.PMTrade?.toast('已保存当前筛选条件', 'success');
      syncFormFromConfig();
    }
  }

  function resetFilters() {
    config.filters = null;
    saveConfig();
    syncFormFromConfig();
    global.PMTrade?.toast('已重置筛选快照', 'info');
  }

  function isCrypto5mPage() {
    return document.body?.dataset?.page === 'crypto5m' || !!global.Crypto5M;
  }

  function loadCrypto5mRules() {
    const defaults = {
      minCents: 90,
      maxCents: 95,
      minExclusive: true,
      maxExclusive: true,
      earlyBuyEnabled: false,
      lateBuyEnabled: false,
      lateBuySec: 40,
      onlyBuyBeforeEnd: false,
      tpSlEnabled: false,
      takeProfitPct: 25,
      stopLossPct: 15,
      tpSlScope: 'all',
      orderUsdc: 1,
      virtualTpSlEnabled: true,
      virtualTakeProfitPct: 5,
      virtualTakeProfitPrice: 0.98,
      virtualStopLossPct: 20,
      // 虚拟投注下单价格覆盖：单位为 1¢（留空=使用盘口 pick.price）
      virtualOrderPriceCents: null,
      markovEnabled: false,
      markovThreshold: 0.87,
      watchedTokenIds: {},
      tpSlLastAt: '',
      tpSlLastResult: '',
    };
    try {
      const raw = localStorage.getItem('pm_5m_order_rules');
      if (!raw) return { ...defaults };
      const parsed = JSON.parse(raw);
      return {
        ...defaults,
        ...parsed,
        watchedTokenIds:
          parsed.watchedTokenIds && typeof parsed.watchedTokenIds === 'object'
            ? parsed.watchedTokenIds
            : {},
      };
    } catch {
      return { ...defaults };
    }
  }

  function saveCrypto5mRules(rules) {
    localStorage.setItem('pm_5m_order_rules', JSON.stringify(rules));
    global.Crypto5M?.syncScheduleRulesSummary?.();
    syncCrypto5mTpSlStatus();
    updateFabState();
  }

  function registerCrypto5mBought(tokenId, label, marketId) {
    if (!tokenId) return;
    const rules = loadCrypto5mRules();
    rules.watchedTokenIds = rules.watchedTokenIds || {};
    rules.watchedTokenIds[String(tokenId)] = {
      label: label || '',
      at: Date.now(),
      marketId: marketId || '',
    };
    saveCrypto5mRules(rules);
  }

  function syncCrypto5mTpSlStatus() {
    const el = $('crypto5mTpSlStatus');
    if (!el) return;
    const r = loadCrypto5mRules();
    const n = Object.keys(r.watchedTokenIds || {}).length;
    const base = r.tpSlLastAt
      ? `${r.tpSlLastAt}${r.tpSlLastResult ? ' · ' + r.tpSlLastResult : ''}`
      : '尚未触发';
    el.textContent = r.tpSlScope === 'auto' ? `${base}（监控 ${n} 个自动仓位）` : base;
  }

  function syncMarkovStatus() {
    const el = $('crypto5mMarkovStatus');
    if (!el) return;
    const r = loadCrypto5mRules();
    if (!r.markovEnabled) { el.textContent = '（未启用）'; return; }
    // 读取马尔可夫历史并估计概率
    const MARKOV_HISTORY_KEY = 'pm_5m_markov_history';
    const WINDOW = 30;
    let hist = [];
    try { hist = JSON.parse(localStorage.getItem(MARKOV_HISTORY_KEY) || '[]'); } catch (_) {}
    if (!Array.isArray(hist) || hist.length < 4) {
      el.textContent = `历史不足（${hist.length} 槽），暂不过滤`;
      return;
    }
    const byCoin = {};
    for (const h of hist) {
      const c = (h.c || '').toLowerCase();
      if (!c) continue;
      if (!byCoin[c]) byCoin[c] = [];
      byCoin[c].push(h);
    }
    const coins = Object.keys(byCoin);
    if (!coins.length) {
      el.textContent = '尚无按币种样本（需等槽结束后自动记录）';
      el.style.color = '#6b7280';
      return;
    }
    const thr = r.markovThreshold ?? 0.87;
    const parts = coins.slice(0, 6).map((c) => {
      const recent = byCoin[c].slice(-WINDOW);
      let total = 0,
        stay = 0;
      for (let i = 1; i < recent.length; i++) {
        const prev = recent[i - 1].w,
          cur = recent[i].w;
        if (prev === 'up' || prev === 'down') {
          total++;
          if (cur === prev) stay++;
        }
      }
      if (total < 3) return `${c.toUpperCase()} 样本不足`;
      const prob = stay / total;
      return `${c.toUpperCase()} ${(prob * 100).toFixed(0)}%${prob >= thr ? '✓' : '✗'}`;
    });
    el.textContent = parts.join(' · ');
    el.style.color = '#374151';
  }

  async function runCrypto5mTpSlCheck() {
    const rules = loadCrypto5mRules();
    if (!rules.tpSlEnabled || tpSlRunning) return;
    if (!global.PMTrade?.isReady?.()) return;

    tpSlRunning = true;
    try {
      const positions = await global.PMTrade.fetchOpenPositions();
      const open = new Set((positions || []).map((p) => String(p.tokenId)));
      for (const id of Object.keys(rules.watchedTokenIds || {})) {
        if (!open.has(id)) delete rules.watchedTokenIds[id];
      }

      const tp = rules.takeProfitPct ?? 25;
      const sl = rules.stopLossPct ?? 15;
      const scopeAll = rules.tpSlScope === 'all';
      const watched = rules.watchedTokenIds || {};
      const hits = [];

      for (const pos of positions) {
        const tid = String(pos.tokenId);
        if (!scopeAll && !watched[tid]) continue;
        if (inTpSlCooldown(tid)) continue;

        const pnl = pos.percentPnl;
        let action = null;
        if (pnl >= tp) action = '止盈';
        else if (pnl <= -sl) action = '止损';
        if (!action) continue;

        try {
          await global.PMTrade.sellPosition(pos);
          tpSlCooldown.set(tid, Date.now());
          delete rules.watchedTokenIds[tid];
          hits.push(`${action} ${pos.label?.slice(0, 24) || tid} (${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%)`);
          if (global.PMTrade.toastTrade) {
            global.PMTrade.toastTrade(
              `${action}：${pos.label || tid}\n浮动 ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`,
              action,
              10000,
            );
          } else {
            global.PMTrade.toast(
              `${action}：${pos.label || tid}\n浮动 ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`,
              action === '止盈' ? 'tp' : 'sl',
              10000,
            );
          }
          global.PMTrade.refreshAfterSell?.(tid).catch(() => {});
        } catch (e) {
          console.error('[5M 止盈止损]', tid, e);
          global.PMTrade?.toast(`${action}失败 · ${pos.label || tid}\n${e.message || e}`, 'error', 12000);
        }
      }

      const now = new Date();
      rules.tpSlLastAt = now.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      if (hits.length) {
        rules.tpSlLastResult = hits.length === 1 ? hits[0] : `已平仓 ${hits.length} 笔`;
      }
      saveCrypto5mRules(rules);
    } catch (e) {
      console.warn('[5M 止盈止损检查]', e);
    } finally {
      tpSlRunning = false;
    }
  }

  function updateFabState() {
    const fab = $('autoScheduleFab');
    if (!fab) return;
    if (isCrypto5mPage()) {
      const r = loadCrypto5mRules();
      const autoOn = localStorage.getItem('pm_5m_auto90') === '1';
      const parts = [];
      if (autoOn) parts.push('5M 自动下单');
      if (r.tpSlEnabled) parts.push(`止盈+${r.takeProfitPct}%/止损-${r.stopLossPct}%`);
      if (r.markovEnabled) parts.push(`马尔可夫≥${Math.round((r.markovThreshold ?? 0.87) * 100)}%`);
      fab.classList.toggle('on', autoOn || !!r.tpSlEnabled || !!r.markovEnabled);
      fab.title = parts.length ? `定时调度：${parts.join('；')}` : '定时调度 · 5M 规则';
      return;
    }
    let active = !!config.enabled || !!config.tpSlEnabled;
    const parts = [];
    if (config.enabled) {
      const mode = config.simulate ? '模拟' : '实盘';
      parts.push(`每天 ${config.runTime} ${mode}${config.side === 'BUY' ? '买入' : '卖出'}`);
    }
    if (config.tpSlEnabled) {
      parts.push(`止盈+${config.takeProfitPct}% / 止损-${config.stopLossPct}%`);
    }
    fab.classList.toggle('on', active);
    fab.title = active ? `定时调度：${parts.join('；')}` : '定时自动下单 / 止盈止损';
  }

  function togglePanel() {
    $('autoSchedulePanel')?.classList.toggle('open');
    if (isCrypto5mPage()) syncCrypto5mFormFromStorage();
    else syncFormFromConfig();
  }

  function parseRunMinutes(timeStr) {
    const [h, m] = (timeStr || '09:00').split(':').map((x) => parseInt(x, 10));
    return (h || 0) * 60 + (m || 0);
  }

  function shouldRunNow() {
    if (!config.enabled || running) return false;
    if (config.lastRunDate === todayKey()) return false;
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    return nowMin >= parseRunMinutes(config.runTime);
  }

  function inTpSlCooldown(tokenId) {
    const t = tpSlCooldown.get(String(tokenId));
    return t && Date.now() - t < TP_SL_COOLDOWN_MS;
  }

  async function runTpSlCheck() {
    if (!config.tpSlEnabled || tpSlRunning) return;
    if (!global.PMTrade?.isReady?.()) return;

    tpSlRunning = true;
    try {
      const positions = await global.PMTrade.fetchOpenPositions();
      pruneWatched(positions);

      const tp = config.takeProfitPct ?? 25;
      const sl = config.stopLossPct ?? 15;
      const scopeAll = config.tpSlScope === 'all';
      const watched = config.watchedTokenIds || {};
      const hits = [];

      for (const pos of positions) {
        const tid = String(pos.tokenId);
        if (!scopeAll && !watched[tid]) continue;
        if (inTpSlCooldown(tid)) continue;

        const pnl = pos.percentPnl;
        let action = null;
        if (pnl >= tp) action = '止盈';
        else if (pnl <= -sl) action = '止损';
        if (!action) continue;

        try {
          await global.PMTrade.sellPosition(pos);
          tpSlCooldown.set(tid, Date.now());
          delete watched[tid];
          hits.push(`${action} ${pos.label?.slice(0, 24) || tid} (${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%)`);
          if (global.PMTrade.toastTrade) {
            global.PMTrade.toastTrade(
              `${action}：${pos.label || tid}\n浮动 ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`,
              action,
              10000,
            );
          } else {
            global.PMTrade.toast(
              `${action}：${pos.label || tid}\n浮动 ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`,
              action === '止盈' ? 'tp' : 'sl',
              10000,
            );
          }
          global.PMTrade.refreshAfterSell?.(tid).catch(() => {});
        } catch (e) {
          console.error('[止盈止损]', tid, e);
          global.PMTrade?.toast(`${action}失败 · ${pos.label || tid}\n${e.message || e}`, 'error', 12000);
        }
      }

      const now = new Date();
      config.tpSlLastAt = now.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      if (hits.length) {
        config.tpSlLastResult = hits.length === 1 ? hits[0] : `已平仓 ${hits.length} 笔`;
        saveConfig();
      }
    } catch (e) {
      console.warn('[止盈止损检查]', e);
    } finally {
      tpSlRunning = false;
    }
  }

  async function runScheduledJob(manual) {
    if (running) return;
    running = true;
    const fab = $('autoScheduleFab');
    if (fab) fab.classList.add('busy');

    try {
      global.PMTrade?.toast(manual ? '手动执行定时任务…' : '定时任务开始…', 'info');

      if (typeof global.prepareDataForAutoTrade === 'function') {
        await global.prepareDataForAutoTrade(config.filters);
      }

      const f = config.filters || (typeof global.getFilterState === 'function' ? global.getFilterState() : null);
      let ids = typeof global.getMarketsMatchingFilters === 'function'
        ? global.getMarketsMatchingFilters(f)
        : [];

      const maxN = Math.max(1, config.maxOrders || 20);
      if (ids.length > maxN) ids = ids.slice(0, maxN);

      if (!ids.length) {
        const msg = '无符合条件的市场';
        config.lastResult = msg;
        global.PMTrade?.toast(`定时任务：${msg}`, 'warn');
      } else if (config.simulate) {
        const simRes = runSimulatedBatch(ids, config.side, 1);
        config.lastResult = simRes.summary;
        const sim = loadSimState();
        sim.lastRunSummary = config.lastResult;
        sim.updatedAt = Date.now();
        saveSimState(sim);
        global.PMTrade?.toast(
          `模拟定时任务：${config.lastResult}\n模拟现金 $${sim.cash.toFixed(2)} · 持仓 ${sim.positions.length} 个`,
          'info',
          10000,
        );
      } else {
        const res = await global.PMTrade?.batchOrderForIds(ids, config.side, config.amount);
        config.lastResult = `成功${res?.ok ?? 0}/共${res?.total ?? ids.length}`;
        if (config.side === 'BUY' && res?.bought?.length) {
          registerBoughtTokens(res.bought);
        }
      }

      const now = new Date();
      config.lastRunAt = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      if (!manual) config.lastRunDate = todayKey();
      saveConfig();
      syncFormFromConfig();

      if (config.tpSlEnabled && !config.simulate) await runTpSlCheck();
    } catch (e) {
      console.error('[auto schedule]', e);
      config.lastResult = '异常: ' + (e.message || e);
      saveConfig();
      global.PMTrade?.toast('定时任务失败：' + (e.message || e), 'error', 12000);
    } finally {
      running = false;
      if (fab) fab.classList.remove('busy');
    }
  }

  function onTick() {
    if (isCrypto5mPage()) {
      runCrypto5mTpSlCheck();
      return;
    }
    if (shouldRunNow()) runScheduledJob(false);
    if (config.tpSlEnabled && !config.simulate) runTpSlCheck();
  }

  function pickLeadOutcome(market) {
    if (!market || !Array.isArray(market.prices) || !market.prices.length) return null;
    let bestIdx = -1;
    let bestP = -1;
    market.prices.forEach((raw, i) => {
      const p = parseFloat(raw);
      if (Number.isFinite(p) && p > bestP) {
        bestP = p;
        bestIdx = i;
      }
    });
    if (bestIdx < 0) return null;
    return {
      idx: bestIdx,
      price: bestP,
      tokenId: market.clobTokenIds?.[bestIdx] ? String(market.clobTokenIds[bestIdx]) : null,
      outcome: market.outcomes?.[bestIdx] || '',
    };
  }

  function runSimulatedBatch(ids, side, amountUsd) {
    const sim = loadSimState();
    const now = Date.now();
    const amount = amountUsd > 0 ? amountUsd : 1;
    let ok = 0;
    let skipped = 0;
    let errs = 0;

    for (const id of ids) {
      try {
        const market = global.pmGetMarket?.(id);
        const lead = pickLeadOutcome(market);
        if (!market || !lead || !lead.tokenId || !(lead.price > 0 && lead.price < 1)) {
          skipped++;
          continue;
        }

        const feeCalc = global.PMTrade?.calcTakerFeeUsdc;
        const px = lead.price;
        const qty = amount / px;
        const fee = feeCalc ? feeCalc(qty, px, 0.02) : qty * 0.02 * px * (1 - px);
        const key = `${id}:${lead.tokenId}`;
        const label = `${market.title || '市场'} · ${lead.outcome || ''}`.trim();

        if (side === 'BUY') {
          // 同一市场有未平模拟仓位时，跳过本次买入（避免重复加仓）
          const existingMarketPos = sim.positions.find(
            (p) => String(p.marketId) === String(id) && (p.shares || 0) > 1e-9,
          );
          if (existingMarketPos) {
            skipped++;
            continue;
          }
          const debit = amount + fee;
          if (sim.cash + 1e-9 < debit) {
            skipped++;
            continue;
          }
          sim.cash -= debit;
          let pos = sim.positions.find((p) => p.key === key);
          if (!pos) {
            pos = {
              key,
              marketId: String(id),
              tokenId: lead.tokenId,
              label,
              side: lead.outcome,
              shares: 0,
              avgPrice: 0,
              cost: 0,
              feePaid: 0,
            };
            sim.positions.push(pos);
          }
          const oldShares = pos.shares || 0;
          const oldCost = pos.cost || 0;
          pos.shares = oldShares + qty;
          pos.cost = oldCost + amount;
          pos.feePaid = (pos.feePaid || 0) + fee;
          pos.avgPrice = pos.shares > 0 ? pos.cost / pos.shares : px;
          sim.history.unshift({
            at: now,
            mode: 'sim',
            action: 'BUY',
            marketId: String(id),
            tokenId: lead.tokenId,
            label,
            price: px,
            shares: qty,
            amount,
            fee,
            cashAfter: sim.cash,
          });
          ok++;
        } else {
          let pos = sim.positions.find((p) => p.key === key && p.shares > 0);
          if (!pos) {
            pos = sim.positions.find((p) => String(p.marketId) === String(id) && p.shares > 0);
          }
          if (!pos) {
            skipped++;
            continue;
          }
          const sellShares = Math.min(pos.shares, qty);
          if (!(sellShares > 0)) {
            skipped++;
            continue;
          }
          const gross = sellShares * px;
          const sellFee = feeCalc ? feeCalc(sellShares, px, 0.02) : sellShares * 0.02 * px * (1 - px);
          const credit = Math.max(0, gross - sellFee);
          sim.cash += credit;
          pos.shares -= sellShares;
          const avg = pos.avgPrice || px;
          pos.cost = Math.max(0, (pos.cost || 0) - sellShares * avg);
          pos.feePaid = (pos.feePaid || 0) + sellFee;
          if (pos.shares <= 1e-9) {
            pos.shares = 0;
            pos.cost = 0;
          }
          sim.history.unshift({
            at: now,
            mode: 'sim',
            action: 'SELL',
            marketId: String(id),
            tokenId: lead.tokenId,
            label,
            price: px,
            shares: sellShares,
            amount: gross,
            fee: sellFee,
            cashAfter: sim.cash,
          });
          ok++;
        }
      } catch (_) {
        errs++;
      }
    }

    sim.positions = sim.positions.filter((p) => p.shares > 1e-9);
    sim.history = sim.history.slice(0, 400);
    sim.updatedAt = now;
    saveSimState(sim);
    return {
      ok,
      skipped,
      errs,
      summary: `模拟${side === 'BUY' ? '买入' : '卖出'} 成功${ok}/共${ids.length}${skipped ? ` · 跳过${skipped}` : ''}${errs ? ` · 异常${errs}` : ''}`,
    };
  }

  function startTicker() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(onTick, TICK_MS);
    onTick();
  }

  function readCrypto5mFormToStorage() {
    const prev = loadCrypto5mRules();
    const minCents = Math.max(1, Math.min(99, parseInt($('crypto5mMinCents')?.value, 10) || 90));
    let maxCents = Math.max(1, Math.min(99, parseInt($('crypto5mMaxCents')?.value, 10) || 95));
    if (maxCents <= minCents) maxCents = Math.min(99, minCents + 1);
    const lateBuySec = Math.max(5, Math.min(280, parseInt($('crypto5mLateBuySec')?.value, 10) || 40));
    let orderUsdc = parseFloat($('crypto5mOrderUsdc')?.value);
    if (!Number.isFinite(orderUsdc) || orderUsdc <= 0) orderUsdc = parseFloat($('orderAmtInput')?.value) || 1;
    orderUsdc = Math.min(10000, Math.round(orderUsdc * 100) / 100);
    const rules = {
      ...prev,
      orderUsdc,
      minCents,
      maxCents,
      minExclusive: true,
      maxExclusive: true,
      earlyBuyEnabled: !!$('crypto5mEarlyBuy')?.checked,
      lateBuyEnabled: !!$('crypto5mLateBuy')?.checked,
      lateBuySec,
      onlyBuyBeforeEnd: !!$('crypto5mOnlyBeforeEnd')?.checked,
      tpSlEnabled: !!$('crypto5mTpSlEnabled')?.checked,
      takeProfitPct: Math.max(1, parseFloat($('crypto5mTakeProfit')?.value) || 25),
      stopLossPct: Math.max(1, parseFloat($('crypto5mStopLoss')?.value) || 15),
      tpSlScope: $('crypto5mTpSlScope')?.value || 'all',
      virtualTpSlEnabled: !!$('crypto5mVirtualTpSlEnabled')?.checked,
      virtualTakeProfitPct: Math.max(0.1, parseFloat($('crypto5mVirtualTakeProfit')?.value) || 5),
      virtualTakeProfitPrice: (() => {
        const cents = parseInt($('crypto5mVirtualTakeProfitPrice')?.value, 10);
        if (Number.isFinite(cents) && cents > 0 && cents < 100) return cents / 100;
        return 0.98;
      })(),
      virtualStopLossPct: Math.max(0.1, parseFloat($('crypto5mVirtualStopLoss')?.value) || 20),
      virtualOrderPriceCents: (() => {
        const raw = $('crypto5mVirtualOrderPriceCents')?.value;
        if (raw == null || raw === '') return null;
        const cents = parseInt(raw, 10);
        if (!Number.isFinite(cents)) return null;
        if (cents < 1 || cents > 99) return null;
        return cents;
      })(),
      markovEnabled: !!$('crypto5mMarkovEnabled')?.checked,
      markovThreshold: Math.max(0.5, Math.min(0.99, parseFloat($('crypto5mMarkovThreshold')?.value) || 0.87)),
    };
    saveCrypto5mRules(rules);
    if (global.Crypto5M?.saveOrderRules) global.Crypto5M.saveOrderRules(rules);
    global.PMAiAssist?.saveFromForm?.();
    if (global.Crypto5M?.setAuto90Enabled) {
      global.Crypto5M.setAuto90Enabled(!!$('crypto5mAuto90Enabled')?.checked);
    }
    global.Crypto5M?.applyOrderUsdcProfile?.(orderUsdc);
    updateFabState();
    return rules;
  }

  function syncCrypto5mFormFromStorage() {
    const rules = loadCrypto5mRules();
    const usdc = rules.orderUsdc ?? 1;
    if ($('crypto5mOrderUsdc')) $('crypto5mOrderUsdc').value = usdc;
    if ($('orderAmtInput')) $('orderAmtInput').value = String(usdc);
    if ($('crypto5mMinCents')) $('crypto5mMinCents').value = rules.minCents ?? 90;
    if ($('crypto5mMaxCents')) $('crypto5mMaxCents').value = rules.maxCents ?? 95;
    if ($('crypto5mAuto90Enabled')) {
      $('crypto5mAuto90Enabled').checked = localStorage.getItem('pm_5m_auto90') === '1';
    }
    if ($('crypto5mEarlyBuy')) $('crypto5mEarlyBuy').checked = rules.earlyBuyEnabled === true;
    if ($('crypto5mLateBuy')) $('crypto5mLateBuy').checked = rules.lateBuyEnabled === true;
    if ($('crypto5mLateBuySec')) $('crypto5mLateBuySec').value = rules.lateBuySec ?? 40;
    if ($('crypto5mOnlyBeforeEnd')) $('crypto5mOnlyBeforeEnd').checked = !!rules.onlyBuyBeforeEnd;
    if ($('crypto5mTpSlEnabled')) $('crypto5mTpSlEnabled').checked = !!rules.tpSlEnabled;
    if ($('crypto5mTakeProfit')) $('crypto5mTakeProfit').value = rules.takeProfitPct ?? 25;
    if ($('crypto5mStopLoss')) $('crypto5mStopLoss').value = rules.stopLossPct ?? 15;
    if ($('crypto5mTpSlScope')) $('crypto5mTpSlScope').value = rules.tpSlScope || 'all';
    if ($('crypto5mVirtualTpSlEnabled')) $('crypto5mVirtualTpSlEnabled').checked = rules.virtualTpSlEnabled !== false;
    if ($('crypto5mVirtualTakeProfit')) $('crypto5mVirtualTakeProfit').value = rules.virtualTakeProfitPct ?? 5;
    if ($('crypto5mVirtualTakeProfitPrice')) {
      const px = rules.virtualTakeProfitPrice ?? 0.98;
      $('crypto5mVirtualTakeProfitPrice').value = Math.round(px * 100);
    }
    if ($('crypto5mVirtualStopLoss')) $('crypto5mVirtualStopLoss').value = rules.virtualStopLossPct ?? 20;
    if ($('crypto5mVirtualOrderPriceCents'))
      $('crypto5mVirtualOrderPriceCents').value = rules.virtualOrderPriceCents ?? '';
    if ($('crypto5mMarkovEnabled')) $('crypto5mMarkovEnabled').checked = !!rules.markovEnabled;
    if ($('crypto5mMarkovThreshold')) $('crypto5mMarkovThreshold').value = rules.markovThreshold ?? 0.87;
    syncMarkovStatus();
    global.Crypto5M?.syncScheduleRulesSummary?.();
    syncCrypto5mTpSlStatus();
    global.PMAiAssist?.syncForm?.();
    updateFabState();
  }

  const CRYPTO5M_TAB_KEY = 'pm_5m_auto_tab';

  function switchCrypto5mTab(tabId) {
    const id = tabId || 'auto';
    document.querySelectorAll('#crypto5mRulesSection .auto-tab').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset.tab === id);
    });
    document.querySelectorAll('#crypto5mRulesSection .auto-tab-panel').forEach((panel) => {
      panel.classList.toggle('on', panel.dataset.tabPanel === id);
    });
    try {
      sessionStorage.setItem(CRYPTO5M_TAB_KEY, id);
    } catch (_) {}
  }

  function restoreCrypto5mTab() {
    let tab = 'auto';
    try {
      tab = sessionStorage.getItem(CRYPTO5M_TAB_KEY) || 'auto';
    } catch (_) {}
    if (!document.querySelector(`#crypto5mRulesSection .auto-tab[data-tab="${tab}"]`)) tab = 'auto';
    switchCrypto5mTab(tab);
  }

  function mountCrypto5mSection() {
    const panel = $('autoSchedulePanel');
    if (!panel || $('crypto5mRulesSection')) return;

    const section = document.createElement('div');
    section.id = 'crypto5mRulesSection';
    section.className = 'crypto5m-rules-section';
    section.innerHTML = `
      <div class="auto-tabs" role="tablist" aria-label="定时调度">
        <button type="button" class="auto-tab on" data-tab="auto" role="tab" aria-selected="true" onclick="PMAuto.switchCrypto5mTab('auto')">自动下单</button>
        <button type="button" class="auto-tab" data-tab="virtual" role="tab" aria-selected="false" onclick="PMAuto.switchCrypto5mTab('virtual')">虚拟投注</button>
        <button type="button" class="auto-tab" data-tab="ai" role="tab" aria-selected="false" onclick="PMAuto.switchCrypto5mTab('ai')">AI 辅助</button>
        <button type="button" class="auto-tab" data-tab="live" role="tab" aria-selected="false" onclick="PMAuto.switchCrypto5mTab('live')">实盘风控</button>
      </div>
      <div class="auto-tab-body">
        <div class="auto-tab-panel on" data-tab-panel="auto" role="tabpanel">
          <div class="auto-tab-auto-actions">
            <button type="button" class="btn btn-auto90" id="crypto5mAuto90ToggleBtn" onclick="Crypto5M.toggleAuto90()">自动下单：关</button>
            <label class="auto-row" style="margin:0"><input type="checkbox" id="crypto5mAuto90Enabled"> 启用 5M 自动下单（CLOB 市价 FOK）</label>
          </div>
          <p class="auto-hint" style="margin-top:0">当前 5 分钟槽 · 非 BTC · 价格在区间内才自动下单。修改后点<strong>保存设置</strong>生效；须保持本页打开。</p>
          <div class="auto-row">
            <span class="auto-lbl">每单</span>
            <input type="number" id="crypto5mOrderUsdc" class="filter-input" value="1" min="0.1" step="0.1" style="width:72px;font-size:14px;padding:4px 8px">
            <span class="auto-lbl">USDC</span>
          </div>
          <div class="auto-row">
            <span class="auto-lbl">价格</span>
            <span class="auto-lbl">&gt;</span>
            <input type="number" id="crypto5mMinCents" class="filter-input" value="90" min="1" max="98" style="width:64px;font-size:14px;padding:4px 8px">
            <span class="auto-lbl">¢ 且 &lt;</span>
            <input type="number" id="crypto5mMaxCents" class="filter-input" value="95" min="2" max="99" style="width:64px;font-size:14px;padding:4px 8px">
            <span class="auto-lbl">¢</span>
          </div>
          <div class="auto-section-title">买入时间</div>
          <label class="auto-row"><input type="checkbox" id="crypto5mEarlyBuy"> 槽内盘口刷新时可买（每槽首单）</label>
          <label class="auto-row"><input type="checkbox" id="crypto5mLateBuy"> 结束前再买一单</label>
          <div class="auto-row">
            <span class="auto-lbl">结束前</span>
            <input type="number" id="crypto5mLateBuySec" class="filter-input" value="40" min="5" max="280" style="width:52px;font-size:14px;padding:4px 8px">
            <span class="auto-lbl">秒触发（±2s）</span>
          </div>
          <label class="auto-row"><input type="checkbox" id="crypto5mOnlyBeforeEnd"> 仅在结束前买入（关闭盘中自动买）</label>
          <div class="auto-section-title">马尔可夫链策略过滤</div>
          <p class="auto-hint" style="margin-top:0">按<strong>每个市场行</strong>（slug）独立统计 P%。≥3 槽为正式值，2 槽显示初估 <strong>†</strong>（暂不过滤）。仅过滤<strong>实盘</strong>自动下单。</p>
          <label class="auto-row"><input type="checkbox" id="crypto5mMarkovEnabled"> 启用马尔可夫策略过滤</label>
          <div class="auto-row">
            <span class="auto-lbl">持续概率阈值 ≥</span>
            <input type="number" id="crypto5mMarkovThreshold" class="filter-input" value="0.87" min="0.5" max="0.99" step="0.01" style="width:64px;font-size:14px;padding:4px 8px">
            <span class="auto-lbl">（0.50–0.99）</span>
          </div>
          <div class="auto-row" style="margin:0">
            <span class="auto-lbl">当前估计</span>
            <span id="crypto5mMarkovStatus" style="font-size:11px;color:#6b7280;flex:1">—</span>
          </div>
        </div>
        <div class="auto-tab-panel" data-tab-panel="virtual" role="tabpanel">
          <div class="auto-section-title" style="margin-top:0;padding-top:0;border-top:none">虚拟投注止盈 / 止损</div>
          <p class="auto-hint" style="margin-top:0">待结算虚拟单按盘口中间价估算浮动%；<strong>市价 ≥ 设定¢</strong>（默认 98¢）或浮动%达止盈即平仓（每约 5 秒检查）。</p>
          <label class="auto-row"><input type="checkbox" id="crypto5mVirtualTpSlEnabled" checked> 启用虚拟止盈止损</label>
          <div class="auto-row">
            <span class="auto-lbl">止盈</span>
            <input type="number" id="crypto5mVirtualTakeProfit" class="filter-input" value="5" min="0.1" max="500" step="0.1" style="width:52px"> %
            <span class="auto-lbl">或 ≥</span>
            <input type="number" id="crypto5mVirtualTakeProfitPrice" class="filter-input" value="98" min="50" max="99" step="1" style="width:52px"> ¢
          </div>
          <div class="auto-row">
            <span class="auto-lbl">止损</span>
            <input type="number" id="crypto5mVirtualStopLoss" class="filter-input" value="20" min="0.1" max="99" step="0.1" style="width:52px"> %
          </div>
          <div class="auto-row">
            <span class="auto-lbl">虚拟下单价格</span>
            <input type="number" id="crypto5mVirtualOrderPriceCents" class="filter-input" placeholder="留空=盘口" min="1" max="99" step="1" style="width:72px;font-size:14px;padding:4px 8px">
            <span class="auto-lbl">¢</span>
          </div>
          <p class="auto-hint" style="margin-top:0">共识90 虚拟单始终按<strong>表格盘口价</strong>判断与成交；右上角「虚拟投注」开关控制是否模拟下单。</p>
        </div>
        <div class="auto-tab-panel" data-tab-panel="ai" role="tabpanel">
          <div class="auto-section-title" style="margin-top:0;padding-top:0;border-top:none">AI 辅助分析（虚拟投注）</div>
          <p class="auto-hint" style="margin-top:0">共识触发拟下单前，AI 将读取<strong>全槽盘口、成交量/OI、马尔可夫、共识计数、余额与风控参数</strong>等综合判断是否投。Key 存浏览器，经本地服务转发。</p>
          <label class="auto-row"><input type="checkbox" id="crypto5mAiEnabled"> 启用 AI 辅助（虚拟投注）</label>
          <div class="auto-row ai-config-row">
            <span class="auto-lbl">API URL</span>
            <input type="url" id="crypto5mAiApiUrl" class="wp-input ai-config-input" placeholder="https://api.openai.com/v1" autocomplete="off">
          </div>
          <div class="auto-row ai-config-row">
            <span class="auto-lbl">API Key</span>
            <input type="password" id="crypto5mAiApiKey" class="wp-input ai-config-input" placeholder="sk-..." autocomplete="off">
          </div>
          <div class="auto-row ai-config-row">
            <span class="auto-lbl">模型</span>
            <input type="text" id="crypto5mAiModel" class="wp-input ai-config-input" placeholder="gpt-4o-mini" autocomplete="off">
          </div>
          <div class="auto-row">
            <span class="auto-lbl">模式</span>
            <select id="crypto5mAiMode" class="sort-select" style="flex:1">
              <option value="gate">拦截：AI 说不投则本槽不下虚拟单</option>
              <option value="advise">建议：仅提示，仍按共识策略下单</option>
            </select>
          </div>
          <div class="auto-row" style="margin:0">
            <span class="auto-lbl">AI 状态</span>
            <span id="crypto5mAiStatus" style="font-size:11px;color:#6b7280;flex:1;line-height:1.35">—</span>
          </div>
          <div class="auto-actions ai-config-actions" style="border-top:none;padding-top:8px;margin-top:4px">
            <button type="button" class="btn" onclick="PMAiAssist.testConnection()">测试连接</button>
            <button type="button" class="btn btn-ai" onclick="PMAiAssist.analyzeNow()">立即 AI 分析</button>
            <button type="button" class="btn btn-ai-audit" onclick="PMAiAssist.auditLosingOrders()">审计亏损订单</button>
          </div>
          <div id="crypto5mAiAuditResult" class="ai-audit-result" hidden></div>
        </div>
        <div class="auto-tab-panel" data-tab-panel="live" role="tabpanel">
          <div class="auto-section-title" style="margin-top:0;padding-top:0;border-top:none">实盘止盈 / 止损</div>
          <p class="auto-hint" style="margin-top:0">真实持仓按 Data API 浮动盈亏% 每 30 秒检查；触发后市价 FOK 全仓卖出。</p>
          <label class="auto-row"><input type="checkbox" id="crypto5mTpSlEnabled"> 启用实盘止盈止损</label>
          <div class="auto-row">
            <span class="auto-lbl">止盈</span>
            <input type="number" id="crypto5mTakeProfit" class="filter-input" value="25" min="1" max="500" step="1" style="width:52px"> %
            <span class="auto-lbl">止损</span>
            <input type="number" id="crypto5mStopLoss" class="filter-input" value="15" min="1" max="99" step="1" style="width:52px"> %
          </div>
          <div class="auto-row">
            <span class="auto-lbl">监控</span>
            <select id="crypto5mTpSlScope" class="sort-select" style="flex:1">
              <option value="auto">仅自动买入的仓位</option>
              <option value="all" selected>全部持仓</option>
            </select>
          </div>
          <div class="auto-row" style="margin:0">
            <span class="auto-lbl">实盘状态</span>
            <span id="crypto5mTpSlStatus" style="font-size:11px;color:#6b7280;flex:1">—</span>
          </div>
        </div>
      </div>
      <div class="auto-panel-footer">
        <div id="crypto5mRulesSummary" class="auto-filter-box">—</div>
        <div class="auto-row" style="margin:8px 0 0">
          <span class="auto-lbl">自动下单</span>
          <span id="crypto5mAuto90Status" class="crypto5m-rule-status">—</span>
        </div>
        <div class="auto-actions" style="margin-top:10px;padding-top:10px">
          <button type="button" class="btn btn-primary" onclick="PMAuto.save()">保存设置</button>
          <button type="button" class="btn" onclick="PMAuto.checkCrypto5mTpSlNow()">检查实盘止盈止损</button>
          <button type="button" class="btn" onclick="Crypto5M.checkVirtualTpSl()">检查虚拟止盈止损</button>
        </div>
      </div>
    `;
    const hd = panel.querySelector('.auto-panel-hd');
    if (hd) hd.insertAdjacentElement('afterend', section);
    else panel.appendChild(section);

    restoreCrypto5mTab();
    syncCrypto5mFormFromStorage();
    const autoChk = $('crypto5mAuto90Enabled');
    if (autoChk && !autoChk._pm5mBound) {
      autoChk._pm5mBound = true;
      autoChk.addEventListener('change', () => {
        global.Crypto5M?.setAuto90Enabled?.(autoChk.checked);
      });
    }
    global.Crypto5M?.syncAuto90ToggleUi?.();
  }

  function buildUI() {
    if ($('autoScheduleFab')) return;

    const fab = document.createElement('button');
    fab.type = 'button';
    fab.id = 'autoScheduleFab';
    fab.className = 'auto-fab';
    fab.innerHTML = '⏱';
    fab.title = isCrypto5mPage() ? '定时调度 · 5M 自动下单规则' : '定时自动下单 / 止盈止损';
    fab.onclick = togglePanel;
    document.body.appendChild(fab);

    const panel = document.createElement('div');
    panel.id = 'autoSchedulePanel';
    panel.className = 'auto-panel' + (isCrypto5mPage() ? ' auto-panel--crypto5m-only' : '');
    if (isCrypto5mPage()) {
      panel.innerHTML = `
      <div class="auto-panel-hd">
        <strong>定时调度</strong>
        <button type="button" class="btn" onclick="PMAuto.closePanel()">✕</button>
      </div>
    `;
      document.body.appendChild(panel);
      return;
    }
    panel.innerHTML = `
      <div class="auto-panel-hd">
        <strong>每日定时下单</strong>
        <button type="button" class="btn" onclick="PMAuto.closePanel()">✕</button>
      </div>
      <p class="auto-hint">保存条件后，每天在指定时间对<strong>符合条件</strong>的市场自动执行。可选模拟买卖（无需钱包），每次固定 $1/笔。</p>
      <label class="auto-row"><input type="checkbox" id="autoEnabled"> 启用定时任务</label>
      <div class="auto-row">
        <span class="auto-lbl">每天</span>
        <input type="time" id="autoRunTime" class="wp-input" value="09:00">
        <span class="auto-lbl">执行</span>
      </div>
      <div class="auto-row">
        <span class="auto-lbl">方向</span>
        <select id="autoSide" class="sort-select">
          <option value="BUY">买入</option>
          <option value="SELL">卖出</option>
        </select>
        <label class="auto-row" style="margin:0">
          <input type="checkbox" id="autoSimulate">
          <span class="auto-lbl">模拟买卖（无需钱包）</span>
        </label>
      </div>
      <div class="auto-row">
        <span class="auto-lbl">市价 $1/笔</span>
        <span class="auto-lbl">最多</span>
        <input type="number" id="autoMaxOrders" class="filter-input" value="20" min="1" max="100" style="width:48px">
        <span class="auto-lbl">笔</span>
      </div>
      <div class="auto-row" style="flex-direction:column;align-items:stretch">
        <span class="auto-lbl">筛选条件（快照）</span>
        <div id="autoFilterSummary" class="auto-filter-box">—</div>
        <div class="auto-filter-btns">
          <button type="button" class="btn btn-primary" onclick="PMAuto.captureFilters()">使用当前页筛选条件</button>
          <button type="button" class="btn" onclick="PMAuto.resetFilters()">重置</button>
        </div>
      </div>
      <div class="auto-section-title">止盈 / 止损</div>
      <p class="auto-hint" style="margin-top:0">按 Data API 的<strong>浮动盈亏%</strong>每 30 秒检查；触发后市价 FOK 全仓卖出。</p>
      <label class="auto-row"><input type="checkbox" id="autoTpSlEnabled"> 启用止盈止损监控</label>
      <div class="auto-row">
        <span class="auto-lbl">止盈</span>
        <input type="number" id="autoTakeProfit" class="filter-input" value="25" min="1" max="500" step="1" style="width:52px"> %
        <span class="auto-lbl">止损</span>
        <input type="number" id="autoStopLoss" class="filter-input" value="15" min="1" max="99" step="1" style="width:52px"> %
      </div>
      <div class="auto-row">
        <span class="auto-lbl">监控范围</span>
        <select id="autoTpSlScope" class="sort-select" style="flex:1">
          <option value="auto">仅定时买入的仓位</option>
          <option value="all">全部持仓</option>
        </select>
      </div>
      <div class="auto-row">
        <span class="auto-lbl">止盈止损</span>
        <span id="autoTpSlStatus" style="font-size:11px;color:#6b7280;flex:1">—</span>
      </div>
      <div class="auto-row">
        <span class="auto-lbl">上次执行</span>
        <span id="autoLastRun" style="font-size:11px;color:#6b7280">—</span>
      </div>
      <div class="auto-actions">
        <button type="button" class="btn btn-primary" onclick="PMAuto.save()">保存设置</button>
        <button type="button" class="btn" onclick="PMAuto.runNow()">立即试跑</button>
        <button type="button" class="btn" onclick="PMAuto.checkTpSlNow()">检查止盈止损</button>
      </div>
    `;
    document.body.appendChild(panel);

    [
      'autoEnabled', 'autoRunTime', 'autoSide', 'autoSimulate', 'autoMaxOrders',
      'autoTpSlEnabled', 'autoTakeProfit', 'autoStopLoss', 'autoTpSlScope',
    ].forEach((id) => {
      $(id)?.addEventListener('change', () => readFormToConfig());
    });
  }

  function init() {
    loadConfig();
    buildUI();
    if (document.body?.dataset?.page === 'crypto5m') mountCrypto5mSection();
    else syncFormFromConfig();
    startTicker();
  }

  function closePanel() {
    $('autoSchedulePanel')?.classList.remove('open');
  }

  function save() {
    if (isCrypto5mPage() && $('crypto5mRulesSection')) {
      const rules = readCrypto5mFormToStorage();
      const on = localStorage.getItem('pm_5m_auto90') === '1';
      const bits = [];
      if (on) bits.push('5M 自动下单');
      if (rules.tpSlEnabled) bits.push(`实盘止盈 +${rules.takeProfitPct}% / 止损 -${rules.stopLossPct}%`);
      if (rules.virtualTpSlEnabled !== false) {
        const tpPx = rules.virtualTakeProfitPrice ?? 0.98;
        bits.push(
          `虚拟止盈 +${rules.virtualTakeProfitPct ?? 5}% 或 ≥${Math.round(tpPx * 100)}¢ / 止损 -${rules.virtualStopLossPct ?? 20}%`,
        );
      }
      if (rules.onlyBuyBeforeEnd) bits.push(`仅结束前 ${rules.lateBuySec}s 买`);
      else if (rules.lateBuyEnabled) bits.push(`结束前 ${rules.lateBuySec}s 二单`);
      global.PMTrade?.toast(bits.length ? `已保存：${bits.join('；')}` : '已保存（自动下单未启用）', 'success');
      closePanel();
      return;
    }
    readFormToConfig();
    if (config.enabled && !config.filters && typeof global.getFilterState === 'function') {
      config.filters = global.getFilterState();
      saveConfig();
    }
    if (config.enabled && !config.filters) {
      global.PMTrade?.toast('定时买入需先保存筛选条件', 'warn');
      return;
    }
    const bits = [];
    if (config.enabled) bits.push(`每天 ${config.runTime} ${config.simulate ? '模拟' : '实盘'}下单`);
    if (config.tpSlEnabled) bits.push(`止盈 +${config.takeProfitPct}% / 止损 -${config.stopLossPct}%`);
    global.PMTrade?.toast(bits.length ? `已保存：${bits.join('；')}` : '已保存（未启用功能）', 'success');
    closePanel();
  }

  global.PMAuto = {
    init,
    togglePanel,
    closePanel,
    captureFilters: captureCurrentFilters,
    resetFilters,
    save,
    runNow: () => runScheduledJob(true),
    checkTpSlNow: () => runTpSlCheck(),
    checkCrypto5mTpSlNow: () => runCrypto5mTpSlCheck(),
    registerCrypto5mBought,
    switchCrypto5mTab,
    mountCrypto5mSection,
    syncCrypto5mFormFromStorage,
    updateFabState,
    getSimState: loadSimState,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
