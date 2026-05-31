/**
 * Polymarket CLOB API L2 认证测试脚本
 * 用法: node test_api.mjs
 * 
 * 测试步骤:
 * 1. 同步服务器时间 (GET /time)
 * 2. 使用 API Key + Secret 进行 HMAC-SHA256 签名
 * 3. 调用 GET /data/orders 验证认证是否通过
 */

import { createHmac } from 'crypto';
import https from 'https';

const CLOB_HOST = 'https://clob.polymarket.com';

// ===== 配置区域 — 请填入你的凭证 =====
const CONFIG = {
  apiKey:    process.env.POLY_API_KEY    || '',
  apiSecret: process.env.POLY_API_SECRET || '',
  apiPass:   process.env.POLY_API_PASS   || '',
  address:   process.env.POLY_ADDRESS    || '',  // EOA 地址
  sigType:   1,  // 签名类型: 0=EOA, 1=POLY_PROXY, 2=POLY_GNOSIS
};
// =========================================

function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = https.request(reqOptions, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// URL-safe Base64 编码 (与 TypeScript 客户端一致：保留 = padding)
function urlSafeBase64(buffer) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
    // 注意：不删除 = padding！TypeScript 客户端要求保留
}

// HMAC-SHA256 签名 (L2 认证)
// 1. API Secret 是 URL-safe Base64 编码的，先解码为原始字节
// 2. 用原始字节作为 HMAC 密钥
// 3. 签名消息格式: timestamp + method + path + body
// 4. 签名结果用 URL-safe Base64 编码
function hmacSign(secretB64, message) {
  // URL-safe Base64 → 标准 Base64
  let normalized = secretB64.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  if (pad > 0) normalized += '='.repeat(4 - pad);
  
  // Base64 解码为原始字节
  const secretBytes = Buffer.from(normalized, 'base64');
  
  // HMAC-SHA256 签名
  const signature = createHmac('sha256', secretBytes).update(message).digest();
  
  // URL-safe Base64 编码
  return urlSafeBase64(signature);
}

// 构建 L2 认证 headers
function getL2Headers(method, path, body = '', timestamp) {
  const message = timestamp + method + path + body;
  const signature = hmacSign(CONFIG.apiSecret, message);
  
  return {
    'POLY_ADDRESS':     CONFIG.address,
    'POLY_API_KEY':     CONFIG.apiKey,
    'POLY_SIGNATURE':   signature,
    'POLY_TIMESTAMP':   timestamp,
    'POLY_PASSPHRASE':  CONFIG.apiPass || '',
    'Content-Type':     'application/json',
  };
}

