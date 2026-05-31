const XLSX = require('xlsx');
const path = 'd:\\芯化和云公司\\模型token报价\\模型报价清单_v5.xlsx';
const wb = XLSX.readFile(path);
console.log('Sheets:', wb.SheetNames);
for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  console.log(`\n=== Sheet: ${name} ===`);
  console.log('Rows:', data.length);
  for (let i = 0; i < Math.min(20, data.length); i++) {
    console.log(`Row ${i}:`, JSON.stringify(data[i]));
  }
}
