const XLSX = require('xlsx');
const path = 'd:\\芯化和云公司\\模型token报价\\模型报价清单_v5.xlsx';
const wb = XLSX.readFile(path);
const ws = wb.Sheets['报价汇总'];
const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
const headers = data[0];

console.log('All headers with index:');
headers.forEach((h, i) => { if (h) console.log(i, h); });

// Find pairs: original -> +0.5
const pairs = [];
for (let i = 0; i < headers.length; i++) {
  const h = headers[i];
  if (h && String(h).includes('加0.5')) {
    // find corresponding original column (usually previous non-empty or specific pattern)
    const baseName = String(h).replace('加0.5价格', '').replace('单价加0.5', '');
    pairs.push({ idx0: i - 1, idx05: i, header0: headers[i-1], header05: h });
  }
}
console.log('\nPairs:');
pairs.forEach(p => console.log(p));

// Check 芯化兰德 derivation
const xh = ['芯化兰德输入价格','芯化兰德输出价格','芯化兰德缓存价格','芯化兰德按次价格'];
const xhIdx = xh.map(n => headers.indexOf(n));
console.log('\n芯化兰德 indices:', xhIdx);

// Sample verification rows
for (let r = 1; r < Math.min(15, data.length); r++) {
  const row = data[r];
  if (!row[1]) continue;
  console.log(`\n${row[1]}:`);
  pairs.forEach(p => {
    const orig = row[p.idx0];
    const adj = row[p.idx05];
    if (orig !== '' && orig !== undefined) {
      console.log(`  ${p.header0}: ${orig} -> ${adj} (orig+0.5=${Number(orig)+0.5}, orig*1.05=${Number(orig)*1.05})`);
    }
  });
  xh.forEach((n, i) => {
    const v = row[xhIdx[i]];
    if (v !== '') console.log(`  ${n}: ${v}`);
  });
}
