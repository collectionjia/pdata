/**
 * Polymarket 链上 Split（CTF collateral adapter + Relayer PROXY）
 * 与官网 Split $1 一致：$1 pUSD → 1 Up + 1 Down，无 CLOB 最小 5 份限制
 */
(function (global) {
  const RELAYER_HOST = 'https://relayer-v2.polymarket.com';
  const PROXY_FACTORY = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052';
  const RELAY_HUB = '0xD216153c06E857cD7f72665E0aF1d7D82172F494';
  const CTF_ADAPTER = '0xAdA100Db00Ca00073811820692005400218FcE1f';
  const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
  const DEFAULT_GAS_LIMIT = '10000000';
  const CALL_TYPE = 0;

  function requireEthers() {
    if (typeof ethers === 'undefined') throw new Error('ethers.js 未加载');
  }

  function getProxyFactoryIface() {
    requireEthers();
    return new ethers.utils.Interface([
    {
      inputs: [
        {
          components: [
            { name: 'typeCode', type: 'uint8' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'data', type: 'bytes' },
          ],
          name: 'calls',
          type: 'tuple[]',
        },
      ],
      name: 'proxy',
      outputs: [{ name: 'returnValues', type: 'bytes[]' }],
      stateMutability: 'payable',
      type: 'function',
    },
    ]);
  }

  function getErc20Iface() {
    requireEthers();
    return new ethers.utils.Interface(['function approve(address spender, uint256 amount)']);
  }

  function getAdapterIface() {
    requireEthers();
    return new ethers.utils.Interface([
      'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
    ]);
  }

  function normalizeConditionId(conditionId) {
    let cid = String(conditionId || '').trim();
    if (!cid) throw new Error('缺少 conditionId');
    if (!cid.startsWith('0x')) cid = '0x' + cid;
    if (cid.length !== 66) throw new Error('conditionId 格式无效');
    return cid;
  }

  function encodeProxyTransactionData(txns) {
    const calls = txns.map((t) => ({
      typeCode: t.typeCode ?? CALL_TYPE,
      to: t.to,
      value: t.value ?? 0,
      data: t.data,
    }));
    return getProxyFactoryIface().encodeFunctionData('proxy', [calls]);
  }

  function toBytes32Num(n) {
    return ethers.utils.hexZeroPad(ethers.BigNumber.from(n).toHexString(), 32);
  }

  function createStructHash(from, to, data, txFee, gasPrice, gasLimit, nonce, relayHub, relay) {
    return ethers.utils.keccak256(
      ethers.utils.concat([
        '0x726c783a',
        from,
        to,
        data,
        toBytes32Num(txFee),
        toBytes32Num(gasPrice),
        toBytes32Num(gasLimit),
        toBytes32Num(nonce),
        relayHub,
        relay,
      ]),
    );
  }

  function relayerError(path, status, body, local) {
    const err = body?.error || body?.message || '';
    if (status === 404 && local) {
      return (
        `Relayer 本地代理 404（${path}）：请先关闭并重新运行 start-markets.bat` +
        (err ? `；${err}` : '')
      );
    }
    if (status === 404) {
      return `Relayer 404（${path}）${err ? '：' + err : '：请检查 EOA 地址、Relayer Key 与代理钱包 Funder'}`;
    }
    return `Relayer ${path} HTTP ${status}${err ? '：' + err : ''}`;
  }

  async function relayerGet(path, query) {
    const qs = new URLSearchParams(query).toString();
    const suffix = path.startsWith('/') ? path : '/' + path;
    const local = global.location?.protocol?.startsWith('http')
      ? `/api/relayer${suffix}${qs ? '?' + qs : ''}`
      : null;
    const url = local || `${RELAYER_HOST}${suffix}${qs ? '?' + qs : ''}`;
    const r = await fetch(url);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(relayerError(suffix, r.status, j, !!local));
    return j;
  }

  async function relayerSubmit(request, relayerApiKey, relayerApiKeyAddress) {
    if (!relayerApiKey) {
      throw new Error(
        'Split 需要 Relayer API Key：在 polymarket.com → Settings → API Keys 创建 Relayer Key 并填入钱包面板',
      );
    }
    const body = {
      request,
      relayerApiKey,
      relayerApiKeyAddress: relayerApiKeyAddress || request.from,
    };
    const local = global.location?.protocol?.startsWith('http');
    const url = local ? '/api/relayer/submit' : `${RELAYER_HOST}/submit`;
    const headers = { 'Content-Type': 'application/json' };
    if (!local) {
      headers.RELAYER_API_KEY = relayerApiKey;
      headers.RELAYER_API_KEY_ADDRESS = body.relayerApiKeyAddress;
    }
    const r = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(local ? body : request),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(relayerError('/submit', r.status, j, !!local));
    return j;
  }

  async function pollTransaction(transactionId, maxPolls = 30) {
    for (let i = 0; i < maxPolls; i++) {
      try {
        const list = await relayerGet('/transaction', { id: transactionId });
        const tx = Array.isArray(list) ? list[0] : list;
        if (tx?.state === 'STATE_CONFIRMED') return tx;
        if (tx?.state === 'STATE_FAILED' || tx?.state === 'STATE_INVALID') {
          throw new Error('链上 Split 失败: ' + (tx?.state || 'unknown'));
        }
      } catch (e) {
        const msg = String(e.message || e);
        if (!msg.includes('404') || i >= maxPolls - 1) throw e;
      }
      await new Promise((res) => setTimeout(res, 2000));
    }
    throw new Error('Split 超时，请在 Polymarket 活动记录中查看');
  }

  function buildSplitTransactions(conditionId, amountUsd) {
    const cid = normalizeConditionId(conditionId);
    const amountWei = ethers.utils.parseUnits(String(amountUsd), 6);
    requireEthers();
    const approveData = getErc20Iface().encodeFunctionData('approve', [CTF_ADAPTER, ethers.constants.MaxUint256]);
    const splitData = getAdapterIface().encodeFunctionData('splitPosition', [
      PUSD,
      ethers.constants.HashZero,
      cid,
      [1, 2],
      amountWei,
    ]);
    return [
      { typeCode: CALL_TYPE, to: PUSD, value: '0', data: approveData },
      { typeCode: CALL_TYPE, to: CTF_ADAPTER, value: '0', data: splitData },
    ];
  }

  async function executeCtfSplit(opts) {
    if (typeof ethers === 'undefined') throw new Error('ethers.js 未加载');
    const {
      privateKey,
      proxyWallet,
      conditionId,
      amountUsd = 1,
      relayerApiKey,
      relayerApiKeyAddress,
      metadata = 'Split position',
    } = opts;
    if (!privateKey) throw new Error('缺少私钥');
    if (!proxyWallet) throw new Error('请填写代理钱包 Funder 地址');
    const pk = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
    const wallet = new ethers.Wallet(pk);
    const from = wallet.address;
    const proxy = proxyWallet.startsWith('0x') ? proxyWallet : '0x' + proxyWallet;

    const txns = buildSplitTransactions(conditionId, amountUsd);
    const data = encodeProxyTransactionData(txns);
    const relayPayload = await relayerGet('/relay-payload', { address: from, type: 'PROXY' });
    const relay = relayPayload.address;
    const nonce = String(relayPayload.nonce);
    const gasLimit = DEFAULT_GAS_LIMIT;
    const gasPrice = '0';
    const txFee = '0';

    const structHash = createStructHash(
      from,
      PROXY_FACTORY,
      data,
      txFee,
      gasPrice,
      gasLimit,
      nonce,
      RELAY_HUB,
      relay,
    );
    const signature = await wallet.signMessage(ethers.utils.arrayify(structHash));

    const request = {
      from,
      to: PROXY_FACTORY,
      proxyWallet: proxy,
      data,
      nonce,
      signature,
      signatureParams: {
        gasPrice,
        gasLimit,
        relayerFee: txFee,
        relayHub: RELAY_HUB,
        relay,
      },
      type: 'PROXY',
      metadata,
    };

    const submitted = await relayerSubmit(request, relayerApiKey, relayerApiKeyAddress || from);
    const txId = submitted.transactionID;
    if (!txId) throw new Error('Relayer 未返回 transactionID');
    const confirmed = await pollTransaction(txId);
    return { transactionID: txId, transactionHash: confirmed?.transactionHash, amountUsd, proxyWallet: proxy };
  }

  global.PMCtfRelay = {
    executeCtfSplit,
    buildSplitTransactions,
    CTF_ADAPTER,
    PUSD,
  };
})(window);
