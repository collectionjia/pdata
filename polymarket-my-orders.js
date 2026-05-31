/**
 * 右下角「我的持仓」面板
 */
(function (global) {
  let panelOpen = false;
  let cache = null;

  const $ = (id) => document.getElementById(id);

  function fmtUsd(n) {
    const v = +n || 0;
    const sign = v >= 0 ? '+' : '';
    return sign + '$' + Math.abs(v).toFixed(2);
  }

  function pnlClass(v) {
    if (v > 0.005) return 'pnl-pos';
    if (v < -0.005) return 'pnl-neg';
    return 'pnl-flat';
  }

  function fmtCents(price) {
    const c = (parseFloat(price) || 0) * 100;
    const s = c.toFixed(1);
    return (s.endsWith('.0') ? s.slice(0, -2) : s) + '¢';
  }

  function fmtPnlLine(pnl, pct) {
    const v = +pnl || 0;
    const sign = v >= 0 ? '+' : '-';
    const absPct = Math.abs(+pct || 0).toFixed(2);
    return `${sign}$${Math.abs(v).toFixed(2)} (${absPct}%)`;
  }

  function outcomeBadgeClass(outcome) {
    const o = (outcome || '').toLowerCase();
    if (o === 'yes') return 'yes';
    if (o === 'no') return 'no';
    return 'other';
  }

  function positionUrl(p) {
    if (p.eventSlug) return `https://polymarket.com/event/${encodeURIComponent(p.eventSlug)}`;
    if (p.slug) return `https://polymarket.com/event/${encodeURIComponent(p.slug)}`;
    return 'https://polymarket.com/portfolio';
  }

  function renderPositionIcon(p) {
    const letter = esc((p.outcome || 'P').charAt(0).toUpperCase());
    if (p.icon) {
      return `<img class="orders-pos-icon" src="${esc(p.icon)}" alt="" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><div class="orders-pos-icon orders-pos-icon-ph" hidden>${letter}</div>`;
    }
    return `<div class="orders-pos-icon orders-pos-icon-ph">${letter}</div>`;
  }

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
  }

  function togglePanel() {
    panelOpen = !panelOpen;
    $('myOrdersPanel')?.classList.toggle('open', panelOpen);
    if (panelOpen) loadData();
  }

  function closePanel() {
    panelOpen = false;
    $('myOrdersPanel')?.classList.remove('open');
  }

  function fmtCash(n, err, needApi) {
    if (n != null && !Number.isNaN(n)) return `$${n.toFixed(2)}`;
    if (err) {
      return `<span class="orders-cash-err" title="${esc(err)}">未加载</span>`;
    }
    if (needApi) return '<span class="orders-cash-muted">需 API Key</span>';
    return '—';
  }

  function renderPortfolio(summary) {
    const el = $('ordersPortfolio');
    if (!el || !summary) return;
    const {
      portfolioValue,
      positionsValue,
      balanceUsdc,
      balanceError,
      unrealized,
      realized,
      openPositions,
      cost,
    } = summary;
    const uCls = unrealized >= 0 ? 'profit' : 'loss';
    const rCls = realized >= 0 ? 'profit' : 'loss';
    const hasTotal = portfolioValue != null && !Number.isNaN(portfolioValue);
    const totalMain = hasTotal
      ? `$${portfolioValue.toFixed(2)}`
      : `$${(positionsValue || 0).toFixed(2)}`;
    const totalHint = hasTotal
      ? `持仓 $${(positionsValue || 0).toFixed(2)} + 现金 ${balanceUsdc != null ? '$' + balanceUsdc.toFixed(2) : '—'}`
      : '现金余额未加载，仅显示持仓市值';
    const cashStr = fmtCash(balanceUsdc, balanceError, !global.PMTrade?.isReady?.());

    el.innerHTML = `
      <div class="orders-portfolio-card">
        <div class="orders-portfolio-top">
          <span class="orders-portfolio-label">资产组合</span>
          <div class="orders-portfolio-total">${totalMain}<span class="orders-portfolio-hint">${esc(totalHint)}</span></div>
        </div>
        <div class="orders-portfolio-grid">
          <div class="orders-portfolio-item">
            <span>持仓市值</span>
            <b>$${(positionsValue || 0).toFixed(2)}</b>
          </div>
          <div class="orders-portfolio-item">
            <span>可用现金</span>
            <b>${cashStr}</b>
          </div>
          <div class="orders-portfolio-item">
            <span>持仓成本</span>
            <b>$${(cost || 0).toFixed(2)}</b>
          </div>
          <div class="orders-portfolio-item ${uCls}">
            <span>浮动盈亏</span>
            <b>${fmtUsd(unrealized)}</b>
          </div>
          <div class="orders-portfolio-item ${rCls}">
            <span>已实现盈亏</span>
            <b>${fmtUsd(realized)}</b>
          </div>
          <div class="orders-portfolio-item">
            <span>持仓笔数</span>
            <b>${openPositions.length}</b>
          </div>
        </div>
      </div>
    `;
  }

  function renderOpenPositions(open) {
    if (!open.length) {
      return '<div class="orders-empty">当前无持仓<br><span style="font-size:12px;margin-top:6px;display:inline-block">买入后数据约数秒内同步</span></div>';
    }

    const rows = open.map((p, idx) => {
      const pnl = p.unrealized ?? 0;
      const pct = p.percentPnl ?? 0;
      const title = esc(p.title || p.label);
      const titleAttr = esc(p.title || p.label);
      const outcome = esc(p.outcome || '');
      const badgeCls = outcomeBadgeClass(p.outcome);
      const iconHtml = renderPositionIcon(p);
      const url = esc(positionUrl(p));
      const pnlCls = pnlClass(pnl);

      return `<div class="orders-pos-row">
        <div class="orders-pos-market">
          ${iconHtml}
          <div class="orders-pos-info">
            <div class="orders-pos-title" title="${titleAttr}">${title}</div>
            <div class="orders-pos-sub">
              <span class="orders-pos-badge ${badgeCls}">${outcome} ${fmtCents(p.avgPrice)}</span>
              <span class="orders-pos-shares">${p.qty.toFixed(1)} 份额</span>
            </div>
          </div>
        </div>
        <div class="orders-pos-col orders-pos-price">${fmtCents(p.avgPrice)} → ${fmtCents(p.markPrice)}</div>
        <div class="orders-pos-col orders-pos-muted">$${(p.cost || 0).toFixed(2)}</div>
        <div class="orders-pos-col orders-pos-muted">$${(p.toWin ?? p.qty ?? 0).toFixed(2)}</div>
        <div class="orders-pos-col orders-pos-value">
          <b>$${(p.marketValue || 0).toFixed(2)}</b>
          <span class="${pnlCls}">${fmtPnlLine(pnl, pct)}</span>
        </div>
        <div class="orders-pos-actions">
          <button type="button" class="btn-sell-pos" data-idx="${idx}">卖出</button>
          <a class="orders-pos-link" href="${url}" target="_blank" rel="noopener" title="在 Polymarket 打开">↗</a>
        </div>
      </div>`;
    });

    return `<div class="orders-pos-table">
      <div class="orders-pos-head">
        <span class="col-mkt">市场</span>
        <span class="col-pr">价格</span>
        <span class="col-bet">投入</span>
        <span class="col-win">可赢</span>
        <span class="col-val">市值</span>
        <span class="col-act"></span>
      </div>
      <div class="orders-pos-list">${rows.join('')}</div>
    </div>`;
  }

  function render() {
    const body = $('ordersBody');
    if (!body || !cache) return;
    const n = (cache.openPositions || []).length;
    body.innerHTML = `
      <div class="orders-section-hd">
        <span>持仓明细</span>
        <em>${n} 笔</em>
      </div>
      ${renderOpenPositions(cache.openPositions || [])}`;
    bindSellButtons();
  }

  async function loadData(opts = {}) {
    const body = $('ordersBody');
    if (!body) return;

    if (!global.PMTrade?.hasWalletAddress?.()) {
      body.innerHTML =
        '<div class="orders-empty">请先连接钱包并填写<strong>代理地址 (Funder)</strong><br><span style="font-size:12px;margin-top:8px;display:inline-block;color:#94a3b8">持仓按代理钱包查询，与 Polymarket 官网一致</span><br><button type="button" class="btn btn-primary" style="margin-top:14px" onclick="PMTrade.toggleWallet();PMOrders.closePanel()">打开钱包</button></div>';
      if ($('ordersPortfolio')) $('ordersPortfolio').innerHTML = '';
      return;
    }

    const hint = opts.afterSell ? '卖出成功，正在更新持仓…' : '正在同步持仓…';
    if ($('ordersPortfolio')) $('ordersPortfolio').innerHTML = '';
    body.innerHTML = `<div class="orders-loading">${hint}</div>`;
    try {
      if (opts.afterSell && opts.soldTokenId != null) {
        await global.PMTrade.refreshAfterSell(opts.soldTokenId);
      }
      const summary = global.PMTrade.fetchPortfolioSummary
        ? await global.PMTrade.fetchPortfolioSummary()
        : null;
      if (!summary) throw new Error('持仓模块未加载');
      cache = summary;
      renderPortfolio(summary);
      render();
    } catch (e) {
      console.error('[我的订单]', e);
      body.innerHTML = `<div class="orders-empty" style="color:#dc2626;border-color:#fecaca">加载失败：${esc(e.message || e)}</div>`;
      global.PMTrade?.toast?.('订单加载失败：' + (e.message || e), 'error');
    }
  }

  function migratePanelDom() {
    $('ordersSummary')?.remove();
    ensurePortfolioSlot();
    const hd = $('myOrdersPanel')?.querySelector('.orders-panel-hd');
    if (hd && !hd.querySelector('.orders-btn-refresh')) {
      hd.innerHTML = `
        <strong>我的持仓</strong>
        <div class="orders-panel-actions">
          <button type="button" class="orders-btn-refresh" onclick="PMOrders.refresh()">刷新</button>
          <button type="button" class="orders-btn-close" onclick="PMOrders.closePanel()" aria-label="关闭">✕</button>
        </div>`;
    }
  }

  function ensurePortfolioSlot() {
    const targetInline = $('portfolioInline');
    const existing = $('ordersPortfolio');

    // 优先展示在页面正文的提示文案下方（5M 页会提供 #portfolioInline）
    if (targetInline) {
      if (existing) {
        if (!targetInline.contains(existing)) targetInline.appendChild(existing);
        return;
      }
      const div = document.createElement('div');
      div.id = 'ordersPortfolio';
      div.className = 'orders-portfolio';
      targetInline.appendChild(div);
      return;
    }

    // 兜底：仍放在“我的持仓”面板顶部
    if (existing || !$('myOrdersPanel')) return;
    const body = $('ordersBody');
    if (!body) return;
    const div = document.createElement('div');
    div.id = 'ordersPortfolio';
    div.className = 'orders-portfolio';
    body.parentNode.insertBefore(div, body);
  }

  function buildUI() {
    if ($('myOrdersFab')) {
      migratePanelDom();
      return;
    }

    const fab = document.createElement('button');
    fab.type = 'button';
    fab.id = 'myOrdersFab';
    fab.className = 'orders-fab';
    fab.innerHTML = '📋';
    fab.title = '我的持仓';
    fab.onclick = togglePanel;
    document.body.appendChild(fab);

    const panel = document.createElement('div');
    panel.id = 'myOrdersPanel';
    panel.className = 'orders-panel';
    panel.innerHTML = `
      <div class="orders-panel-hd">
        <strong>我的持仓</strong>
        <div class="orders-panel-actions">
          <button type="button" class="orders-btn-refresh" onclick="PMOrders.refresh()">刷新</button>
          <button type="button" class="orders-btn-close" onclick="PMOrders.closePanel()" aria-label="关闭">✕</button>
        </div>
      </div>
      <div id="ordersPortfolio" class="orders-portfolio"></div>
      <div id="ordersBody" class="orders-body"></div>
    `;
    document.body.appendChild(panel);

    // 如果页面提供了正文挂载点，则把资产组合卡片挪过去展示
    ensurePortfolioSlot();
  }

  async function onSellClick(btn) {
    if (!btn || btn.disabled) return;
    const p = cache?.openPositions?.[parseInt(btn.dataset.idx, 10)];
    if (!p) return;
    const { tokenId, qty, label, negRisk, markPrice } = p;

    if (!global.PMTrade?.isReady?.()) {
      global.PMTrade?.toast?.('请先连接钱包、私钥和 API Key', 'error');
      global.PMTrade?.toggleWallet?.();
      return;
    }

    const ok = confirm(`确认市价卖出全部持仓？\n${label}\n约 ${qty.toFixed(2)} 份`);
    if (!ok) return;

    btn.disabled = true;
    btn.textContent = '卖出中…';
    const soldTokenId = tokenId;
    try {
      await global.PMTrade.sellPosition({ tokenId, qty, label, negRisk, markPrice });
      if (cache?.openPositions) {
        cache.openPositions = cache.openPositions.filter((x) => String(x.tokenId) !== String(soldTokenId));
        renderPortfolio(cache);
        render();
      }
      global.PMTrade?.toast?.('卖出成功，正在刷新持仓…', 'success');
      await loadData({ afterSell: true, soldTokenId });
    } catch (e) {
      global.PMTrade?.toast?.('卖出失败：' + (e.message || e), 'error', 12000);
      btn.disabled = false;
      btn.textContent = '卖出';
    }
  }

  function bindSellButtons() {
    $('ordersBody')?.querySelectorAll('.btn-sell-pos').forEach((btn) => {
      btn.onclick = () => onSellClick(btn);
    });
  }

  function init() {
    buildUI();
    migratePanelDom();
  }

  global.PMOrders = {
    init,
    togglePanel,
    closePanel,
    refresh: loadData,
    sell: onSellClick,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
