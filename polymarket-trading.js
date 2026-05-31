/**
 * Polymarket CLOB 钱包连接 + 批量市价单（FOK）
 * 依赖: ethers v5, 页面提供 window.pmGetMarket(id)
 */
(function (global) {
  const CLOB_HOST = 'https://clob.polymarket.com';
  const DEFAULT_ORDER_USDC = 1;
  const CTF_EXCHANGE = '0xE111180000d2663C0091e4f400237545B87B996B';
  const NEG_RISK_EXCHANGE = '0xe2222d279d744050d28e00520010520000310F59';

  let serverTimeOffset = 0;
  let walletState = {
    address: null,
    pk: null,
    apiKey: null,
    apiSecret: null,
    apiPass: null,
    funder: null,
    sigType: 1,
    relayerApiKey: null,
    relayerApiKeyAddress: null,
    orderUsdc: DEFAULT_ORDER_USDC,
  };
  const minOrderSizeCache = new Map();
  const feeRateCache = new Map();
  /** 加密 5M/15M 默认 taker 费率系数（官网公式 fee = C×rate×p×(1-p)） */
  const CRYPTO_TAKER_FEE_RATE = 0.07;
  const BUY_SLIPPAGE_MULT = 1.02;
  let extSigner = null;

  const $ = (id) => document.getElementById(id);

  /** @param {'info'|'success'|'error'|'warn'|'buy'|'tp'|'sl'} type — buy 蓝 / tp 绿 / sl 红 */
  function toast(msg, type = 'info', durationMs) {
    const wrap = $('toastWrap');
    if (!wrap) return alert(msg);
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    wrap.appendChild(el);
    const ms =
      durationMs ?? (type === 'error' || type === 'sl' ? 10000 : type === 'buy' || type === 'tp' ? 9000 : 5000);
    setTimeout(() => el.remove(), ms);
  }

  /** 买入 / 止盈 / 止损 专用配色 */
  function toastTrade(msg, action, durationMs) {
    const map = { 买入: 'buy', buy: 'buy', 止盈: 'tp', tp: 'tp', 止损: 'sl', sl: 'sl' };
    toast(msg, map[action] || 'info', durationMs);
  }

  /** 将 CLOB / 网络错误转为可读中文说明 */
  function formatOrderError(err, httpStatus, apiBody, respText) {
    let raw = '';
    if (apiBody && typeof apiBody === 'object') {
      raw =
        apiBody.errorMsg ||
        apiBody.error ||
        apiBody.message ||
        apiBody.detail ||
        (Array.isArray(apiBody.errors) ? apiBody.errors.join('; ') : '');
    }
    if (!raw && typeof apiBody === 'string') raw = apiBody;
    if (!raw && respText) {
      try {
        const j = JSON.parse(respText);
        raw = j.errorMsg || j.error || j.message || respText.slice(0, 300);
      } catch {
        raw = respText.slice(0, 300);
      }
    }
    if (!raw && err) raw = err.message || String(err);
    raw = String(raw || '').trim();
    const s = raw.toLowerCase();

    if (s.includes('invalid api key') || s.includes('unauthorized') || httpStatus === 401) {
      return 'API Key 认证失败：请检查 Key / Secret / Passphrase，或点击「获取 API Key」重新生成';
    }
    if (httpStatus === 403) return '无权限 (HTTP 403)';
    if (httpStatus === 429) return '请求过于频繁 (HTTP 429)，请稍后重试';
    if (httpStatus >= 500) return `CLOB 服务器错误 (HTTP ${httpStatus})`;
    if (s.includes('not enough balance') || s.includes('insufficient') || s.includes('balance')) {
      return '余额不足：代理钱包 USDC 不够，或卖出时持仓不足';
    }
    if (s.includes('fok') || s.includes('fully filled') || (s.includes('fill') && s.includes('kill'))) {
      return '市价单未成交：FOK 订单在盘口无法完全成交（流动性不足或价格变动过快）';
    }
    if (s.includes('invalid_order_min_size') || (s.includes('min') && s.includes('size'))) {
      return '下单份数低于该市场最小限制（通常约 5 份）。$1 在高价侧（如 90¢+）约仅 1 份，需约 $5×价格 才能满足；或改用官网 Split $1（Up+Down 各 1 份）';
    }
    if (s.includes('invalid signature') || s.includes('signature')) {
      return '订单签名无效：检查私钥、签名类型(sigType) 与代理地址(Funder)是否匹配';
    }
    if (s.includes('market not found') || s.includes('市场未找到')) {
      return '市场不存在或已关闭';
    }
    if (s.includes('invalid length for bytes32') || (s.includes('bytes32') && s.includes('invalid'))) {
      return '订单字段编码错误（bytes32），请刷新页面后重试';
    }
    if (s.includes('token') && s.includes('invalid')) return 'Token ID 无效，请刷新市场后重试';
    if (s.includes('nonce')) return 'Nonce 错误，请重试';
    if (s.includes('price') && s.includes('invalid')) return '价格无效，当前盘口价格可能为 0 或 1';
    if (s.includes('network') || s.includes('failed to fetch') || s.includes('abort')) {
      return '网络错误：无法连接 clob.polymarket.com，请检查网络或代理';
    }
    if (raw) return raw;
    if (httpStatus) return `下单被拒绝 (HTTP ${httpStatus})`;
    return '未知错误';
  }

  function marketLabel(marketId) {
    const m = global.pmGetMarket?.(marketId);
    const t = (m && m.title) || '';
    return t.length > 36 ? t.slice(0, 36) + '…' : t || `ID ${marketId}`;
  }

  function saveWallet() {
    localStorage.setItem('pm_wallet', JSON.stringify({ ...walletState, pk: walletState.pk || '' }));
  }

  function loadWallet() {
    try {
      const d = JSON.parse(localStorage.getItem('pm_wallet') || '{}');
      walletState = { ...walletState, ...d };
      if ($('pkInput')) $('pkInput').value = d.pk || '';
      if ($('apiKeyInput')) $('apiKeyInput').value = d.apiKey || '';
      if ($('apiSecretInput')) $('apiSecretInput').value = d.apiSecret || '';
      if ($('apiPassInput')) $('apiPassInput').value = d.apiPass || '';
      if ($('funderInput')) $('funderInput').value = d.funder || '';
      if ($('relayerKeyInput')) $('relayerKeyInput').value = d.relayerApiKey || '';
      if ($('relayerAddrInput')) $('relayerAddrInput').value = d.relayerApiKeyAddress || '';
      if ($('orderAmtInput')) {
        $('orderAmtInput').value = String(d.orderUsdc ?? DEFAULT_ORDER_USDC);
      }
      walletState.orderUsdc = parseOrderAmount(d.orderUsdc);
      if ($('sigTypeSelect')) $('sigTypeSelect').value = String(d.sigType ?? 1);
      if (d.address) updateWalletUI(d.address, d.funder);
    } catch (_) {}
  }

  function resetWalletUI() {
    if ($('walletStatus')) {
      $('walletStatus').textContent = '未连接';
      $('walletStatus').style.color = '#6b7280';
    }
    if ($('walletAddr')) $('walletAddr').style.display = 'none';
    if ($('funderAddr')) $('funderAddr').style.display = 'none';
    if ($('walletBtn')) {
      $('walletBtn').textContent = '钱包 / 交易';
      $('walletBtn').classList.remove('connected');
    }
    if ($('pkInput')) $('pkInput').value = '';
    if ($('apiKeyInput')) $('apiKeyInput').value = '';
    if ($('apiSecretInput')) $('apiSecretInput').value = '';
    if ($('apiPassInput')) $('apiPassInput').value = '';
    if ($('funderInput')) $('funderInput').value = '';
    if ($('relayerKeyInput')) $('relayerKeyInput').value = '';
    if ($('relayerAddrInput')) $('relayerAddrInput').value = '';
    if ($('orderAmtInput')) $('orderAmtInput').value = String(DEFAULT_ORDER_USDC);
    if ($('sigTypeSelect')) $('sigTypeSelect').value = '1';
  }

  function clearWalletCache() {
    localStorage.removeItem('pm_wallet');
    walletState = {
      address: null,
      pk: null,
      apiKey: null,
      apiSecret: null,
      apiPass: null,
      funder: null,
      sigType: 1,
      relayerApiKey: null,
      relayerApiKeyAddress: null,
      orderUsdc: DEFAULT_ORDER_USDC,
    };
    extSigner = null;
    resetWalletUI();
  }

  function updateWalletUI(addr, funder) {
    if ($('walletStatus')) {
      $('walletStatus').textContent = '已连接';
      $('walletStatus').style.color = '#16a34a';
    }
    if ($('walletAddr')) {
      $('walletAddr').textContent = 'EOA: ' + addr.slice(0, 6) + '…' + addr.slice(-4);
      $('walletAddr').style.display = 'inline';
    }
    if ($('funderAddr') && funder) {
      $('funderAddr').textContent = '代理: ' + funder.slice(0, 6) + '…' + funder.slice(-4);
      $('funderAddr').style.display = 'inline';
    }
    if ($('walletBtn')) {
      $('walletBtn').textContent = '钱包已连接';
      $('walletBtn').classList.add('connected');
    }
  }

  function toggleWallet() {
    $('walletPanel')?.classList.toggle('open');
  }

  async function getSignerWallet() {
    if (walletState.pk) {
      let pk = walletState.pk.trim();
      if (!pk.startsWith('0x')) pk = '0x' + pk;
      return new ethers.Wallet(pk);
    }
    if (extSigner) return extSigner;
    throw new Error('请先连接钱包或填写私钥（用于 EIP-712 签名）');
  }

  async function connectWallet() {
    if (typeof ethers === 'undefined') {
      toast('ethers.js 未加载', 'error');
      return;
    }
    const pk = $('pkInput')?.value.trim();
    if (!pk) {
      toast('请输入私钥，或使用 MetaMask 连接', 'error');
      return;
    }
    let normalizedPk = pk.startsWith('0x') ? pk : '0x' + pk;
    const wallet = new ethers.Wallet(normalizedPk);
    walletState.pk = normalizedPk;
    walletState.address = wallet.address;
    walletState.apiKey = $('apiKeyInput')?.value.trim() || walletState.apiKey;
    walletState.apiSecret = $('apiSecretInput')?.value.trim() || walletState.apiSecret;
    walletState.apiPass = $('apiPassInput')?.value.trim() || walletState.apiPass;
    const funder = $('funderInput')?.value.trim();
    walletState.funder = funder ? (funder.startsWith('0x') ? funder : '0x' + funder) : null;
    walletState.relayerApiKey = $('relayerKeyInput')?.value.trim() || walletState.relayerApiKey || null;
    const relAddr = $('relayerAddrInput')?.value.trim();
    walletState.relayerApiKeyAddress = relAddr
      ? relAddr.startsWith('0x')
        ? relAddr
        : '0x' + relAddr
      : walletState.address;
    walletState.sigType = parseInt($('sigTypeSelect')?.value, 10) || 1;
    walletState.orderUsdc = readOrderAmountFromInput();
    extSigner = null;
    saveWallet();
    updateWalletUI(wallet.address, walletState.funder);
    toast('钱包已连接', 'success');
  }

  async function connectMetaMask() {
    if (typeof ethers === 'undefined') {
      toast('ethers.js 未加载', 'error');
      return;
    }
    const eth = global.ethereum;
    if (!eth) {
      toast('未检测到 MetaMask', 'error');
      return;
    }
    try {
      const provider = new ethers.providers.Web3Provider(eth);
      await provider.send('eth_requestAccounts', []);
      const address = ethers.utils.getAddress(await provider.getSigner().getAddress());
      walletState.address = address;
      saveWallet();
      updateWalletUI(address, walletState.funder);
      toast(
        `MetaMask 地址 ${address.slice(0, 6)}…${address.slice(-4)}\n下单请在上方填写私钥并点击「保存并连接」`,
        'success',
        9000,
      );
    } catch (e) {
      if (e?.code === 4001) toast('已取消 MetaMask 授权', 'warn');
      else toast('MetaMask 连接失败：' + (e.message || e), 'error');
    }
  }

  async function signL1Auth(wallet, address, timestamp, nonce) {
    const domain = { name: 'ClobAuthDomain', version: '1', chainId: 137 };
    const types = {
      ClobAuth: [
        { name: 'address', type: 'address' },
        { name: 'timestamp', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'message', type: 'string' },
      ],
    };
    const value = {
      address,
      timestamp,
      nonce,
      message: 'This message attests that I control the given wallet',
    };
    return wallet._signTypedData(domain, types, value);
  }

  async function deriveApiKey() {
    const wallet = await getSignerWallet();
    const address = wallet.address;
    const ts1 = Math.floor(Date.now() / 1000).toString();
    const nonce = '0';
    const sig1 = await signL1Auth(wallet, address, ts1, nonce);
    let data;
    try {
      const resp = await fetch(CLOB_HOST + '/auth/api-key', {
        method: 'POST',
        headers: {
          POLY_ADDRESS: address,
          POLY_SIGNATURE: sig1,
          POLY_TIMESTAMP: ts1,
          POLY_NONCE: nonce,
          'Content-Type': 'application/json',
        },
      });
      data = await resp.json();
      if (!resp.ok || !data.apiKey) throw new Error('derive');
    } catch {
      const ts2 = Math.floor(Date.now() / 1000).toString();
      const sig2 = await signL1Auth(wallet, address, ts2, nonce);
      const resp2 = await fetch(CLOB_HOST + '/auth/derive-api-key', {
        method: 'GET',
        headers: {
          POLY_ADDRESS: address,
          POLY_SIGNATURE: sig2,
          POLY_TIMESTAMP: ts2,
          POLY_NONCE: nonce,
        },
      });
      if (!resp2.ok) throw new Error('获取 API Key 失败 HTTP ' + resp2.status);
      data = await resp2.json();
    }
    let apiKeyStr, apiSecretStr, apiPassStr;
    if (Array.isArray(data.apiKey)) {
      const first = data.apiKey[0];
      apiKeyStr = first.key || first.apiKey;
      apiSecretStr = first.secret;
      apiPassStr = first.passphrase;
    } else {
      apiKeyStr = data.apiKey;
      apiSecretStr = data.secret;
      apiPassStr = data.passphrase;
    }
    walletState.address = address;
    walletState.apiKey = apiKeyStr;
    walletState.apiSecret = apiSecretStr;
    walletState.apiPass = apiPassStr;
    if ($('apiKeyInput')) $('apiKeyInput').value = apiKeyStr;
    if ($('apiSecretInput')) $('apiSecretInput').value = apiSecretStr;
    if ($('apiPassInput')) $('apiPassInput').value = apiPassStr || '';
    saveWallet();
    toast('API Key 已获取', 'success');
  }

  async function fetchProxyAddress(opts = {}) {
    const silent = !!opts.silent;
    const wallet = await getSignerWallet();
    const address = wallet.address;
    const ts = Math.floor(Date.now() / 1000).toString();
    const nonce = '0';
    const sig = await signL1Auth(wallet, address, ts, nonce);
    const resp = await fetch(CLOB_HOST + '/register', {
      method: 'GET',
      headers: { POLY_ADDRESS: address, POLY_SIGNATURE: sig, POLY_TIMESTAMP: ts, POLY_NONCE: nonce },
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    const proxy = data.proxy_address || data.proxyAddress || data.funder;
    if (!proxy || proxy.toLowerCase() === address.toLowerCase()) {
      if (!silent) toast('未找到代理地址，请手动填写', 'error');
      return null;
    }
    walletState.funder = proxy;
    walletState.sigType = 1;
    if ($('funderInput')) $('funderInput').value = proxy;
    if ($('sigTypeSelect')) $('sigTypeSelect').value = '1';
    saveWallet();
    updateWalletUI(address, proxy);
    if (!silent) toast('已获取代理地址', 'success');
    return proxy;
  }

  async function hmacSign(secretB64, message) {
    let normalized = secretB64.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/=]/g, '');
    const pad = normalized.length % 4;
    if (pad > 0) normalized += '='.repeat(4 - pad);
    const secretBytes = Uint8Array.from(atob(normalized), (c) => c.charCodeAt(0));
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
    let binary = '';
    new Uint8Array(sig).forEach((b) => (binary += String.fromCharCode(b)));
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_');
  }

  async function syncServerTime() {
    try {
      const resp = await fetch(CLOB_HOST + '/time');
      const data = await resp.json();
      const serverTs = parseInt(data.timestamp || data, 10);
      if (serverTs) serverTimeOffset = serverTs - Math.floor(Date.now() / 1000);
    } catch (_) {}
  }

  /** CLOB L2 签名只用 path，不含 query（与官方 py-clob-client 一致） */
  async function clobAuthenticatedGet(signPath, queryParams = {}) {
    const qs = new URLSearchParams(queryParams).toString();
    const url = signPath + (qs ? '?' + qs : '');
    const headers = await getL2Headers('GET', signPath);
    return fetch(CLOB_HOST + url, { headers });
  }

  async function getL2Headers(method, path, body = '') {
    if (!walletState.apiKey || !walletState.apiSecret) throw new Error('请先获取 API Key');
    const timestamp = (Math.floor(Date.now() / 1000) + serverTimeOffset).toString();
    const message = timestamp + method + path + body;
    return {
      POLY_ADDRESS: walletState.address,
      POLY_API_KEY: walletState.apiKey,
      POLY_SIGNATURE: await hmacSign(walletState.apiSecret, message),
      POLY_TIMESTAMP: timestamp,
      POLY_PASSPHRASE: walletState.apiPass || '',
      'Content-Type': 'application/json',
    };
  }

  function getMaxOutcome(outcomes, prices) {
    let top = 0;
    let idx = 0;
    outcomes.forEach((_, i) => {
      const p = +prices[i] || 0;
      if (p > top) {
        top = p;
        idx = i;
      }
    });
    return { prob: top, index: idx };
  }

  function parseOrderAmount(val) {
    const n = parseFloat(val);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_ORDER_USDC;
    return Math.round(n * 100) / 100;
  }

  function readOrderAmountFromInput() {
    return parseOrderAmount($('orderAmtInput')?.value);
  }

  function getOrderProfile() {
    return global.pmOrderProfile || {};
  }

  function getOrderAmount() {
    const fixed = getOrderProfile().fixedUsdc;
    if (fixed > 0) return fixed;
    if ($('orderAmtInput')) {
      walletState.orderUsdc = readOrderAmountFromInput();
    }
    const n = parseOrderAmount(walletState.orderUsdc);
    walletState.orderUsdc = n;
    return n;
  }

  function bindOrderAmountInput() {
    const el = $('orderAmtInput');
    if (!el || el._pmBound) return;
    el._pmBound = true;
    const sync = () => {
      walletState.orderUsdc = readOrderAmountFromInput();
      saveWallet();
    };
    el.addEventListener('change', sync);
    el.addEventListener('blur', sync);
  }

  const ROUNDING_CONFIG = {
    '0.1': { price: 1, size: 2, amount: 3 },
    '0.01': { price: 2, size: 2, amount: 4 },
    '0.001': { price: 3, size: 2, amount: 5 },
    '0.0001': { price: 4, size: 2, amount: 6 },
  };

  function roundDown(num, decimals) {
    const f = 10 ** decimals;
    return Math.floor((num + Number.EPSILON) * f) / f;
  }

  function roundUp(num, decimals) {
    const f = 10 ** decimals;
    return Math.ceil((num - Number.EPSILON) * f) / f;
  }

  function decimalPlaces(num) {
    if (!Number.isFinite(num)) return 0;
    const s = String(num);
    const i = s.indexOf('.');
    return i < 0 ? 0 : s.length - i - 1;
  }

  /** 与 Polymarket 官方 createMarketOrder 一致：BUY 的 amount 为美元，SELL 的 amount 为份数 */
  function getMarketOrderRawAmounts(side, amount, price, tickSize) {
    const cfg = ROUNDING_CONFIG[tickSize] || ROUNDING_CONFIG['0.01'];
    const rawPrice = roundDown(price, cfg.price);
    if (side === 'BUY') {
      const rawMakerAmt = roundDown(amount, cfg.size);
      let rawTakerAmt = rawMakerAmt / rawPrice;
      if (decimalPlaces(rawTakerAmt) > cfg.amount) {
        rawTakerAmt = roundUp(rawTakerAmt, cfg.amount + 4);
        if (decimalPlaces(rawTakerAmt) > cfg.amount) {
          rawTakerAmt = roundDown(rawTakerAmt, cfg.amount);
        }
      }
      return { rawMakerAmt, rawTakerAmt };
    }
    const rawMakerAmt = roundDown(amount, cfg.size);
    let rawTakerAmt = rawMakerAmt * rawPrice;
    if (decimalPlaces(rawTakerAmt) > cfg.amount) {
      rawTakerAmt = roundUp(rawTakerAmt, cfg.amount + 4);
      if (decimalPlaces(rawTakerAmt) > cfg.amount) {
        rawTakerAmt = roundDown(rawTakerAmt, cfg.amount);
      }
    }
    return { rawMakerAmt, rawTakerAmt };
  }

  function computeMarketOrderSize(side, amount, worstPrice, tickSize, opts = {}) {
    const cfg = ROUNDING_CONFIG[tickSize] || ROUNDING_CONFIG['0.01'];
    let amt;
    if (side === 'BUY') {
      amt = amount;
    } else if (opts.amountIsShares) {
      amt = roundDown(amount, cfg.size);
    } else {
      amt = roundDown(amount / worstPrice, cfg.size);
    }
    const { rawMakerAmt, rawTakerAmt } = getMarketOrderRawAmounts(side, amt, worstPrice, tickSize);
    if (rawMakerAmt <= 0 || rawTakerAmt <= 0) throw new Error('订单数量无效');
    return {
      makerAmount: ethers.utils.parseUnits(String(rawMakerAmt), 6),
      takerAmount: ethers.utils.parseUnits(String(rawTakerAmt), 6),
    };
  }

  async function fetchMinOrderSize(tokenId) {
    if (minOrderSizeCache.has(tokenId)) return minOrderSizeCache.get(tokenId);
    let min = 5;
    try {
      const book = await fetchClobBook(tokenId);
      const v = parseFloat(book?.min_order_size);
      if (v > 0) min = v;
    } catch (_) {}
    minOrderSizeCache.set(tokenId, min);
    return min;
  }

  /** 订单簿 BUY：保证至少 min_order_size 份（$0.5 在 50¢ 时只有 1 份会失败） */
  async function adjustBuyUsdForMinSize(tokenId, amountUsd, worstPrice) {
    const price = worstPrice > 0 && worstPrice < 1 ? worstPrice : 0.5;
    const minShares = await fetchMinOrderSize(tokenId);
    const shares = amountUsd / price;
    if (shares + 1e-9 >= minShares) return { usd: amountUsd, bumped: false, minShares };
    const usd = Math.ceil(minShares * price * 100) / 100;
    return { usd, bumped: true, minShares };
  }

  /** 官网 taker 手续费：fee = C × feeRate × p × (1-p)，保留 5 位小数 */
  function calcTakerFeeUsdc(shares, price, feeRate) {
    const C = +shares || 0;
    const p = price > 0 && price < 1 ? price : 0.5;
    const rate = feeRate > 0 ? feeRate : CRYPTO_TAKER_FEE_RATE;
    const raw = C * rate * p * (1 - p);
    return Math.round(raw * 1e5) / 1e5;
  }

  async function fetchFeeRate(tokenId, categoryHint = 'crypto') {
    const key = String(tokenId || categoryHint);
    if (feeRateCache.has(key)) return feeRateCache.get(key);
    let rate = CRYPTO_TAKER_FEE_RATE;
    if (tokenId) {
      try {
        const r = await fetch(CLOB_HOST + '/fee-rate?token_id=' + encodeURIComponent(tokenId));
        if (r.ok) {
          const j = await r.json();
          const v = parseFloat(j.fee_rate ?? j.feeRate ?? j.base_fee ?? j.r);
          if (v > 0 && v < 1) rate = v;
        }
      } catch (_) {}
    }
    feeRateCache.set(key, rate);
    return rate;
  }

  function formatBuyEstimateLine(est) {
    if (!est) return '';
    const slip =
      est.marketPrice > 0 ? `滑点保护 ${Math.round(est.marketPrice * 100)}→${Math.round(est.worstPrice * 100)}¢` : '';
    const fee = `手续费 $${est.feeUsdc.toFixed(5)}`;
    const min = est.meetsMinSize
      ? ''
      : ` · 约${est.shares.toFixed(2)}份 < 最少${est.minShares}份（CLOB 可能拒单）`;
    return `${est.shares.toFixed(4)} 份 · 成本 $${est.costUsdc.toFixed(2)} + ${fee} = 扣款 $${est.totalDebit.toFixed(4)}${slip ? ' · ' + slip : ''}${min}`;
  }

  /**
   * 单边 $1 市价买入估算：订单簿滑点 + CLOB 份数舍入 + 加密 taker 费
   * @param {string} [tokenId] 有则拉订单簿/费率/min_size
   */
  async function estimateMarketBuyDetailed(amountUsd, tokenId, opts = {}) {
    const budget = amountUsd > 0 ? amountUsd : getOrderAmount();
    let marketPrice = opts.markPrice;
    let worstPrice = opts.worstPrice;
    let fromBook = false;

    if (tokenId && (!marketPrice || !worstPrice)) {
      const quote = await resolveMarketQuote(tokenId, 'BUY', budget);
      marketPrice = quote.marketPrice;
      worstPrice = quote.worstPrice;
      fromBook = quote.fromBook;
    } else {
      marketPrice = marketPrice > 0 && marketPrice < 1 ? marketPrice : 0.5;
      worstPrice =
        worstPrice > 0 && worstPrice < 1 ? worstPrice : Math.min(0.99, Math.max(0.01, marketPrice * BUY_SLIPPAGE_MULT));
    }

    const tickSize = opts.tickSize || (tokenId ? await fetchTickSize(tokenId) : '0.01');
    const feeRate = await fetchFeeRate(tokenId, opts.category || 'crypto');
    const { rawMakerAmt, rawTakerAmt } = getMarketOrderRawAmounts('BUY', budget, worstPrice, tickSize);
    const costUsdc = rawMakerAmt;
    const shares = rawTakerAmt;
    const feeUsdc = calcTakerFeeUsdc(shares, marketPrice, feeRate);
    const totalDebit = Math.round((costUsdc + feeUsdc) * 1e4) / 1e4;
    const minShares = tokenId ? await fetchMinOrderSize(tokenId) : 5;

    return {
      costUsdc,
      shares,
      marketPrice,
      worstPrice,
      feeUsdc,
      feeRate,
      totalDebit,
      winPayout: shares,
      winProfit: shares - totalDebit,
      minShares,
      meetsMinSize: shares + 1e-9 >= minShares,
      fromBook,
      slippagePct: marketPrice > 0 ? ((worstPrice / marketPrice - 1) * 100) : 0,
    };
  }

  /** 兼容旧调用 */
  function estimateMarketBuy(amountUsd, worstPrice, tickSize = '0.01') {
    const price = worstPrice > 0 && worstPrice < 1 ? worstPrice : 0.5;
    const { rawMakerAmt, rawTakerAmt } = getMarketOrderRawAmounts('BUY', amountUsd, price, tickSize);
    const shares = rawTakerAmt;
    const feeUsdc = calcTakerFeeUsdc(shares, price, CRYPTO_TAKER_FEE_RATE);
    const costUsdc = rawMakerAmt;
    const totalDebit = costUsdc + feeUsdc;
    return { costUsdc, shares, price, winPayout: shares, winProfit: shares - totalDebit, feeUsdc, totalDebit };
  }

  async function estimateBuyForSide(marketId, outcomeSide, amountUsd, hintPrice) {
    const info = resolveMarketTokenBySide(marketId, outcomeSide);
    if (!info?.tokenId) return null;
    return estimateMarketBuyDetailed(amountUsd, info.tokenId, {
      markPrice: hintPrice > 0 && hintPrice < 1 ? hintPrice : info.markPrice,
      category: 'crypto',
    });
  }

  /** $amountUsd 在 price 下是否满足该 token 最小下单份数 */
  async function canBuyUsdForSide(marketId, outcomeSide, amountUsd, hintPrice) {
    const est = await estimateBuyForSide(marketId, outcomeSide, amountUsd, hintPrice);
    return est?.meetsMinSize === true;
  }

  async function fetchTickSize(tokenId) {
    try {
      const r = await fetch(CLOB_HOST + '/tick-size?token_id=' + encodeURIComponent(tokenId));
      if (r.ok) {
        const j = await r.json();
        const t = j.minimum_tick_size ?? j.tick_size ?? j.tickSize;
        if (t && ROUNDING_CONFIG[String(t)]) return String(t);
      }
    } catch (_) {}
    return '0.01';
  }

  /** 解析订单簿档位 */
  function parseBookLevels(book, side) {
    const raw = side === 'BUY' ? book?.asks || [] : book?.bids || [];
    const levels = raw
      .map((l) => ({ p: parseFloat(l.price), s: parseFloat(l.size) }))
      .filter((l) => l.p > 0 && l.p < 1 && l.s > 0);
    return side === 'BUY' ? levels.sort((a, b) => a.p - b.p) : levels.sort((a, b) => b.p - a.p);
  }

  /** 按美元金额在盘口上估算 FOK 成交（BUY=花费 USDC，SELL=卖出约 $N 等值份额） */
  function walkBookForUsd(levels, amountUsd, side) {
    let remaining = amountUsd;
    let totalShares = 0;
    let spent = 0;
    let worst = 0;
    for (const { p, s } of levels) {
      if (remaining <= 1e-9) break;
      worst = Math.max(worst, p);
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
    return {
      vwap: spent / totalShares,
      worst: worst || levels[0].p,
      shares: totalShares,
      spent,
    };
  }

  async function fetchClobBestPrice(tokenId, side) {
    const q = `token_id=${encodeURIComponent(tokenId)}&side=${encodeURIComponent(side)}`;
    const bases = [];
    try {
      const b = global.PMTraders?.apiBase?.();
      if (b) bases.push(b.replace(/\/$/, ''));
    } catch (_) {}
    if (global.location?.protocol?.startsWith('http')) {
      bases.push(`${global.location.protocol}//${global.location.host}`);
    }
    if (!bases.includes('http://localhost:3458')) bases.push('http://localhost:3458');
    for (const base of bases) {
      try {
        const pr = await fetch(`${base}/api/clob/price?${q}`);
        if (pr.ok) {
          const pd = await pr.json();
          const p = parseFloat(pd.price);
          if (p > 0 && p < 1) return p;
        }
      } catch (_) {}
    }
    try {
      const pr = await fetch(CLOB_HOST + '/price?' + q, { mode: 'cors' });
      if (pr.ok) {
        const pd = await pr.json();
        const p = parseFloat(pd.price);
        if (p > 0 && p < 1) return p;
      }
    } catch (_) {}
    return null;
  }

  async function fetchClobBook(tokenId) {
    const q = 'token_id=' + encodeURIComponent(tokenId);
    const bases = [];
    try {
      const b = global.PMTraders?.apiBase?.();
      if (b) bases.push(b.replace(/\/$/, ''));
    } catch (_) {}
    if (global.location?.protocol?.startsWith('http')) {
      bases.push(`${global.location.protocol}//${global.location.host}`);
    }
    if (!bases.includes('http://localhost:3458')) bases.push('http://localhost:3458');
    for (const base of bases) {
      try {
        const r = await fetch(`${base}/api/clob/book?${q}`);
        if (r.ok) return r.json();
      } catch (_) {}
    }
    try {
      const r = await fetch(CLOB_HOST + '/book?' + q, { mode: 'cors' });
      if (r.ok) return r.json();
    } catch (_) {}
    return null;
  }

  function midPriceFromBook(book) {
    const bids = parseBookLevels(book, 'SELL');
    const asks = parseBookLevels(book, 'BUY');
    if (bids.length && asks.length) return (bids[0].p + asks[0].p) / 2;
    if (bids.length) return bids[0].p;
    if (asks.length) return asks[0].p;
    return null;
  }

  /** 获取市价与滑点保护价（用于 $1 市价 FOK） */
  async function resolveMarketQuote(tokenId, side, amountUsd) {
    const amt = amountUsd > 0 ? amountUsd : getOrderAmount();
    const book = await fetchClobBook(tokenId);
    const levels = book ? parseBookLevels(book, side) : [];
    if (levels.length) {
      const fill = walkBookForUsd(levels, amt, side);
      if (fill) {
        const slip = side === 'BUY' ? 1.02 : 0.98;
        const cap = side === 'BUY' ? fill.worst * slip : fill.worst * slip;
        return {
          marketPrice: fill.vwap,
          worstPrice: Math.min(0.99, Math.max(0.01, cap)),
          fromBook: true,
        };
      }
    }
    const best = await fetchClobBestPrice(tokenId, side);
    if (best) {
      const slip = side === 'BUY' ? 1.02 : 0.98;
      return {
        marketPrice: best,
        worstPrice: Math.min(0.99, Math.max(0.01, side === 'BUY' ? best * slip : best * slip)),
        fromBook: false,
      };
    }
    throw new Error('无法获取订单簿市价');
  }

  async function placeOrderWithToken(tokenId, side, amount, opts = {}) {
    if (!walletState.address) throw new Error('请先连接钱包');
    if (!walletState.apiKey) throw new Error('请先获取 API Key');
    if (!tokenId) throw new Error('缺少 tokenId');

    const label = opts.label || global.pmGetMarketByTokenId?.(tokenId)?.title || '持仓';
    const negRisk = !!opts.negRisk;
    const amountIsShares = !!opts.amountIsShares;
    let userAmount = amount > 0 ? amount : getOrderAmount();

    await syncServerTime();

    let quote;
    try {
      let quoteAmt =
        side === 'SELL' && amountIsShares
          ? userAmount * ((await fetchClobBestPrice(tokenId, 'SELL')) || opts.markPrice || 0.5)
          : userAmount;
      if (side === 'BUY' && !amountIsShares && !getOrderProfile().skipMinSizeBump) {
        const pre = await fetchClobBestPrice(tokenId, 'BUY');
        const adj = await adjustBuyUsdForMinSize(tokenId, userAmount, pre || opts.markPrice || 0.5);
        if (adj.bumped) userAmount = adj.usd;
      }
      quote = await resolveMarketQuote(tokenId, side, quoteAmt);
    } catch (e) {
      const fallback = opts.markPrice > 0 && opts.markPrice < 1 ? opts.markPrice : null;
      if (!fallback) throw e;
      quote = {
        marketPrice: fallback,
        worstPrice: side === 'BUY' ? Math.min(0.99, fallback * 1.02) : Math.max(0.01, fallback * 0.98),
        fromBook: false,
      };
    }

    if (quote.worstPrice <= 0 || quote.worstPrice >= 1) throw new Error('价格无效: ' + quote.worstPrice);

    const tickSize = await fetchTickSize(tokenId);
    const wallet = await getSignerWallet();
    const verifyingContract = negRisk ? NEG_RISK_EXCHANGE : CTF_EXCHANGE;
    const makerAddress = walletState.funder || walletState.address;
    const signerAddress = walletState.address;
    const salt = ethers.BigNumber.from(Date.now()).mul(1000).add(Math.floor(Math.random() * 1000));
    const { makerAmount, takerAmount } = computeMarketOrderSize(side, userAmount, quote.worstPrice, tickSize, {
      amountIsShares,
    });

    const BYTES32_ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';
    const sigType = walletState.sigType ?? 1;
    const timestamp = Date.now().toString();
    const orderStruct = {
      salt: salt.toString(),
      maker: makerAddress,
      signer: signerAddress,
      tokenId,
      makerAmount: makerAmount.toString(),
      takerAmount: takerAmount.toString(),
      side: side === 'BUY' ? 0 : 1,
      signatureType: sigType,
      timestamp,
      metadata: BYTES32_ZERO,
      builder: BYTES32_ZERO,
    };
    const domain = { name: 'Polymarket CTF Exchange', version: '2', chainId: 137, verifyingContract };
    const types = {
      Order: [
        { name: 'salt', type: 'uint256' },
        { name: 'maker', type: 'address' },
        { name: 'signer', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'makerAmount', type: 'uint256' },
        { name: 'takerAmount', type: 'uint256' },
        { name: 'side', type: 'uint8' },
        { name: 'signatureType', type: 'uint8' },
        { name: 'timestamp', type: 'uint256' },
        { name: 'metadata', type: 'bytes32' },
        { name: 'builder', type: 'bytes32' },
      ],
    };
    const signature = await wallet._signTypedData(domain, types, orderStruct);
    const orderPayload = {
      order: {
        salt: parseInt(salt.toString(), 10),
        maker: makerAddress,
        signer: signerAddress,
        tokenId,
        makerAmount: makerAmount.toString(),
        takerAmount: takerAmount.toString(),
        side,
        expiration: '0',
        signatureType: sigType,
        timestamp,
        metadata: BYTES32_ZERO,
        builder: BYTES32_ZERO,
        signature,
      },
      owner: walletState.apiKey,
      orderType: 'FOK',
      deferExec: false,
      postOnly: false,
    };
    const body = JSON.stringify(orderPayload);
    const headers = await getL2Headers('POST', '/order', body);
    const resp = await fetch(CLOB_HOST + '/order', { method: 'POST', headers, body });
    const respText = await resp.text();
    let result = {};
    try {
      result = respText ? JSON.parse(respText) : {};
    } catch {
      result = { error: respText };
    }
    if (!resp.ok || result.success === false) {
      const reason = formatOrderError(null, resp.status, result, respText);
      const sideZh = side === 'BUY' ? '买入' : '卖出';
      const err = new Error(reason);
      err.marketLabel = label;
      err.httpStatus = resp.status;
      err.apiResult = result;
      err.detail = `${sideZh} · ${label}\n原因：${reason}`;
      throw err;
    }
    return result;
  }

  function findOutcomeIndex(outcomes, side) {
    const list = (outcomes || []).map((o) => String(o).toLowerCase());
    if (side === 'up') {
      const i = list.indexOf('up');
      if (i >= 0) return i;
    }
    if (side === 'down') {
      const i = list.indexOf('down');
      if (i >= 0) return i;
    }
    if (list.length === 2) return side === 'up' ? 0 : 1;
    return -1;
  }

  function resolveMarketToken(marketId) {
    const m = global.pmGetMarket?.(marketId);
    if (!m) return null;
    const { prob, index } = getMaxOutcome(m.outcomes || ['Yes', 'No'], m.prices || []);
    const tokenIds = m.clobTokenIds || [];
    if (!tokenIds[index]) return null;
    return {
      tokenId: String(tokenIds[index]),
      label: m.title,
      negRisk: !!m.negRisk,
      markPrice: prob,
      marketId: String(marketId),
      outcome: (m.outcomes || [])[index] || '',
    };
  }

  /** 加密 Up/Down：按方向取 token（非领先方） */
  function resolveMarketTokenBySide(marketId, outcomeSide) {
    const m = global.pmGetMarket?.(marketId);
    if (!m) return null;
    const index = findOutcomeIndex(m.outcomes, outcomeSide);
    const tokenIds = m.clobTokenIds || [];
    if (index < 0 || !tokenIds[index]) return null;
    const outcome = (m.outcomes || [])[index] || outcomeSide;
    const markPrice = parseFloat(m.prices?.[index]) || 0.5;
    return {
      tokenId: String(tokenIds[index]),
      label: `${m.title} · ${outcome}`,
      negRisk: !!m.negRisk,
      markPrice,
      marketId: String(marketId),
      outcomeSide,
      conditionId: m.conditionId || null,
    };
  }

  async function placeOrderInternal(marketId, side, opts = {}) {
    const info = opts.outcomeSide
      ? resolveMarketTokenBySide(marketId, opts.outcomeSide)
      : resolveMarketToken(marketId);
    if (!info) throw new Error('市场未找到');
    const orderAmt = getOrderAmount();
    return placeOrderWithToken(info.tokenId, side, orderAmt, {
      label: info.label,
      negRisk: info.negRisk,
      markPrice: info.markPrice,
    });
  }

  async function placeOrderBySide(marketId, outcomeSide) {
    if (!walletState.pk && !extSigner) {
      toast('下单需填写私钥用于签名', 'error');
      toggleWallet();
      throw new Error('未配置私钥');
    }
    const side = String(outcomeSide || '').toLowerCase();
    if (side !== 'up' && side !== 'down') throw new Error('方向须为 up 或 down');
    const orderAmt = getOrderAmount();
    let preMsg = `正在市价买入 ${side.toUpperCase()} · 订单 $${orderAmt}…`;
    try {
      const est = await estimateBuyForSide(marketId, side, orderAmt);
      if (est) preMsg += `\n${formatBuyEstimateLine(est)}`;
    } catch (_) {}
    toast(preMsg, 'buy', 8000);
    try {
      const result = await placeOrderInternal(marketId, 'BUY', { outcomeSide: side });
      toast(`已提交 ${side.toUpperCase()} 市价单 · 订单金额 $${orderAmt}`, 'buy');
      return result;
    } catch (e) {
      toast(e.detail || e.message || '下单失败', 'error', 12000);
      throw e;
    }
  }

  /** 链上 Split $N（与官网一致：$1 → 1 Up + 1 Down，非订单簿各 $0.5） */
  async function splitPositionInternal(marketId, amountUsd) {
    const total = amountUsd > 0 ? amountUsd : getOrderAmount();
    const m = global.pmGetMarket?.(marketId);
    if (!m?.conditionId) throw new Error('缺少 conditionId，无法 Split');
    if (!walletState.funder) throw new Error('请填写代理钱包 Funder 地址');
    if (!global.PMCtfRelay?.executeCtfSplit) {
      throw new Error('未加载 polymarket-ctf-relay.js，请刷新页面');
    }
    if (!global.location?.protocol?.startsWith('http')) {
      throw new Error('Split 需通过 http://localhost:3458 打开（本地服务代理 Relayer）');
    }
    return global.PMCtfRelay.executeCtfSplit({
      privateKey: walletState.pk,
      proxyWallet: walletState.funder,
      conditionId: m.conditionId,
      amountUsd: total,
      relayerApiKey: walletState.relayerApiKey,
      relayerApiKeyAddress: walletState.relayerApiKeyAddress || walletState.address,
      metadata: `Split $${total} · ${(m.title || '').slice(0, 40)}`,
    });
  }

  async function splitPosition(marketId, amountUsd) {
    if (!walletState.pk && !extSigner) {
      toast('Split 需填写私钥用于签名', 'error');
      toggleWallet();
      throw new Error('未配置私钥');
    }
    if (!walletState.relayerApiKey) {
      toast('Split 需在钱包面板填写 Relayer API Key（polymarket.com → Settings → API Keys）', 'error', 14000);
      toggleWallet();
      throw new Error('未配置 Relayer API Key');
    }
    const total = amountUsd > 0 ? amountUsd : getOrderAmount();
    const m = global.pmGetMarket?.(marketId);
    const title = m?.title ? String(m.title).slice(0, 48) : '市场';
    toast(`链上 Split $${total}（与官网相同，铸 1 Up + 1 Down）…`, 'info');
    try {
      const result = await splitPositionInternal(marketId, total);
      toast(`Split 完成 · ${title}\n$${total} → 1 Up + 1 Down（链上 Split Position）`, 'ok', 10000);
      return result;
    } catch (e) {
      toast(e.detail || e.message || 'Split 失败', 'error', 14000);
      throw e;
    }
  }

  async function sellPosition(position) {
    if (!position?.tokenId || !(position.qty > 0)) throw new Error('无效持仓');
    if (!walletState.pk && !extSigner) {
      toast('卖出需填写私钥用于签名', 'error');
      toggleWallet();
      throw new Error('未配置私钥');
    }
    const qty = roundDown(position.qty, 2);
    return placeOrderWithToken(position.tokenId, 'SELL', qty, {
      label: position.label,
      negRisk: !!position.negRisk,
      markPrice: position.markPrice,
      amountIsShares: true,
    });
  }

  async function refreshCollateralCache() {
    if (!walletState.apiKey) return;
    try {
      await syncServerTime();
      const sigType = walletState.sigType ?? 1;
      await clobAuthenticatedGet('/balance-allowance/update', {
        asset_type: 'COLLATERAL',
        signature_type: String(sigType),
      });
    } catch (_) {}
  }

  async function fetchUsdcBalance() {
    if (!walletState.apiKey || !walletState.apiSecret) {
      throw new Error('请先配置 API Key');
    }
    if (!walletState.address) throw new Error('请先连接钱包');
    await syncServerTime();
    await refreshCollateralCache();
    const sigType = walletState.sigType ?? 1;
    const resp = await clobAuthenticatedGet('/balance-allowance', {
      asset_type: 'COLLATERAL',
      signature_type: String(sigType),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = data?.error || data?.errorMsg || data?.message || 'HTTP ' + resp.status;
      throw new Error(msg);
    }
    const raw = parseInt(String(data.balance ?? '0').split('.')[0], 10);
    if (Number.isNaN(raw)) throw new Error('余额数据格式异常');
    return raw / 1e6;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** 卖出后轮询刷新持仓（Data API 有延迟） */
  async function refreshAfterSell(soldTokenId) {
    const delays = [600, 1200, 2000, 3500];
    let lastList = [];
    for (let i = 0; i <= delays.length; i++) {
      if (i > 0) await sleep(delays[i - 1]);
      await refreshCollateralCache();
      lastList = await fetchOpenPositions();
      if (!soldTokenId) return lastList;
      const still = lastList.some((p) => String(p.tokenId) === String(soldTokenId));
      if (!still) return lastList;
    }
    return lastList;
  }

  function updateBatchBar() {
    const count = document.querySelectorAll('.tbl-wrap .sel-checkbox:checked').length;
    if ($('batchCount')) $('batchCount').textContent = count;
    $('batchBar')?.classList.toggle('show', count > 0);
  }

  function toggleSelectAll(el) {
    const tbl = el.closest('table');
    tbl?.querySelectorAll('tbody .sel-checkbox').forEach((c) => (c.checked = el.checked));
    updateBatchBar();
  }

  function clearSelection() {
    document.querySelectorAll('.sel-checkbox').forEach((c) => (c.checked = false));
    updateBatchBar();
  }

  async function batchOrderForIds(marketIds, side, amountOverride, opts = {}) {
    const ids = [...new Set((marketIds || []).map(String))].filter(Boolean);
    if (!ids.length) {
      toast('没有符合条件的市场', 'error');
      return { ok: 0, fail: 0, total: 0 };
    }
    if (!walletState.address || (!walletState.pk && !extSigner)) {
      toast('请先连接钱包并填写私钥', 'error');
      toggleWallet();
      return { ok: 0, fail: ids.length, total: ids.length };
    }
    if (!walletState.apiKey) {
      toast('请先获取 API Key', 'error');
      toggleWallet();
      return { ok: 0, fail: ids.length, total: ids.length };
    }
    const amount = amountOverride > 0 ? amountOverride : getOrderAmount();
    const outcomeSide = opts.outcomeSide || null;
    const sideZh = side === 'BUY' ? '买入' : '卖出';
    const dirHint = outcomeSide ? ` ${outcomeSide.toUpperCase()}` : '';
    let ok = 0;
    let fail = 0;
    const failures = [];
    const bought = [];
    toast(`批量${sideZh}${dirHint} ${ids.length} 笔，市价每单 $${amount}…`, 'info');
    for (const mid of ids) {
      try {
        await placeOrderInternal(mid, side, outcomeSide ? { outcomeSide } : {});
        ok++;
        if (side === 'BUY') {
          const info = outcomeSide ? resolveMarketTokenBySide(mid, outcomeSide) : resolveMarketToken(mid);
          if (info) bought.push(info);
        }
      } catch (e) {
        fail++;
        const label = e.marketLabel || marketLabel(mid);
        const reason = e.message || formatOrderError(e);
        failures.push({ label, reason, httpStatus: e.httpStatus });
        console.error('[下单失败]', { marketId: mid, label, reason, api: e.apiResult, http: e.httpStatus });
        toast(`${sideZh}失败 · ${label}\n原因：${reason}`, 'error', 12000);
      }
    }
    if (fail === 0) {
      toast(`批量${sideZh}完成：${ok} 笔全部成功`, 'success');
    } else if (ok === 0) {
      toast(
        `批量${sideZh}全部失败（${fail} 笔）\n` +
          failures.map((f, i) => `${i + 1}. ${f.label}\n   ${f.reason}`).join('\n'),
        'error',
        15000,
      );
    } else {
      toast(
        `批量${sideZh}：成功 ${ok}，失败 ${fail}\n` +
          failures.map((f, i) => `失败${i + 1} ${f.label}：${f.reason}`).join('\n'),
        'warn',
        15000,
      );
    }
    return { ok, fail, total: ids.length, failures, bought };
  }

  async function batchOrder(side) {
    const checked = [...document.querySelectorAll('.tbl-wrap .sel-checkbox:checked')];
    if (!checked.length) {
      toast('请先勾选市场', 'error');
      return;
    }
    await batchOrderForIds(
      checked.map((cb) => cb.value),
      side,
      getOrderAmount(),
    );
    clearSelection();
  }

  async function batchOrderBySide(outcomeSide) {
    const checked = [...document.querySelectorAll('.tbl-wrap .sel-checkbox:checked')];
    if (!checked.length) {
      toast('请先勾选市场', 'error');
      return;
    }
    await batchOrderForIds(
      checked.map((cb) => cb.value),
      'BUY',
      getOrderAmount(),
      { outcomeSide: String(outcomeSide || '').toLowerCase() },
    );
    clearSelection();
  }

  async function batchSplitForIds(marketIds, amountUsd) {
    const ids = [...new Set((marketIds || []).map(String))].filter(Boolean);
    if (!ids.length) {
      toast('没有符合条件的市场', 'error');
      return { ok: 0, fail: 0, total: 0 };
    }
    if (!walletState.address || (!walletState.pk && !extSigner)) {
      toast('请先连接钱包并填写私钥', 'error');
      toggleWallet();
      return { ok: 0, fail: ids.length, total: ids.length };
    }
    if (!walletState.relayerApiKey) {
      toast('批量 Split 需填写 Relayer API Key', 'error');
      toggleWallet();
      return { ok: 0, fail: ids.length, total: ids.length };
    }
    if (!walletState.funder) {
      toast('请填写代理钱包 Funder', 'error');
      toggleWallet();
      return { ok: 0, fail: ids.length, total: ids.length };
    }
    const total = amountUsd > 0 ? amountUsd : getOrderAmount();
    let ok = 0;
    let fail = 0;
    const failures = [];
    toast(`批量链上 Split $${total} × ${ids.length} 场…`, 'info');
    for (const mid of ids) {
      try {
        await splitPositionInternal(mid, total);
        ok++;
      } catch (e) {
        fail++;
        const label = e.marketLabel || marketLabel(mid);
        const reason = e.message || formatOrderError(e);
        failures.push({ label, reason });
        toast(`Split 失败 · ${label}\n${reason}`, 'error', 12000);
      }
    }
    if (fail === 0) {
      toast(`批量 Split 完成：${ok} 场（每场 $${total}）`, 'success');
    } else if (ok === 0) {
      toast(
        `批量 Split 全部失败（${fail} 场）\n` +
          failures.map((f, i) => `${i + 1}. ${f.label}\n   ${f.reason}`).join('\n'),
        'error',
        15000,
      );
    } else {
      toast(`批量 Split：成功 ${ok}，失败 ${fail}`, 'warn', 12000);
    }
    return { ok, fail, total: ids.length, failures };
  }

  async function batchSplitPosition(amountUsd) {
    const checked = [...document.querySelectorAll('.tbl-wrap .sel-checkbox:checked')];
    if (!checked.length) {
      toast('请先勾选市场', 'error');
      return;
    }
    await batchSplitForIds(
      checked.map((cb) => cb.value),
      amountUsd,
    );
    clearSelection();
  }

  const END_CURSOR = 'LTE=';

  function normalizeSide(side) {
    return side === 'BUY' || side === 0 || side === '0' ? 'BUY' : 'SELL';
  }

  function parseTradeSize(t) {
    let s = parseFloat(t.size ?? t.size_matched ?? 0);
    if (!s || Number.isNaN(s)) {
      const raw = parseFloat(t.takerAmount || t.makerAmount || 0);
      if (raw > 0) s = raw / 1e6;
    } else if (s > 1e4) {
      s = s / 1e6;
    }
    return s;
  }

  async function fetchAllPages(basePath) {
    let all = [];
    let nextCursor = '';
    for (let i = 0; i < 20; i++) {
      const query = nextCursor ? { next_cursor: nextCursor } : {};
      const qs = new URLSearchParams(query).toString();
      const url = basePath + (qs ? '?' + qs : '');
      const headers = await getL2Headers('GET', basePath);
      const resp = await fetch(CLOB_HOST + url, { headers });
      if (!resp.ok) break;
      const data = await resp.json();
      let page = [];
      if (data?.data) page = data.data;
      else if (Array.isArray(data)) page = data;
      all = all.concat(page);
      const cursor = data?.next_cursor || '';
      if (!cursor || cursor === END_CURSOR || page.length === 0) break;
      nextCursor = cursor;
    }
    return all;
  }

  async function fetchTokenMarkPrice(tokenId) {
    try {
      const r = await fetch(
        CLOB_HOST + '/price?token_id=' + encodeURIComponent(tokenId) + '&side=SELL',
      );
      if (r.ok) {
        const j = await r.json();
        const p = parseFloat(j.price);
        if (p > 0 && p < 1) return p;
      }
    } catch (_) {}
    return null;
  }

  function resolveAssetLabel(t) {
    const tid = t.asset_id || t.token_id || t.tokenId || t.assetId || '';
    const fromPage = global.pmGetMarketByTokenId?.(tid);
    if (fromPage?.title) return fromPage.title;
    return (
      t.title ||
      t.asset_name ||
      t.assetName ||
      t.marketName ||
      t.outcome ||
      (tid ? 'Token ' + String(tid).slice(0, 10) + '…' : '—')
    );
  }

  function buildPositionsFromTrades(trades) {
    const map = {};
    trades.forEach((t) => {
      const tokenId = String(t.asset_id || t.token_id || t.tokenId || t.assetId || '');
      if (!tokenId) return;
      const side = normalizeSide(t.side);
      const size = parseTradeSize(t);
      const price = parseFloat(t.price || 0);
      if (!size || !price) return;

      if (!map[tokenId]) {
        map[tokenId] = {
          tokenId,
          label: resolveAssetLabel(t),
          qty: 0,
          cost: 0,
          realized: 0,
          buyVol: 0,
          sellVol: 0,
        };
      }
      const p = map[tokenId];
      if (side === 'BUY') {
        p.qty += size;
        p.cost += size * price;
        p.buyVol += size * price;
      } else {
        const avg = p.qty > 1e-9 ? p.cost / p.qty : price;
        p.realized += size * price - avg * size;
        p.cost -= avg * size;
        p.qty -= size;
        p.sellVol += size * price;
      }
    });
    return Object.values(map);
  }

  async function enrichPositionsWithMark(positions) {
    const open = positions.filter((p) => p.qty > 1e-6);
    await Promise.all(
      open.map(async (p) => {
        p.markPrice = (await fetchTokenMarkPrice(p.tokenId)) ?? (p.qty > 0 ? p.cost / p.qty : 0.5);
        p.marketValue = p.qty * p.markPrice;
        p.unrealized = p.marketValue - p.cost;
        p.totalPnl = p.realized + p.unrealized;
      }),
    );
    positions.filter((p) => p.qty <= 1e-6).forEach((p) => {
      p.markPrice = null;
      p.marketValue = 0;
      p.unrealized = 0;
      p.totalPnl = p.realized;
    });
    return positions;
  }

  function normalizeTradeRow(t) {
    const side = normalizeSide(t.side);
    const size = parseTradeSize(t);
    const price = parseFloat(t.price || 0);
    const usdc = parseFloat(t.originalAmount || 0) / 1e6 || (price > 0 && size > 0 ? size * price : 0);
    const ts = t.match_time || t.matchTime || t.created_at || t.createdAt || t.timestamp || '';
    return {
      id: t.id || t.trade_id || t.tradeID || '',
      tokenId: String(t.asset_id || t.token_id || t.tokenId || ''),
      label: resolveAssetLabel(t),
      side,
      price,
      size,
      usdc,
      ts,
    };
  }

  function mapDataApiPosition(p) {
    const title = (p.title || '').trim();
    const outcome = (p.outcome || '').trim();
    const label = title ? (outcome ? `${title} · ${outcome}` : title) : outcome || '—';
    const qty = parseFloat(p.size) || 0;
    return {
      tokenId: p.asset || '',
      label,
      title: title || label,
      outcome,
      icon: (p.icon || '').trim(),
      qty,
      cost: parseFloat(p.initialValue) || 0,
      marketValue: parseFloat(p.currentValue) || 0,
      avgPrice: parseFloat(p.avgPrice) || 0,
      markPrice: parseFloat(p.curPrice) || 0,
      unrealized: parseFloat(p.cashPnl) || 0,
      percentPnl: parseFloat(p.percentPnl) || 0,
      realized: parseFloat(p.realizedPnl) || 0,
      toWin: qty,
      slug: p.slug,
      eventSlug: p.eventSlug,
      redeemable: !!p.redeemable,
      negRisk: !!p.negativeRisk,
    };
  }

  async function fetchPositionsForAddress(user) {
    const params = new URLSearchParams({
      user,
      sizeThreshold: '0',
      limit: '500',
      sortBy: 'CASHPNL',
      sortDirection: 'DESC',
    });
    let url;
    if (global.location?.protocol?.startsWith('http')) {
      url = `/api/positions?${params.toString()}`;
    } else {
      url = `https://data-api.polymarket.com/positions?${params.toString()}`;
    }
    const resp = await fetch(url);
    const data = await resp.json();
    if (!resp.ok) {
      const err = data?.error || 'HTTP ' + resp.status;
      throw new Error(err);
    }
    const raw = data.positions ?? data;
    return (Array.isArray(raw) ? raw : []).map(mapDataApiPosition).filter((p) => p.qty > 1e-6);
  }

  function getWalletAddresses() {
    const addrs = [];
    if (walletState.funder) addrs.push(walletState.funder);
    if (walletState.address) addrs.push(walletState.address);
    const seen = new Set();
    return addrs.filter((a) => {
      const k = a.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  async function fetchValueForAddress(user) {
    const params = new URLSearchParams({ user });
    let url;
    if (global.location?.protocol?.startsWith('http')) {
      url = `/api/value?${params.toString()}`;
    } else {
      url = `https://data-api.polymarket.com/value?${params.toString()}`;
    }
    const resp = await fetch(url);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error || 'HTTP ' + resp.status);
    const rows = data.value ?? data;
    const row = Array.isArray(rows) ? rows[0] : rows;
    return parseFloat(row?.value) || 0;
  }

  /** 与 Polymarket 官网一致的持仓（Data API） */
  async function fetchOpenPositions() {
    const unique = getWalletAddresses();
    if (!unique.length) throw new Error('请先配置钱包地址或代理地址 (Funder)');

    let best = [];
    let lastErr = null;
    for (const user of unique) {
      try {
        const list = await fetchPositionsForAddress(user);
        if (list.length >= best.length) best = list;
        if (list.length > 0) return list;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr && !best.length) throw lastErr;
    return best;
  }

  /** 资产组合总览：持仓市值（Data API /value）+ 可用 USDC */
  async function fetchPortfolioSummary() {
    const openPositions = await fetchOpenPositions();
    const addrs = getWalletAddresses();

    let positionsValue = openPositions.reduce((s, p) => s + (p.marketValue || 0), 0);
    for (const user of addrs) {
      try {
        const v = await fetchValueForAddress(user);
        if (v > 0 || openPositions.length === 0) {
          positionsValue = v;
          break;
        }
      } catch (e) {
        console.warn('[资产组合市值]', user, e.message || e);
      }
    }

    let balanceUsdc = null;
    let balanceError = '';
    if (walletState.apiKey && walletState.apiSecret) {
      try {
        balanceUsdc = await fetchUsdcBalance();
      } catch (e) {
        balanceError = e.message || String(e);
      }
    }

    const cost = openPositions.reduce((s, p) => s + (p.cost || 0), 0);
    const unrealized = openPositions.reduce((s, p) => s + (p.unrealized || 0), 0);
    const realized = openPositions.reduce((s, p) => s + (p.realized || 0), 0);
    const portfolioValue =
      balanceUsdc != null ? positionsValue + balanceUsdc : null;

    return {
      openPositions,
      positionsValue,
      balanceUsdc,
      balanceError,
      portfolioValue,
      cost,
      unrealized,
      realized,
    };
  }

  async function fetchMyTradingData() {
    const positions = await fetchOpenPositions();
    return { positions, openPositions: positions };
  }

  async function cancelOrder(orderId) {
    if (!orderId) return;
    await syncServerTime();
    const path = '/order?orderID=' + encodeURIComponent(orderId);
    const headers = await getL2Headers('DELETE', '/order');
    const resp = await fetch(CLOB_HOST + path, { method: 'DELETE', headers });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return resp.json();
  }

  function init() {
    loadWallet();
    bindOrderAmountInput();
  }

  global.PMClob = {
    fetchBook: fetchClobBook,
    midPriceFromBook,
    parseBookLevels,
  };

  global.PMTrade = {
    init,
    clearWalletCache,
    toggleWallet,
    connectWallet,
    connectMetaMask,
    deriveApiKey,
    fetchProxyAddress,
    batchOrder,
    batchOrderBySide,
    batchOrderForIds,
    batchSplitPosition,
    batchSplitForIds,
    splitPosition,
    getOrderAmount,
    placeOrderBySide,
    placeOrderWithToken,
    canBuyUsdForSide,
    estimateMarketBuy,
    estimateMarketBuyDetailed,
    estimateBuyForSide,
    formatBuyEstimateLine,
    calcTakerFeeUsdc,
    updateBatchBar,
    toggleSelectAll,
    clearSelection,
    toast,
    toastTrade,
    fetchMyTradingData,
    fetchOpenPositions,
    fetchPortfolioSummary,
    fetchUsdcBalance,
    refreshAfterSell,
    sellPosition,
    cancelOrder,
    isReady: () => !!(walletState.address && walletState.apiKey && (walletState.pk || extSigner)),
    hasWalletAddress: () => !!(walletState.funder || walletState.address),
  };
})(window);