async function main() {
  console.log('=== Polymarket CLOB API L2 认证测试 ===\n');
  console.log('签名类型: sigType =', CONFIG.sigType, 
    ['EOA', 'POLY_PROXY', 'POLY_GNOSIS'][CONFIG.sigType] || '未知');
  
  // 检查配置
  if (!CONFIG.apiKey || !CONFIG.apiSecret || !CONFIG.address) {
    console.error('❌ 缺少必要配置！请设置环境变量:');
    console.error('   POLY_API_KEY     - API Key (UUID)');
    console.error('   POLY_API_SECRET  - API Secret (Base64)');
    console.error('   POLY_ADDRESS     - EOA 地址');
    console.error('   POLY_API_PASS    - API Passphrase (可选)');
    console.error('\n示例:');
    console.error('   POLY_API_KEY=xxx POLY_API_SECRET=yyy POLY_ADDRESS=0x... node test_api.mjs');
    process.exit(1);
  }
  
  console.log('API Key:', CONFIG.apiKey.slice(0, 8) + '...');
  console.log('Address:', CONFIG.address);
  console.log('Secret (前8字符):', CONFIG.apiSecret.slice(0, 8) + '...');
  console.log('Passphrase:', CONFIG.apiPass ? '***已配置***' : '(空)');
  
  // 步骤1: 同步服务器时间
  console.log('\n--- 步骤1: 同步服务器时间 ---');
  let serverTimeOffset = 0;
  try {
    const localBefore = Math.floor(Date.now() / 1000);
    const timeResp = await fetchJSON(CLOB_HOST + '/time');
    const localAfter = Math.floor(Date.now() / 1000);
    
    if (timeResp.status !== 200) {
      console.error('❌ 获取服务器时间失败:', timeResp.status, timeResp.body.slice(0, 200));
    } else {
      const data = JSON.parse(timeResp.body);
      const serverTs = parseInt(data.timestamp || data);
      const localMid = Math.floor((localBefore + localAfter) / 2);
      serverTimeOffset = serverTs - localMid;
      console.log('✅ 服务器时间同步成功');
      console.log('   服务器时间戳:', serverTs);
      console.log('   本地时间戳:', localMid);
      console.log('   偏移量:', serverTimeOffset, '秒');
    }
  } catch (e) {
    console.error('⚠️ 时间同步失败:', e.message, '(将使用本地时间)');
  }
  
  // 步骤2: 测试 L2 认证 (GET /data/orders)
  console.log('\n--- 步骤2: 测试 L2 认证 (GET /data/orders) ---');
  const timestamp = (Math.floor(Date.now() / 1000) + serverTimeOffset).toString();
  const method = 'GET';
  const path = '/data/orders';
  const headers = getL2Headers(method, path, '', timestamp);
  
  console.log('签名消息:', timestamp + method + path);
  console.log('请求 Headers:');
  Object.entries(headers).forEach(([k, v]) => {
    const display = k === 'POLY_SIGNATURE' ? v.slice(0, 20) + '...' : v;
    console.log(`  ${k}: ${display}`);
  });
  
  try {
    const resp = await fetchJSON(CLOB_HOST + path, { headers });
    console.log('\n响应状态:', resp.status, resp.headers['content-type'] || '');
    
    if (resp.status === 200) {
      let data;
      try { data = JSON.parse(resp.body); } catch(e) { data = resp.body; }
      const orders = data?.data || (Array.isArray(data) ? data : data?.orders) || [];
      console.log('✅ 认证成功！获取到', orders.length, '个订单');
      if (orders.length > 0) {
        console.log('   第一个订单:', JSON.stringify(orders[0]).slice(0, 200));
      }
    } else {
      console.error('❌ 认证失败！');
      console.error('   HTTP', resp.status);
      console.error('   响应:', resp.body.slice(0, 500));
      
      // 诊断建议
      console.log('\n--- 诊断建议 ---');
      if (resp.status === 401) {
        const errBody = resp.body.toLowerCase();
        if (errBody.includes('invalid api key')) {
          console.log('• API Key 无效 — 检查 POLY_API_KEY 是否正确');
          console.log('• 检查 POLY_ADDRESS 是否与 API Key 对应的 EOA 地址一致');
        }
        if (errBody.includes('signature')) {
          console.log('• 签名验证失败 — 检查:');
          console.log('  - API Secret 是否正确（URL-safe Base64 格式）');
          console.log('  - 时间戳是否与服务器同步（当前偏移 ' + serverTimeOffset + ' 秒）');
          console.log('  - 签名消息格式: timestamp + method + path + body');
        }
        console.log('• 签名类型当前为 sigType=' + CONFIG.sigType + 
          '，如果不对请修改脚本中的 sigType');
        console.log('  - sigType=0: 无代理钱包 (EOA)');
        console.log('  - sigType=1: Email/Magic Link 登录 (POLY_PROXY)');
        console.log('  - sigType=2: MetaMask 登录 (POLY_GNOSIS)');
      }
    }
  } catch (e) {
    console.error('❌ 请求失败:', e.message);
  }
  
  // 步骤3: 测试其他只读端点
  console.log('\n--- 步骤3: 测试其他端点 (无需认证) ---');
  try {
    const resp = await fetchJSON(CLOB_HOST + '/markets?next_cursor=MA==');
    if (resp.status === 200) {
      const data = JSON.parse(resp.body);
      console.log('✅ GET /markets 成功，返回', (data.data || []).length, '个市场');
    } else {
      console.log('⚠️ GET /markets 返回', resp.status);
    }
  } catch(e) {
    console.error('❌ /markets 失败:', e.message);
  }
  
  console.log('\n=== 测试完成 ===');
}

main().catch(console.error);
