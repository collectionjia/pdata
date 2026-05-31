const XLSX = require('xlsx');
const fs = require('fs');
const srcPath = 'd:\\芯化和云公司\\模型token报价\\模型报价清单_v5.xlsx';
const outPath = 'd:\\芯化和云公司\\模型token报价\\模型报价清单_v6.xlsx';
const backupPath = 'd:\\芯化和云公司\\模型token报价\\模型报价清单_v5_backup.xlsx';

// 备份原文件（若尚未备份）
if (!fs.existsSync(backupPath)) {
  fs.copyFileSync(srcPath, backupPath);
  console.log('已备份至:', backupPath);
}

const wb = XLSX.readFile(srcPath);
const sheetName = wb.SheetNames[0];
const ws = wb.Sheets[sheetName];
const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
const headers = data[0];

// 更新表头：加0.5 -> 加5%
for (let i = 0; i < headers.length; i++) {
  if (headers[i] && String(headers[i]).includes('加0.5')) {
    headers[i] = String(headers[i]).replace(/加0\.5/g, '加5%');
  }
}

// 原价与加5%列配对
const pairs = [];
for (let i = 0; i < headers.length; i++) {
  const h = headers[i];
  if (h && String(h).includes('加5%')) {
    pairs.push({ idxOrig: i - 1, idxAdj: i });
  }
}

function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function roundPrice(n) {
  // 保留合理精度，避免浮点误差
  return Math.round(n * 1e6) / 1e6;
}

let updatedCount = 0;

for (let r = 1; r < data.length; r++) {
  const row = data[r];
  for (const { idxOrig, idxAdj } of pairs) {
    const orig = num(row[idxOrig]);
    if (orig !== null) {
      row[idxAdj] = roundPrice(orig * 1.05);
      updatedCount++;
    } else {
      row[idxAdj] = '';
    }
  }
}

// 重算芯化兰德列
const idx = {
  s1in: headers.indexOf('供应商1输入单价加5%价格'),
  s1inc: headers.indexOf('供应商1输入缓存命中价格加5%价格'),
  s1out: headers.indexOf('供应商1输出单价加5%价格'),
  s1outc: headers.indexOf('供应商1输出缓存单价加5%价格'),
  s2in: headers.indexOf('供应商2输入单价加5%价格'),
  s2out: headers.indexOf('供应商2输出单价加5%价格'),
  s2cache: headers.indexOf('供应商2缓存单价加5%价格'),
  s2call: headers.indexOf('供应商2按次单价加5%价格'),
  xhIn: headers.indexOf('芯化兰德输入价格'),
  xhOut: headers.indexOf('芯化兰德输出价格'),
  xhCache: headers.indexOf('芯化兰德缓存价格'),
  xhCall: headers.indexOf('芯化兰德按次价格'),
};

function maxVal(...vals) {
  const nums = vals.map(num).filter(v => v !== null);
  return nums.length ? roundPrice(Math.max(...nums)) : '';
}

for (let r = 1; r < data.length; r++) {
  const row = data[r];
  if (!row[1]) continue;

  const inVal = maxVal(row[idx.s1in], row[idx.s2in]);
  const outVal = maxVal(row[idx.s1out], row[idx.s2out]);
  const cacheVal = maxVal(row[idx.s1inc], row[idx.s2cache]);
  const callVal = num(row[idx.s2call]);

  row[idx.xhIn] = inVal;
  row[idx.xhOut] = outVal;
  row[idx.xhCache] = cacheVal;
  row[idx.xhCall] = callVal !== null ? roundPrice(callVal) : '';
}

// 写回文件
const newWs = XLSX.utils.aoa_to_sheet(data);
wb.Sheets[sheetName] = newWs;
XLSX.writeFile(wb, outPath);
console.log('已保存至:', outPath);
console.log('共更新加5%价格单元格:', updatedCount, '个');

// 打印部分示例
console.log('\n示例对比 (deepseek-v3):');
const sample = data.find(r => r[1] === 'deepseek-v3');
if (sample) {
  console.log('  供应商1输入: 原价', sample[11], '-> 加5%', sample[12]);
  console.log('  供应商1输出: 原价', sample[15], '-> 加5%', sample[16]);
  console.log('  芯化兰德输入:', sample[idx.xhIn], '输出:', sample[idx.xhOut]);
}
