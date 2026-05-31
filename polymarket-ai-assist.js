/**
 * 5M 虚拟投注 · AI 辅助分析（OpenAI 兼容 Chat Completions）
 * 配置存 localStorage pm_5m_ai_assist；请求经本地 markets-server /api/ai/chat 转发
 */
(function (global) {
  const STORAGE_KEY = 'pm_5m_ai_assist';
  const $ = (id) => document.getElementById(id);

  const defaults = {
    enabled: false,
    apiUrl: '',
    apiKey: '',
    model: 'gpt-4o-mini',
    /** gate=AI 说不投则跳过；advise=仅提示仍按策略下单 */
    mode: 'gate',
  };

  function loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...defaults };
      return { ...defaults, ...JSON.parse(raw) };
    } catch {
      return { ...defaults };
    }
  }

  function saveConfig(partial) {
    const next = { ...loadConfig(), ...partial };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    syncForm(next);
    syncStatusEl();
    return next;
  }

  function readForm() {
    const modeEl = $('crypto5mAiMode');
    return {
      enabled: !!$('crypto5mAiEnabled')?.checked,
      apiUrl: ($('crypto5mAiApiUrl')?.value || '').trim(),
      apiKey: ($('crypto5mAiApiKey')?.value || '').trim(),
      model: ($('crypto5mAiModel')?.value || '').trim() || defaults.model,
      mode: modeEl?.value === 'advise' ? 'advise' : 'gate',
    };
  }

  function saveFromForm() {
    const form = readForm();
    const prev = loadConfig();
    const apiKey = form.apiKey || prev.apiKey;
    return saveConfig({ ...form, apiKey });
  }

  function syncForm(cfg) {
    const c = cfg || loadConfig();
    if ($('crypto5mAiEnabled')) $('crypto5mAiEnabled').checked = !!c.enabled;
    if ($('crypto5mAiApiUrl')) $('crypto5mAiApiUrl').value = c.apiUrl || '';
    if ($('crypto5mAiApiKey')) {
      $('crypto5mAiApiKey').value = c.apiKey || '';
      $('crypto5mAiApiKey').placeholder = c.apiKey ? '已保存（留空不改）' : 'sk-...';
    }
    if ($('crypto5mAiModel')) $('crypto5mAiModel').value = c.model || defaults.model;
    if ($('crypto5mAiMode')) $('crypto5mAiMode').value = c.mode === 'advise' ? 'advise' : 'gate';
    syncStatusEl(c);
  }

  function syncStatusEl(cfg) {
    const el = $('crypto5mAiStatus');
    if (!el) return;
    const c = cfg || loadConfig();
    if (!c.enabled) {
      el.textContent = '未启用';
      el.style.color = '#6b7280';
      return;
    }
    if (!c.apiUrl || !c.apiKey) {
      el.textContent = '已启用 · 请填写 API URL 与 Key';
      el.style.color = '#d97706';
      return;
    }
    el.textContent = `已启用 · ${c.mode === 'advise' ? '仅建议' : '拦截不投'} · ${c.model}`;
    el.style.color = '#059669';
  }

  function setStatus(text, color) {
    const el = $('crypto5mAiStatus');
    if (!el) return;
    el.textContent = text;
    el.style.color = color || '#6b7280';
  }

  function isEnabled() {
    const c = loadConfig();
    return !!(c.enabled && c.apiUrl && c.apiKey);
  }

  function isGateMode() {
    return loadConfig().mode !== 'advise';
  }

  function apiBase() {
    if (global.location?.protocol?.startsWith('http')) {
      return `${global.location.protocol}//${global.location.host}`;
    }
    return 'http://localhost:3458';
  }

  async function chatCompletion(messages, opts) {
    const cfg = { ...loadConfig(), ...opts };
    if (!cfg.apiUrl || !cfg.apiKey) {
      throw new Error('请先填写 AI API URL 与 Key 并保存');
    }
    const resp = await fetch(`${apiBase()}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiUrl: cfg.apiUrl,
        apiKey: cfg.apiKey,
        model: cfg.model || defaults.model,
        messages,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data.error || data.detail || `HTTP ${resp.status}`);
    }
    return data.content || '';
  }

  function parseDecision(raw) {
    const text = String(raw || '').trim();
    if (!text) throw new Error('AI 返回为空');
    let json = null;
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fence ? fence[1].trim() : text;
    try {
      json = JSON.parse(candidate);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          json = JSON.parse(m[0]);
        } catch {
          /* fall through */
        }
      }
    }
    if (json && typeof json === 'object') {
      const d = String(json.decision || json.action || '').toLowerCase();
      const decision =
        d === 'bet' || d === 'yes' || d === 'buy' || d === '投' || d === '投注'
          ? 'bet'
          : d === 'skip' || d === 'no' || d === 'hold' || d === '不投' || d === '跳过'
            ? 'skip'
            : null;
      if (decision) {
        const factors = Array.isArray(json.keyFactors)
          ? json.keyFactors.map(String).slice(0, 5)
          : json.keyFactors
            ? [String(json.keyFactors)]
            : [];
        return {
          decision,
          reason: String(json.reason || json.summary || json.explanation || '').trim() || text.slice(0, 200),
          confidence: json.confidence,
          keyFactors: factors,
          raw: text,
        };
      }
    }
    const lower = text.toLowerCase();
    if (/不投|跳过|skip|hold|观望|不建议/.test(text) && !/建议投|可以投|bet/.test(lower)) {
      return { decision: 'skip', reason: text.slice(0, 280), raw: text };
    }
    if (/投注|可以投|建议投|bet|buy/.test(lower)) {
      return { decision: 'bet', reason: text.slice(0, 280), raw: text };
    }
    return { decision: 'skip', reason: 'AI 回复无法解析，默认不投：' + text.slice(0, 120), raw: text };
  }

  function buildVirtualBetPrompt(analysis, extra) {
    const ctx =
      extra?.context ||
      global.Crypto5M?.buildVirtualAiContext?.(analysis) || {
        strategySummary: extra?.strategySummary || '共识90',
        consensus: {
          triggerSides: analysis?.triggerSides || [],
          candidateCount: (analysis?.candidates || []).length,
          skipReason: analysis?.skipReason || null,
        },
        slotRemainingSec:
          analysis?.slotRemMs != null ? Math.round(analysis.slotRemMs / 1000) : null,
        virtualWallet: { bankrollUsd: extra?.bankroll },
        allMarkets: extra?.markets || [],
        candidates: (analysis?.candidates || []).map((pick) => ({
          title: (pick.ev?.title || '').slice(0, 48),
          betSide: pick.side,
          entryCents: pick.price != null ? Math.round(pick.price * 100) : null,
        })),
      };

    return (
      `你是 Polymarket 加密 5 分钟 Up/Down 市场的虚拟投注风控分析师。\n` +
      `请综合下方**全部市场数据与策略参数**，判断本时间槽是否应对候选列表执行虚拟模拟投注。\n\n` +
      `## 评估要点（请逐项考虑）\n` +
      `1. 共识强度：triggerSides、同边≥triggerCents 的市场数量、holdMinCents 是否仍≥triggerMin\n` +
      `2. 分歧/弱化：skipReason、weakened、slotDivergence（任一同边极低价差）\n` +
      `3. 时间窗口：slotRemainingSec 是否大于 strategy.minSlotRemSec\n` +
      `4. 候选质量：entryCents 是否在 entryMin~entryMax；spread、盘口深度\n` +
      `5. 流动性：volume24hUsd、openInterestUsd、liquidityUsd\n` +
      `6. 马尔可夫：各市场 probStay、localLeader 是否与 betSide 一致\n` +
      `7. 现货参考：targetPriceUsd vs spotPriceUsd（若有）\n` +
      `8. 虚拟账户：bankrollUsd 是否够付 estDebitUsd×候选数；近期连亏\n` +
      `9. 风控规则：virtualRiskRules 止盈止损参数\n\n` +
      `## 策略摘要\n${ctx.strategySummary || '—'}\n\n` +
      `## 结构化数据（JSON）\n` +
      `${JSON.stringify(ctx, null, 2)}\n\n` +
      `## 输出要求\n` +
      `仅返回 JSON，不要其它文字：\n` +
      `{\n` +
      `  "decision": "bet" | "skip",\n` +
      `  "reason": "一句话中文结论",\n` +
      `  "confidence": 0.0-1.0,\n` +
      `  "keyFactors": ["因素1", "因素2", "因素3"]\n` +
      `}\n` +
      `decision=bet：同意按 candidates 列表虚拟投注；skip：本槽不投。信号矛盾、共识不稳、槽末时间不足、流动性差、马尔可夫与方向冲突、余额不足时倾向 skip。`
    );
  }

  async function analyzeVirtualBet(analysis, extra) {
    const userContent = buildVirtualBetPrompt(analysis, extra);
    const content = await chatCompletion([
      {
        role: 'system',
        content:
          '你是审慎的量化交易风控助手。必须基于用户提供的结构化 JSON 数据做判断，不得臆造未提供的价格或指标。输出必须是合法 JSON。',
      },
      { role: 'user', content: userContent },
    ]);
    return parseDecision(content);
  }

  function formatDecisionToast(result) {
    const conf =
      result.confidence != null && !Number.isNaN(Number(result.confidence))
        ? `（置信 ${Math.round(Number(result.confidence) * 100)}%）`
        : '';
    const factors =
      result.keyFactors?.length ? `\n要点：${result.keyFactors.slice(0, 3).join('；')}` : '';
    return `${result.reason || ''}${conf}${factors}`;
  }

  async function testConnection() {
    saveFromForm();
    setStatus('测试中…', '#2563eb');
    try {
      const content = await chatCompletion([
        { role: 'user', content: 'Reply with JSON only: {"pong":true}' },
      ]);
      if (!content) throw new Error('空响应');
      setStatus('连接成功', '#059669');
      global.PMTrade?.toast?.('AI 连接测试成功', 'success');
      return true;
    } catch (e) {
      setStatus('连接失败：' + (e.message || e), '#dc2626');
      global.PMTrade?.toast?.('AI 连接失败：' + (e.message || e), 'error', 10000);
      return false;
    }
  }

  function parseAuditReport(raw) {
    const text = String(raw || '').trim();
    if (!text) throw new Error('AI 返回为空');
    let json = null;
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fence ? fence[1].trim() : text;
    try {
      json = JSON.parse(candidate);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          json = JSON.parse(m[0]);
        } catch {
          /* fall through */
        }
      }
    }
    if (json && typeof json === 'object') {
      return {
        summary: String(json.summary || json.conclusion || json.结论 || '').trim(),
        patterns: [].concat(json.patterns || json.模式 || []).map(String).slice(0, 8),
        rootCauses: [].concat(json.rootCauses || json.root_causes || json.原因 || []).map(String).slice(0, 8),
        recommendations: [].concat(json.recommendations || json.suggestions || json.建议 || [])
          .map(String)
          .slice(0, 8),
        riskLevel: json.riskLevel || json.risk_level || null,
        raw: text,
      };
    }
    return {
      summary: text.slice(0, 500),
      patterns: [],
      rootCauses: [],
      recommendations: [],
      raw: text,
    };
  }

  function renderAuditReportHtml(report) {
    const esc = (s) =>
      String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    let html = `<div class="ai-audit-summary"><strong>结论</strong><p>${esc(report.summary || '—')}</p></div>`;
    if (report.patterns?.length) {
      html += `<div class="ai-audit-block"><strong>重复模式</strong><ul>${report.patterns.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>`;
    }
    if (report.rootCauses?.length) {
      html += `<div class="ai-audit-block"><strong>主要原因</strong><ul>${report.rootCauses.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>`;
    }
    if (report.recommendations?.length) {
      html += `<div class="ai-audit-block"><strong>改进建议</strong><ul>${report.recommendations.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>`;
    }
    return html;
  }

  function showAuditReport(report) {
    const box = $('crypto5mAiAuditResult');
    if (box) {
      box.innerHTML = renderAuditReportHtml(report);
      box.hidden = false;
    }
    const lines = [report.summary || ''];
    if (report.patterns?.length) lines.push('模式：' + report.patterns.slice(0, 2).join('；'));
    if (report.recommendations?.length) lines.push('建议：' + report.recommendations[0]);
    global.PMTrade?.toast?.('AI 亏损审计\n' + lines.filter(Boolean).join('\n'), 'info', 15000);
  }

  async function auditLosingOrders() {
    saveFromForm();
    if (!isEnabled()) {
      global.PMTrade?.toast?.('请先启用 AI 并填写 URL / Key', 'warn');
      return null;
    }
    const payload = global.Crypto5M?.buildVirtualLossAuditPayload?.(40);
    if (!payload) {
      global.PMTrade?.toast?.('无法读取虚拟订单数据', 'error');
      return null;
    }
    if (!payload.losingOrders?.length) {
      setStatus('暂无亏损订单', '#6b7280');
      global.PMTrade?.toast?.('当前没有已结算的亏损虚拟订单', 'info');
      return null;
    }
    setStatus(`审计中…（${payload.losingOrders.length} 笔亏损）`, '#2563eb');
    const userContent =
      `你是 Polymarket 5 分钟虚拟投注复盘分析师。请审计以下**亏损订单**与统计数据，找出共性原因并给出可执行建议。\n\n` +
      `## 关注\n` +
      `- 共识批量同向下单是否放大亏损\n` +
      `- 入场价区间（70-98¢）与收盘反转\n` +
      `- 止损 vs 槽末结算（结果=止损/输）\n` +
      `- 槽剩余时间（placedSlotRemSec）是否过晚\n` +
      `- 方向与 winner 反转（reversed=true）\n\n` +
      `## 数据 JSON\n${JSON.stringify(payload, null, 2)}\n\n` +
      `仅返回 JSON：\n` +
      `{"summary":"一段话总结结论","patterns":["…"],"rootCauses":["…"],"recommendations":["…"],"riskLevel":"低|中|高"}`;
    try {
      const content = await chatCompletion([
        {
          role: 'system',
          content: '你是量化交易复盘专家。基于数据客观分析，不臆造订单。输出合法 JSON。',
        },
        { role: 'user', content: userContent },
      ]);
      const report = parseAuditReport(content);
      setStatus('审计完成', '#059669');
      showAuditReport(report);
      return report;
    } catch (e) {
      setStatus('审计失败：' + (e.message || e), '#dc2626');
      global.PMTrade?.toast?.('AI 审计失败：' + (e.message || e), 'error', 10000);
      return null;
    }
  }

  async function analyzeNow() {
    saveFromForm();
    if (!isEnabled()) {
      global.PMTrade?.toast?.('请先启用 AI 并填写 URL / Key', 'warn');
      return null;
    }
    const debug = global.Crypto5M?.debugVirtualConsensus?.();
    if (!debug) {
      global.PMTrade?.toast?.('无法获取当前虚拟共识状态', 'error');
      return null;
    }
    const analysis = {
      triggerSides: debug.triggerSides || [],
      triggerSide: debug.triggerSide,
      candidates: debug.candidates || [],
      skipReason: debug.skipReason,
      slotRemMs: debug.slotRemMs,
      weakened: debug.weakened,
      slotDivergence: debug.slotDivergence,
      activeN: debug.activeN,
    };
    setStatus('分析中…', '#2563eb');
    try {
      const result = await analyzeVirtualBet(analysis, {
        context: global.Crypto5M?.buildVirtualAiContext?.(analysis),
      });
      const label = result.decision === 'bet' ? '建议投注' : '建议不投';
      setStatus(`${label}：${result.reason}`, result.decision === 'bet' ? '#059669' : '#d97706');
      global.PMTrade?.toast?.(
        `AI ${label}\n${formatDecisionToast(result)}`,
        result.decision === 'bet' ? 'info' : 'warn',
        12000,
      );
      return result;
    } catch (e) {
      setStatus('分析失败：' + (e.message || e), '#dc2626');
      global.PMTrade?.toast?.('AI 分析失败：' + (e.message || e), 'error', 10000);
      return null;
    }
  }

  global.PMAiAssist = {
    loadConfig,
    saveConfig,
    saveFromForm,
    syncForm,
    syncStatusEl,
    setStatus,
    readForm,
    isEnabled,
    isGateMode,
    analyzeVirtualBet,
    analyzeNow,
    auditLosingOrders,
    parseAuditReport,
    testConnection,
    buildVirtualBetPrompt,
    parseDecision,
    formatDecisionToast,
  };
})(window);
