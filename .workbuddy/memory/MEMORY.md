# 长期记忆

## Polymarket CLOB API V2 下单格式

Polymarket 于 2026-04-28 迁移到 V2 合约。关键变更：

### V2 EIP-712 签名
- Domain: name="Polymarket CTF Exchange", version="2", chainId=137
- 合约: CTF=`0xE111180000d2663C0091e4f400237545B87B996B`, NegRisk=`0xe2222d279d744050d28e00520010520000310F59`
- Order struct (11 fields): salt(uint256), maker(address), signer(address), tokenId(uint256), makerAmount(uint256), takerAmount(uint256), side(uint8), signatureType(uint8), timestamp(uint256), metadata(bytes32), builder(bytes32)
- signatureType: 0=EOA, 1=POLY_PROXY, 2=POLY_GNOSIS, 3=POLY_1271
- V2 移除: taker, nonce, feeRatePpm (expiration 仅传 API 不参与签名)

### V2 API Payload (POST /order)
```json
{
  "order": {
    "salt": <decimal integer>,
    "maker": "<address>", "signer": "<address>", "tokenId": "<string>",
    "makerAmount": "<string>", "takerAmount": "<string>",
    "side": "BUY|SELL", "expiration": "0",
    "signatureType": 0, "timestamp": "<ms>", "metadata": "<bytes32>", "builder": "<bytes32>",
    "signature": "<hex>"
  },
  "owner": "<api_key_uuid>",
  "orderType": "GTC", "deferExec": false, "postOnly": false
}
```

### maker 与 signer 地址规则（关键）
- **maker = funder（代理钱包地址）**：Polymarket 用户资金存放在代理钱包(Gnosis Safe/Proxy Wallet)中，maker 必须设为代理钱包地址
- **signer = EOA 地址**：私钥对应的外部账户地址，用于签名订单
- 如果用户没有代理钱包（未通过 Polymarket.com 存款），maker = EOA 地址
- 代理钱包地址获取方式：(1) Polymarket 个人资料页查看；(2) CLOB API GET /register；(3) 客户端 ClobClient(funder=proxy_addr) 参数
- 错误 "maker address not allowed, please use the deposit wallet flow" 表示 maker 用了 EOA 而非代理钱包地址

### signatureType 规则（关键，易错）
- **signatureType=0 (EOA)**：未通过 Polymarket.com 存款，无代理钱包，maker=EOA
- **signatureType=1 (POLY_PROXY)**：Email/Magic Link 登录 Polymarket，代理钱包为 Magic Link 代理
- **signatureType=2 (POLY_GNOSIS)**：MetaMask/浏览器钱包登录 Polymarket（**最常见**），代理钱包为 Gnosis Safe
- **有代理钱包时必须用正确的 signatureType**，否则报 "invalid signature"
- signatureType 同时影响 EIP-712 签名哈希（是 struct 字段）和 API payload

### API 认证
- L1: EIP-712 ClobAuthDomain 签名，4个header: POLY_ADDRESS/POLY_SIGNATURE/POLY_TIMESTAMP/POLY_NONCE
- L2: HMAC-SHA256 签名，**5个header（无 NONCE！）**: POLY_ADDRESS/POLY_API_KEY/POLY_SIGNATURE/POLY_TIMESTAMP/POLY_PASSPHRASE
- ⚠️ **L2 没有 POLY_NONCE**，NONCE 是 L1 专用的 header，混入 L2 会导致 401 Unauthorized
- **L2 HMAC 关键细节（已确认，对照 Python/TypeScript 官方客户端源码）**：
  - API Secret 是 URL-safe Base64 编码的，必须先 Base64 解码为原始字节再作为 HMAC 密钥
  - Secret 解码：先 URL-safe→标准（`-`→`+`，`_`→`/`，补`=`），再去非法字符，再 `atob()` 解码
  - HMAC 签名结果用 **URL-safe Base64** 编码（`+`→`-`，`/`→`_`）
  - ⚠️ **padding 必须保留！** TypeScript 客户端注释: "Must be url safe base64 encoding, but keep base64 = suffix"。Python `urlsafe_b64encode` 也保留 padding。之前的代码错误地删除了 `=` padding，导致 401
  - 签名消息格式：`timestamp + method + path + body`（无分隔符，body 中单引号替换为双引号，GET 请求 body 不追加）
  - 通过 VPN 访问时需先 `GET /time` 同步服务器时间，否则时间戳偏差导致 401
- API Key 获取: 先 POST /auth/api-key(create)，若 nonce 已用则 GET /auth/derive-api-key(derive)
- API Key 响应格式：扁平 `{ apiKey, secret, passphrase }` 或数组 `{ apiKey: [{ key, secret, passphrase }] }`

### CLOB API 端点路径（关键，易错）
- 对照 py-clob-client `endpoints.py`，注意 `/order` 和 `/orders` 的区别：
  - **`GET /data/orders`** — 查询订单列表（返回分页格式 `{data: [...], next_cursor: "..."}` ）
  - **`POST /order`** — 提交单个订单
  - **`POST /orders`** — 批量提交订单
  - **`DELETE /order?orderID={id}`** — 取消单个订单（query param 方式）
  - **`DELETE /orders`** — 批量取消订单
  - **`GET /data/order/{id}`** — 查询单个订单
- ⚠️ `GET /orders` 会返回 405 Method Not Allowed（该端点仅接受 POST 用于批量下单）
- ⚠️ 认证签名中的 path 必须与实际请求路径一致（如 `/data/orders` 而非 `/orders`）

### V2 makerAmount/takerAmount 精度规则（关键，易错）
- 金额单位为微单位（1e6），1 USDC = 1000000, 1 share = 1000000
- **BUY**: makerAmount(USDC) 最多5位小数 → raw 必须是 10 的倍数；takerAmount(shares) 最多2位小数 → raw 必须是 10000 的倍数
- **SELL**: makerAmount(shares) 最多2位小数 → raw 必须是 10000 的倍数；takerAmount(USDC) 最多5位小数 → raw 必须是 10 的倍数
- 整数比例法：makerAmount = priceTicks × k, takerAmount = 1000 × k
  - BUY: k 必须是 10 的倍数（保证 takerAmount=10000m, makerAmount=10m×priceTicks）
  - SELL: k 必须是 10000/gcd(priceTicks,10000) 的倍数（保证 priceTicks×k 是 10000 的倍数）
- tick size = 0.001，价格用 `Math.ceil(raw*1.02*1000)` (BUY) / `Math.floor(raw*0.98*1000)` (SELL) 避免浮点误差
