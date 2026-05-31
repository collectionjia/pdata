/**
 * 交易列表 · 定时跟单调度
 */
(function (global) {
  const STORAGE_KEY = 'pm_traders_copy_schedule_v1';
  const PAPER_STORAGE_KEY = 'pm_traders_copy_paper_v1';
  const DEFAULT_PAPER_BANKROLL = 100;
  const TAKER_FEE_RATE = 0.02;
  const $ = (id) => document.getElementById(id);

  let timer = null;
  let running = false;
  let copyOrdersPanelOpen = false;
  const seenKeys = new Map();
  const primedWallets = new Set();

  function defaultConfig() {
    return {
      enabled: false,
      simulate: true,
      pollSec: 60,
      amountUsd: 1,
      copyBuy: true,
      copySell: false,
      maxPerHour: 10,
      wallets: [],
    };
  }

  function loadConfig() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return { ...defaultConfig(), ...raw, wallets: Array.isArray(raw.wallets) ? raw.wallets : [] };
    } catch {
      return defaultConfig();
    }
  }

  function saveConfig(cfg) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function logLine(msg, level) {
    const el = $('copyLog');
    if (!el) return;
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const line = document.createElement('div');
    line.className = 'traders-copy-log-line' + (level ? ` ${level}` : '');
    line.textContent = `[${t}] ${msg}`;
    el.prepend(line);
    while (el.children.length > 80) el.removeChild(el.lastChild);
  }

  function formatSimLine(trade, est, side) {
    const title = (trade.title || trade.slug || '').slice(0, 36);
    const theirPx = trade.price != null ? `${(trade.price * 100).toFixed(1)}¢` : '—';
    if (side === 'BUY' && est && global.PMTrade?.formatBuyEstimateLine) {
      return `模拟 BUY · ${title} · 对方 ${theirPx} · ${global.PMTrade.formatBuyEstimateLine(est)}`;
    }
    if (est?.summary) return `模拟 ${side} · ${title} · 对方 ${theirPx} · ${est.summary}`;
    const amt = est?.amountUsd ?? 0;
    const px = est?.marketPrice != null ? `${(est.marketPrice * 100).toFixed(1)}¢` : '—';
    return `模拟 ${side} · ${title} · 对方 ${theirPx} · 约 $${amt.toFixed(2)} @ ${px}`;
  }

  function setSimPreview(html) {
    const el = $('copySimPreview');
    if (el) el.innerHTML = html;
  }

  function calcTakerFeeUsdc(shares, price, feeRate = TAKER_FEE_RATE) {
    const C = +shares || 0;
    const p = price > 0 && price < 1 ? price : 0.5;
    const raw = C * feeRate * p * (1 - p);
    return Math.round(raw * 1e5) / 1e5;
  }

  function defaultPaperState() {
    return { bankroll: DEFAULT_PAPER_BANKROLL, startBankroll: DEFAULT_PAPER_BANKROLL, history: [] };
  }

  function loadPaperState() {
    try {
      const raw = JSON.parse(localStorage.getItem(PAPER_STORAGE_KEY) || '{}');
      const base = defaultPaperState();
      return {
        ...base,
        ...raw,
        history: Array.isArray(raw.history) ? raw.history : [],
      };
    } catch {
      return defaultPaperState();
    }
  }

  function savePaperState(st) {
    localStorage.setItem(PAPER_STORAGE_KEY, JSON.stringify(st));
  }

  function updateCopyOrdersBadge() {
    const st = loadPaperState();
    const badge = $('copyOrdersBadge');
    if (badge) badge.textContent = String(st.history.length);
  }

  function updatePaperUi() {
    const st = loadPaperState();
    const el = $('copyPaperBalance');
    if (el) {
      const delta = st.bankroll - st.startBankroll;
      const sign = delta >= 0 ? '+' : '';
      el.innerHTML = `模拟余额 <b>$${st.bankroll.toFixed(2)}</b> <span class="copy-paper-delta ${delta >= 0 ? 'pos' : 'neg'}">(${sign}$${delta.toFixed(2)})</span> · 已记 ${st.history.length} 笔`;
    }
    updateCopyOrdersBadge();
    if (copyOrdersPanelOpen) renderCopyOrdersPanel();
  }

  function formatCopyOrderTime(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('zh-CN', {
      hour12: false,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function renderCopyOrdersPanel() {
    const body = $('copyOrdersListBody');
    if (!body) return;
    const st = loadPaperState();
    const cfg = loadConfig();
    const simMode = cfg.simulate !== false;
    if (!st.history.length) {
      body.innerHTML =
        '<div class="copy-orders-empty">暂无跟单记录<br><small>开启模拟跟单并监视交易员后，新成交会出现在此</small></div>';
      return;
    }
    const delta = st.bankroll - st.startBankroll;
    const sign = delta >= 0 ? '+' : '';
    let html = `<div class="copy-orders-summary">`;
    if (simMode) {
      html += `模拟余额 <b>$${st.bankroll.toFixed(2)}</b> <span class="copy-paper-delta ${delta >= 0 ? 'pos' : 'neg'}">(${sign}$${delta.toFixed(2)})</span> · `;
    }
    html += `共 ${st.history.length} 笔</div>`;
    html += `<table class="copy-orders-table"><thead><tr>
      <th>类型</th><th>时间</th><th>市场</th><th>方向</th><th class="num">跟单价</th><th class="num">对方价</th><th class="num">金额</th><th class="num">余额</th>
    </tr></thead><tbody>`;
    for (const row of st.history.slice(0, 80)) {
      const isLive = row.mode === 'live';
      const tag = isLive
        ? '<span class="copy-ord-tag live">实盘</span>'
        : '<span class="copy-ord-tag sim">模拟</span>';
      const side = (row.side || '').toUpperCase();
      const sideCls = side === 'BUY' ? 'copy-side-buy' : 'copy-side-sell';
      const mpx = row.marketPrice != null ? `${(row.marketPrice * 100).toFixed(1)}¢` : '—';
      const tpx = row.theirPrice != null ? `${(row.theirPrice * 100).toFixed(1)}¢` : '—';
      const amt =
        row.debit > 0
          ? `<span class="copy-amt-out">-$${row.debit.toFixed(3)}</span>`
          : row.credit > 0
            ? `<span class="copy-amt-in">+$${row.credit.toFixed(3)}</span>`
            : '—';
      const bal =
        row.bankrollAfter != null && !isLive ? `$${row.bankrollAfter.toFixed(2)}` : '—';
      html += `<tr>
        <td>${tag}</td>
        <td>${formatCopyOrderTime(row.at)}</td>
        <td class="copy-ord-market" title="${esc(row.title || '')}">${esc((row.title || '—').slice(0, 42))}</td>
        <td class="${sideCls}">${esc(side || '—')}</td>
        <td class="num">${mpx}</td>
        <td class="num">${tpx}</td>
        <td class="num">${amt}</td>
        <td class="num">${bal}</td>
      </tr>`;
    }
    html += '</tbody></table>';
    if (st.history.length > 80) {
      html += `<div class="copy-orders-more">仅显示最近 80 条，共 ${st.history.length} 条</div>`;
    }
    body.innerHTML = html;
  }

  function toggleCopyOrdersPanel() {
    copyOrdersPanelOpen = !copyOrdersPanelOpen;
    const panel = $('copyOrdersListPanel');
    const btn = $('copyOrdersListBtn');
    if (panel) {
      panel.classList.toggle('open', copyOrdersPanelOpen);
      panel.setAttribute('aria-hidden', copyOrdersPanelOpen ? 'false' : 'true');
    }
    if (btn) btn.classList.toggle('on', copyOrdersPanelOpen);
    if (copyOrdersPanelOpen) renderCopyOrdersPanel();
  }

  function bindCopyOrdersPanel() {
    $('copyOrdersListBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCopyOrdersPanel();
    });
    $('copyOrdersClose')?.addEventListener('click', () => {
      copyOrdersPanelOpen = false;
      $('copyOrdersListPanel')?.classList.remove('open');
      $('copyOrdersListBtn')?.classList.remove('on');
      $('copyOrdersListPanel')?.setAttribute('aria-hidden', 'true');
    });
    $('copyOrdersRefresh')?.addEventListener('click', () => renderCopyOrdersPanel());
    document.addEventListener('click', (e) => {
      if (!copyOrdersPanelOpen) return;
      const panel = $('copyOrdersListPanel');
      const btn = $('copyOrdersListBtn');
      if (panel?.contains(e.target) || btn?.contains(e.target)) return;
      $('copyOrdersClose')?.click();
    });
  }

  function appendCopyOrderRecord(entry) {
    const st = loadPaperState();
    st.history.unshift(entry);
    if (st.history.length > 300) st.history.length = 300;
    savePaperState(st);
    updatePaperUi();
  }

  function resetPaperBankroll() {
    if (!global.confirm(`重置模拟跟单账本？\n\n余额恢复 $${DEFAULT_PAPER_BANKROLL}，并清空模拟成交记录。`)) {
      return;
    }
    savePaperState(defaultPaperState());
    updatePaperUi();
    logLine(`模拟账本已重置为 $${DEFAULT_PAPER_BANKROLL}`, 'ok');
  }

  function recordPaperCopy(trade, estWrap, cfg) {
    const st = loadPaperState();
    const side = (trade.side || 'BUY').toUpperCase();
    const est = estWrap.est || estWrap;
    const amountUsd = Math.max(0.1, parseFloat(cfg.amountUsd) || 1);
    const px = est?.marketPrice ?? (trade.price > 0 && trade.price < 1 ? trade.price : 0.5);
    let debit = 0;
    let credit = 0;
    let shares = est?.shares;
    if (side === 'BUY') {
      debit = est?.totalDebit ?? amountUsd + calcTakerFeeUsdc(shares ?? amountUsd / px, px);
      if (shares == null) shares = amountUsd / px;
      if (st.bankroll + 1e-6 < debit) {
        logLine(`模拟余额不足：$${st.bankroll.toFixed(2)} < 需 $${debit.toFixed(4)}`, 'warn');
        return false;
      }
      st.bankroll -= debit;
    } else {
      if (shares == null) shares = amountUsd / px;
      const gross = est?.spent != null ? est.spent : shares * px;
      const fee = est?.feeUsdc ?? calcTakerFeeUsdc(shares, px);
      credit = gross - fee;
      st.bankroll += credit;
    }
    st.history.unshift({
      id: tradeKey(trade),
      at: Date.now(),
      mode: 'sim',
      side,
      title: (trade.title || trade.slug || '').slice(0, 80),
      theirPrice: trade.price,
      marketPrice: px,
      shares,
      debit: side === 'BUY' ? debit : 0,
      credit: side === 'SELL' ? credit : 0,
      bankrollAfter: st.bankroll,
      summary: estWrap.summary || '',
    });
    if (st.history.length > 300) st.history.length = 300;
    savePaperState(st);
    updatePaperUi();
    return true;
  }

  function recordLiveCopy(trade, side, amount) {
    appendCopyOrderRecord({
      id: `${tradeKey(trade)}:live`,
      at: Date.now(),
      mode: 'live',
      side,
      title: (trade.title || trade.slug || '').slice(0, 80),
      theirPrice: trade.price,
      marketPrice: trade.price,
      debit: side === 'BUY' ? amount : 0,
      credit: side === 'SELL' ? amount : 0,
      bankrollAfter: null,
      summary: `实盘 ${side} · $${amount}`,
    });
  }

  const CLOB_ORIGIN = 'https://clob.polymarket.com';

  /** 从成交记录解析参考价（0~1）；支持美分字段 */
  function tradeHintPrice(trade) {
    const raw = trade?.price ?? trade?.avgPrice ?? trade?.executionPrice ?? trade?.fillPrice;
    let p = parseFloat(raw);
    if (!Number.isFinite(p)) return null;
    if (p > 1 && p <= 100) p /= 100;
    if (p > 0 && p < 1) return p;
    return null;
  }

  function parseBookLevelsLocal(book, side) {
    const raw = side === 'BUY' ? book?.asks || [] : book?.bids || [];
    const levels = raw
      .map((l) => ({ p: parseFloat(l.price), s: parseFloat(l.size) }))
      .filter((l) => l.p > 0 && l.p < 1 && l.s > 0);
    return side === 'BUY' ? levels.sort((a, b) => a.p - b.p) : levels.sort((a, b) => b.p - a.p);
  }

  async function fetchClobJsonCopy(path, tokenId, extraParams = {}) {
    const params = new URLSearchParams({ token_id: String(tokenId), ...extraParams });
    const q = params.toString();
    const bases = [];
    const fromTraders = apiBase();
    if (fromTraders) bases.push(fromTraders);
    if (global.location?.protocol?.startsWith('http')) {
      const origin = `${global.location.protocol}//${global.location.host}`;
      if (!bases.includes(origin)) bases.push(origin);
    }
    if (!bases.includes('http://localhost:3457')) bases.push('http://localhost:3457');
    for (const base of bases) {
      try {
        const url = `${base}/api/clob/${path}?${q}`;
        const r = await fetch(url);
        if (r.ok) return await r.json();
      } catch (_) {}
    }
    try {
      const r = await fetch(`${CLOB_ORIGIN}/${path}?${q}`, { mode: 'cors' });
      if (r.ok) return await r.json();
    } catch (_) {}
    return null;
  }

  function estimateFromHintPrice(side, amountUsd, hint, pm, note) {
    const px = hint;
    const shares = amountUsd / px;
    const fee = pm?.calcTakerFeeUsdc?.(shares, px, TAKER_FEE_RATE) ?? calcTakerFeeUsdc(shares, px, TAKER_FEE_RATE);
    const tag = note ? `（${note}）` : '（成交价估算）';
    if (side === 'BUY') {
      const totalDebit = Math.round((amountUsd + fee) * 1e4) / 1e4;
      const summary = `约 ${shares.toFixed(4)} 份 @ ${(px * 100).toFixed(1)}¢${tag} · 成本 $${amountUsd.toFixed(2)} + 费 $${fee.toFixed(5)} = $${totalDebit.toFixed(4)}`;
      return {
        side,
        amountUsd,
        est: {
          shares,
          marketPrice: px,
          costUsdc: amountUsd,
          feeUsdc: fee,
          totalDebit,
          winProfit: shares - totalDebit,
        },
        summary,
        usedFallback: true,
      };
    }
    const credit = Math.round((amountUsd - fee) * 1e4) / 1e4;
    const summary = `约卖 ${shares.toFixed(4)} 份 @ ${(px * 100).toFixed(1)}¢${tag} · 到账约 $${credit.toFixed(4)}`;
    return {
      side,
      amountUsd,
      marketPrice: px,
      shares,
      feeUsdc: fee,
      credit,
      summary,
      usedFallback: true,
    };
  }

  function walkBookLevels(levels, amountUsd) {
    let remaining = amountUsd;
    let totalShares = 0;
    let spent = 0;
    let worst = 0;
    for (const { p, s } of levels) {
      if (remaining <= 1e-9) break;
      worst = worst || p;
      const levelVal = p * s;
      if (remaining >= levelVal - 1e-9) {
        totalShares += s;
        spent += levelVal;
        remaining -= levelVal;
      } else {
        const partial = remaining / p;
        totalShares += partial;
        spent += remaining;
        remaining = 0;
      }
    }
    if (remaining > 0.02 || totalShares <= 0) return null;
    return { vwap: spent / totalShares, shares: totalShares, spent, worst: worst || levels[0].p };
  }

  /** 按 CLOB 订单簿估算跟单成交价（不实际下单） */
  async function estimateCopyTrade(trade, cfg) {
    const side = (trade.side || 'BUY').toUpperCase();
    const amountUsd = Math.max(0.1, parseFloat(cfg.amountUsd) || 1);
    const tokenId = trade.asset || trade.tokenId || trade.token_id;
    const hint = tradeHintPrice(trade);
    const pm = global.PMTrade;

    if (side === 'BUY' && tokenId && pm?.estimateMarketBuyDetailed) {
      try {
        const opts = { category: 'crypto' };
        if (hint) {
          opts.markPrice = hint;
          opts.worstPrice = Math.min(0.99, Math.max(0.01, hint * 1.02));
        }
        const est = await pm.estimateMarketBuyDetailed(amountUsd, tokenId, opts);
        return { side, est, amountUsd, summary: pm.formatBuyEstimateLine?.(est) || '' };
      } catch (e) {
        console.warn('[跟单试算] estimateMarketBuyDetailed', e.message || e);
      }
    }

    if (tokenId) {
      try {
        const book = await fetchClobJsonCopy('book', tokenId);
        const levels = parseBookLevelsLocal(book, side);
        const fill = levels.length ? walkBookLevels(levels, amountUsd) : null;
        if (fill) {
          const fee = pm?.calcTakerFeeUsdc?.(fill.shares, fill.vwap, TAKER_FEE_RATE) ?? calcTakerFeeUsdc(fill.shares, fill.vwap, TAKER_FEE_RATE);
          const summary =
            side === 'SELL'
              ? `卖 ${fill.shares.toFixed(4)} 份 · VWAP ${(fill.vwap * 100).toFixed(1)}¢ · 到账约 $${(fill.spent - fee).toFixed(4)}（费 $${fee.toFixed(5)}）`
              : `${fill.shares.toFixed(4)} 份 · VWAP ${(fill.vwap * 100).toFixed(1)}¢ · 订单簿`;
          if (side === 'BUY') {
            const totalDebit = Math.round((fill.spent + fee) * 1e4) / 1e4;
            return {
              side,
              est: {
                shares: fill.shares,
                marketPrice: fill.vwap,
                costUsdc: fill.spent,
                feeUsdc: fee,
                totalDebit,
                winProfit: fill.shares - totalDebit,
              },
              amountUsd,
              summary,
            };
          }
          return {
            side,
            amountUsd,
            marketPrice: fill.vwap,
            shares: fill.shares,
            feeUsdc: fee,
            credit: fill.spent - fee,
            summary,
          };
        }
        const priceJson = await fetchClobJsonCopy('price', tokenId, { side });
        const bestPx = parseFloat(priceJson?.price);
        if (bestPx > 0 && bestPx < 1) {
          return estimateFromHintPrice(side, amountUsd, bestPx, pm, 'CLOB 最优价');
        }
      } catch (e) {
        console.warn('[跟单试算] 订单簿', e.message || e);
      }
    }

    if (hint) {
      return estimateFromHintPrice(side, amountUsd, hint, pm, '对方成交价');
    }
    return {
      side,
      amountUsd,
      error: '无法估算：订单簿不可用且成交记录无价格。请换一条较新的成交再试。',
    };
  }

  async function runSimForTrade(trade, cfg) {
    const estWrap = await estimateCopyTrade(trade, cfg);
    const side = (trade.side || '').toUpperCase();
    if (estWrap.error) {
      logLine(`模拟失败：${estWrap.error}`, 'warn');
      setSimPreview(`<span class="copy-sim-err">${esc(estWrap.error)}</span>`);
      return estWrap;
    }
    const line = formatSimLine(trade, estWrap.est || estWrap, side);
    const recorded = recordPaperCopy(trade, estWrap, cfg);
    const fb = estWrap.usedFallback ? ' · 已用成交价回退估算' : '';
    logLine(line + fb + (recorded ? ' · 已记入模拟账本' : ''), recorded ? 'ok' : 'warn');
    const win =
      estWrap.est?.winProfit != null
        ? ` · 若赢 +$${estWrap.est.winProfit.toFixed(4)}`
        : '';
    const st = loadPaperState();
    setSimPreview(
      `<div class="copy-sim-detail"><strong>${esc(side)}</strong> ${esc((trade.title || '').slice(0, 40))}${win}<br><span>${esc(estWrap.summary || line)}</span><br><small>模拟余额 $${st.bankroll.toFixed(2)}</small></div>`,
    );
    return estWrap;
  }

  function tradeKey(t) {
    return `${t.transactionHash || ''}:${t.timestamp || ''}:${t.asset || ''}`;
  }

  function apiBase() {
    return global.PMTraders?.apiBase?.() || '';
  }

  async function fetchTraderTrades(wallet) {
    const params = new URLSearchParams({
      user: wallet,
      limit: '30',
      takerOnly: 'true',
    });
    const base = apiBase();
    let url = `${base}/api/data/trades?${params}`;
    let r = await fetch(url);
    let json = await r.json();
    if (!r.ok || json.success === false) {
      url = `https://data-api.polymarket.com/trades?${params}`;
      r = await fetch(url, { mode: 'cors' });
      json = await r.json();
    }
    const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    return list;
  }

  async function mirrorTrade(trade, cfg) {
    const side = (trade.side || '').toUpperCase();
    if (side === 'BUY' && !cfg.copyBuy) return;
    if (side === 'SELL' && !cfg.copySell) return;
    if (cfg.simulate) {
      await runSimForTrade(trade, cfg);
      return;
    }
    if (!global.PMTrade?.isReady?.()) {
      logLine('钱包未连接，跳过下单（请在页面配置私钥/API）', 'warn');
      return;
    }
    const tokenId = trade.asset;
    if (!tokenId) {
      logLine('成交缺少 token，无法跟单', 'warn');
      return;
    }
    const amount = Math.max(0.1, parseFloat(cfg.amountUsd) || 1);
    const label = (trade.title || trade.slug || '').slice(0, 48);
    try {
      await global.PMTrade.placeOrderWithToken(tokenId, side, amount, { label });
      recordLiveCopy(trade, side, amount);
      logLine(`${side} 跟单成功 · ${label} · $${amount}`, 'ok');
      global.PMTrade?.toast?.(`跟单 ${side} · ${label}\n$${amount}`, 'success', 8000);
    } catch (e) {
      logLine(`跟单失败：${e.message || e}`, 'err');
    }
  }

  async function pollWallet(wallet, cfg) {
    const w = wallet.toLowerCase();
    if (!seenKeys.has(w)) seenKeys.set(w, new Set());
    const seen = seenKeys.get(w);
    const trades = await fetchTraderTrades(w);
    const sorted = trades.slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    if (!primedWallets.has(w)) {
      for (const t of sorted) {
        const k = tradeKey(t);
        if (k) seen.add(k);
      }
      primedWallets.add(w);
      logLine(`已初始化 ${w.slice(0, 8)}… · 跳过历史 ${seen.size} 笔`, 'ok');
      return;
    }
    let newCount = 0;
    for (const t of sorted) {
      const k = tradeKey(t);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      if (seen.size > 500) {
        const arr = [...seen];
        arr.slice(0, 200).forEach((x) => seen.delete(x));
      }
      const ts = t.timestamp > 1e12 ? t.timestamp / 1000 : t.timestamp;
      const ageSec = Date.now() / 1000 - ts;
      if (ageSec > cfg.pollSec * 2 + 30) continue;
      newCount++;
      logLine(`新成交 ${t.side} · ${(t.title || '').slice(0, 32)} · ${w.slice(0, 8)}…`);
      await mirrorTrade(t, cfg);
    }
    if (!newCount) {
      logLine(`监视 ${w.slice(0, 8)}… · 无新成交`, '');
    }
  }

  async function tick(opts = {}) {
    if (running) return;
    const cfg = opts.cfg || readForm();
    if (!cfg.enabled && !opts.force) return;
    const wallets = [...new Set((cfg.wallets || []).map((w) => w.toLowerCase()).filter(Boolean))];
    if (!wallets.length) {
      logLine('未选择跟单地址', 'warn');
      return;
    }
    running = true;
    $('copyStatus') && ($('copyStatus').textContent = '轮询中…');
    try {
      for (const w of wallets) {
        await pollWallet(w, cfg);
      }
      $('copyStatus') &&
        ($('copyStatus').textContent = `上次 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
    } catch (e) {
      logLine(`轮询错误：${e.message || e}`, 'err');
    } finally {
      running = false;
    }
  }

  function stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function startTimer() {
    stopTimer();
    const cfg = loadConfig();
    if (!cfg.enabled) return;
    const sec = Math.max(15, parseInt(cfg.pollSec, 10) || 60);
    timer = setInterval(() => void tick(), sec * 1000);
    void tick();
  }

  function readForm() {
    const cfg = loadConfig();
    cfg.enabled = !!$('copyEnabled')?.checked;
    cfg.pollSec = Math.max(15, parseInt($('copyPollSec')?.value, 10) || 60);
    cfg.amountUsd = Math.max(0.1, parseFloat($('copyAmount')?.value) || 1);
    cfg.copyBuy = !!$('copyBuy')?.checked;
    cfg.copySell = !!$('copySell')?.checked;
    cfg.simulate = !!$('copySimulate')?.checked;
    cfg.maxPerHour = Math.max(1, parseInt($('copyMaxHour')?.value, 10) || 10);
    const raw = ($('copyWallets')?.value || '').trim();
    cfg.wallets = raw
      ? raw
          .split(/[\s,;]+/)
          .map((w) => w.trim().toLowerCase())
          .filter((w) => /^0x[a-f0-9]{40}$/.test(w))
      : [];
    return cfg;
  }

  function syncForm(cfg) {
    cfg = cfg || loadConfig();
    if ($('copyEnabled')) $('copyEnabled').checked = !!cfg.enabled;
    if ($('copyPollSec')) $('copyPollSec').value = cfg.pollSec ?? 60;
    if ($('copyAmount')) $('copyAmount').value = cfg.amountUsd ?? 1;
    if ($('copyBuy')) $('copyBuy').checked = cfg.copyBuy !== false;
    if ($('copySell')) $('copySell').checked = !!cfg.copySell;
    if ($('copySimulate')) $('copySimulate').checked = !!cfg.simulate;
    if ($('copyMaxHour')) $('copyMaxHour').value = cfg.maxPerHour ?? 10;
    if ($('copyWallets')) $('copyWallets').value = (cfg.wallets || []).join('\n');
    updateWatchCount();
  }

  function updateWatchCount() {
    const n = global.PMTraders?.getWatchSet?.()?.size ?? 0;
    const el = $('copyWatchCount');
    if (el) el.textContent = `表格已选 ${n} 个`;
  }

  function syncWatchFromTable() {
    const set = global.PMTraders?.getWatchSet?.();
    if (!set || !set.size) return;
    const cfg = loadConfig();
    cfg.wallets = [...set];
    saveConfig(cfg);
    if ($('copyWallets')) $('copyWallets').value = cfg.wallets.join('\n');
    updateWatchCount();
  }

  async function simLatestTrade() {
    const cfg = readForm();
    const wallets = cfg.wallets.length
      ? cfg.wallets
      : [...(global.PMTraders?.getWatchSet?.() || [])];
    if (!wallets.length) {
      logLine('请先勾选交易员或填写监视地址', 'warn');
      return;
    }
    try {
      const trades = await fetchTraderTrades(wallets[0]);
      const latest = trades.slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
      if (!latest) {
        logLine('该地址暂无成交', 'warn');
        return;
      }
      await runSimForTrade(latest, cfg);
    } catch (e) {
      logLine(`试算失败：${e.message || e}`, 'err');
    }
  }

  function saveAndRestart() {
    const cfg = readForm();
    if (cfg.enabled && !cfg.simulate && !global.PMTrade?.isReady?.()) {
      logLine('真实跟单须先连接钱包；可勾选「模拟跟单」无需钱包', 'warn');
      global.PMTrade?.toast?.('真实跟单须连接钱包；模拟模式无需钱包', 'warn', 8000);
      return;
    }
    saveConfig(cfg);
    syncForm(cfg);
    stopTimer();
    startTimer();
    const mode = cfg.simulate ? '模拟' : '实盘';
    logLine(cfg.enabled ? `${mode}跟单调度已保存并启动` : '已保存（未启用）', 'ok');
    global.PMTrade?.toast?.(
      cfg.enabled ? `${mode}跟单已启动${cfg.simulate ? '（无需钱包）' : ''}` : '跟单设置已保存',
      'info',
    );
  }

  function buildUI() {
    if ($('tradersCopyFab')) return;
    const fab = document.createElement('button');
    fab.type = 'button';
    fab.id = 'tradersCopyFab';
    fab.className = 'traders-copy-fab';
    fab.title = '定时跟单调度';
    fab.innerHTML = '跟单';
    fab.onclick = () => $('tradersCopyPanel')?.classList.toggle('open');
    document.body.appendChild(fab);

    const panel = document.createElement('div');
    panel.id = 'tradersCopyPanel';
    panel.className = 'traders-copy-panel';
    panel.innerHTML = `
      <div class="traders-copy-hd">
        <strong>定时跟单</strong>
        <button type="button" class="btn" id="copyPanelClose">✕</button>
      </div>
      <p class="traders-copy-hint">监视交易员新成交并跟单。<strong>模拟模式无需连接钱包</strong>，按订单簿估算价格并记入模拟余额；取消模拟并启用调度后才会真实下单（须配置钱包）。</p>
      <div class="traders-copy-paper-bar" id="copyPaperBalance">模拟余额 —</div>
      <label class="traders-check"><input type="checkbox" id="copyEnabled"> 启用自动跟单调度</label>
      <label class="traders-check traders-check-sim"><input type="checkbox" id="copySimulate" checked> 模拟跟单（无需钱包）</label>
      <div class="traders-copy-sim-preview" id="copySimPreview">最新试算将显示在此</div>
      <div class="traders-copy-row">
        <span>轮询</span>
        <input type="number" id="copyPollSec" class="filter-input" value="60" min="15" max="600" step="15" style="width:64px"> 秒
      </div>
      <div class="traders-copy-row">
        <span>每笔</span>
        <input type="number" id="copyAmount" class="filter-input" value="1" min="0.1" step="0.1" style="width:64px"> USDC
      </div>
      <div class="traders-copy-row">
        <label class="traders-check"><input type="checkbox" id="copyBuy" checked> 跟买入</label>
        <label class="traders-check"><input type="checkbox" id="copySell"> 跟卖出</label>
      </div>
      <div class="traders-copy-row">
        <span id="copyWatchCount">表格已选 0 个</span>
        <button type="button" class="btn" id="copySyncWatch">同步表格勾选</button>
      </div>
      <label class="traders-copy-lbl">监视地址（每行一个 0x…）</label>
      <textarea id="copyWallets" class="traders-copy-textarea" rows="4" placeholder="0x…"></textarea>
      <div class="traders-copy-actions">
        <button type="button" class="btn btn-primary" id="copySave">保存并启动</button>
        <button type="button" class="btn" id="copyPollNow">立即检查</button>
        <button type="button" class="btn" id="copySimCalc">最新成交试算</button>
        <button type="button" class="btn" id="copyPaperReset">重置模拟账本</button>
      </div>
      <div class="traders-copy-status" id="copyStatus">—</div>
      <div class="traders-copy-log" id="copyLog"></div>
    `;
    document.body.appendChild(panel);

    $('copyPanelClose')?.addEventListener('click', () => panel.classList.remove('open'));
    $('copySave')?.addEventListener('click', saveAndRestart);
    $('copyPollNow')?.addEventListener('click', () => void tick({ force: true, cfg: readForm() }));
    $('copyPaperReset')?.addEventListener('click', resetPaperBankroll);
    $('copySimCalc')?.addEventListener('click', () => void simLatestTrade());
    $('copyAmount')?.addEventListener('change', () => {
      const cfg = readForm();
      saveConfig(cfg);
    });
    $('copySyncWatch')?.addEventListener('click', syncWatchFromTable);
    bindCopyOrdersPanel();
    syncForm();
    updatePaperUi();
    startTimer();
  }

  global.PMTradersCopy = {
    onWatchSetChanged: updateWatchCount,
    syncWatchFromTable,
    startTimer,
    stopTimer,
    estimateCopyTrade,
    runSimForTrade,
    resetPaperBankroll,
    loadPaperState,
    toggleCopyOrdersPanel,
    renderCopyOrdersPanel,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUI);
  } else {
    buildUI();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
