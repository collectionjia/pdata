const XLSX = require('xlsx');
const path = 'd:\\芯化和云公司\\模型token报价\\模型报价清单_v5.xlsx';
const wb = XLSX.readFile(path);
const data = XLSX.utils.sheet_to_json(wb.Sheets['报价汇总'], { header: 1, defval: '' });
const headers = data[0];

// Check 芯化兰德 logic for all rows with data
const idx = {
  s1in: headers.indexOf('供应商1输入单价加0.5价格'),
  s1inc: headers.indexOf('供应商1输入缓存命中价格加0.5价格'),
  s1out: headers.indexOf('供应商1输出单价加0.5价格'),
  s1outc: headers.indexOf('供应商1输出缓存单价加0.5价格'),
  s2in: headers.indexOf('供应商2输入单价加0.5价格'),
  s2out: headers.indexOf('供应商2输出单价加0.5价格'),
  s2cache: headers.indexOf('供应商2缓存单价加0.5价格'),
  s2call: headers.indexOf('供应商2按次单价加0.5价格'),
  xhIn: headers.indexOf('芯化兰德输入价格'),
  xhOut: headers.indexOf('芯化兰德输出价格'),
  xhCache: headers.indexOf('芯化兰德缓存价格'),
  xhCall: headers.indexOf('芯化兰德按次价格'),
};

function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function maxVal(...vals) {
  const nums = vals.map(num).filter(v => v !== null);
  return nums.length ? Math.max(...nums) : null;
}

let mismatches = [];
for (let r = 1; r < data.length; r++) {
  const row = data[r];
  if (!row[1]) continue;
  const xhIn = num(row[idx.xhIn]);
  const xhOut = num(row[idx.xhOut]);
  const xhCache = num(row[idx.xhCache]);
  const xhCall = num(row[idx.xhCall]);

  const predIn = maxVal(row[idx.s1in], row[idx.s2in]);
  const predOut = maxVal(row[idx.s1out], row[idx.s2out]);
  const predCache = maxVal(row[idx.s1inc], row[idx.s2cache]);
  const predCall = num(row[idx.s2call]);

  if (xhIn !== null && predIn !== null && Math.abs(xhIn - predIn) > 0.0001)
    mismatches.push({ model: row[1], field: 'input', xh: xhIn, pred: predIn, s1: row[idx.s1in], s2: row[idx.s2in] });
  if (xhOut !== null && predOut !== null && Math.abs(xhOut - predOut) > 0.0001)
    mismatches.push({ model: row[1], field: 'output', xh: xhOut, pred: predOut, s1: row[idx.s1out], s2: row[idx.s2out] });
  if (xhCache !== null && predCache !== null && Math.abs(xhCache - predCache) > 0.0001)
    mismatches.push({ model: row[1], field: 'cache', xh: xhCache, pred: predCache, s1inc: row[idx.s1inc], s2cache: row[idx.s2cache] });
  if (xhCall !== null && predCall !== null && Math.abs(xhCall - predCall) > 0.0001)
    mismatches.push({ model: row[1], field: 'call', xh: xhCall, pred: predCall });
}
console.log('Mismatches:', mismatches.length);
mismatches.slice(0, 20).forEach(m => console.log(m));
