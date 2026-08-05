const XLSX = require('xlsx');
const path = require('path');
const { initDb } = require('./db');

const DATA_DIR = 'D:/桌面总文件/复盘&规划/新品监控模板';

function excelSerialToDate(serial) {
  if (!serial || serial <= 0) return null;
  const excelEpoch = new Date(1899, 11, 30);
  const date = new Date(excelEpoch.getTime() + serial * 86400000);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function cleanSku(s) {
  if (!s) return '';
  return String(s).trim().toUpperCase();
}

// =========================================================
// FIRST BATCH
// =========================================================
function parseFirstBatch(db) {
  const filePath = path.join(DATA_DIR, '第一批滤清器组套新品利润测算-最终确定.xlsx');
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const insert = db.prepare(`
    INSERT INTO profit_estimation (batch, product_code, sku, product_name, fram_model,
      estimated_price, redline_price, dd_value, material_ratio, tax_ratio,
      first_leg_ratio, last_leg_ratio, warehouse_ratio, purchase_price,
      purchase_price_ex_tax, est_first_leg_fee, est_last_leg_fee, competitor_detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (let i = 3; i < data.length; i++) {
    const row = data[i];
    if (!row[2]) continue;

    const sku = cleanSku(row[2]);
    const ptSku = cleanSku(row[1]);
    const ptName = String(row[3] || '');
    const kaxSku = cleanSku(row[4] || '');
    const kaxName = String(row[5] || '');
    const framModel = String(row[7] || '');
    const ddValue = toNum(row[59]) || toNum(row[60]) || 0;
    const compDetail = String(row[36] || '').replace(/\n/g, ' | ');

    const vals = [
      '第一批', ptSku, sku, ptName, framModel,
      toNum(row[40]), toNum(row[41]), ddValue,
      toNum(row[42]), toNum(row[43]), toNum(row[44]),
      toNum(row[45]), toNum(row[46]),
      toNum(row[19]), toNum(row[24]),
      toNum(row[25]), toNum(row[26]),
      compDetail
    ];
    insert.run(...vals);
    count++;

    if (kaxSku && kaxSku !== sku && kaxSku.length >= 7) {
      vals[2] = kaxSku;
      vals[3] = kaxName;
      insert.run(...vals);
      count++;
    }
  }
  console.log(`Parsed first batch: ${count} SKUs`);
  return count;
}

// =========================================================
// SECOND BATCH
// =========================================================
function parseSecondBatch(db) {
  const filePath = path.join(DATA_DIR, '第二批滤清器组套新品利润测算-最终确定.xlsx');
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const insert = db.prepare(`
    INSERT INTO profit_estimation (batch, product_code, sku, product_name, fram_model,
      estimated_price, redline_price, dd_value, material_ratio, tax_ratio,
      first_leg_ratio, last_leg_ratio, warehouse_ratio, purchase_price,
      purchase_price_ex_tax, est_first_leg_fee, est_last_leg_fee, competitor_detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (let i = 3; i < data.length; i++) {
    const row = data[i];
    const sku = cleanSku(row[2]);
    if (!sku || sku.length < 3) continue;

    insert.run(
      '第二批', String(row[1] || ''), sku, String(row[3] || ''), String(row[4] || ''),
      toNum(row[46]), toNum(row[49]), toNum(row[69]) || 0,
      toNum(row[50]), toNum(row[51]), toNum(row[52]),
      toNum(row[53]), toNum(row[54]),
      toNum(row[29]), toNum(row[37]),
      toNum(row[38]), toNum(row[39]),
      '' // no competitor detail in batch 2
    );
    count++;
  }
  console.log(`Parsed second batch: ${count} SKUs`);
  return count;
}

// =========================================================
// P&L: 滤清组套损益分析.xlsx
// Header at row index 7, data starts at row index 9 (skip row 8 = 合计)
// =========================================================
function parseProfitLoss(db) {
  const filePath = path.join(DATA_DIR, '滤清组套损益分析.xlsx');
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const insert = db.prepare(`
    INSERT INTO profit_loss (sku, category, month, sales_volume, sales_revenue,
      gross_profit, gross_margin, material_ratio, first_leg_ratio, last_leg_ratio,
      refund_rate, warehouse_ratio, promotion_ratio, unit_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  // Data starts at row 9 (0-indexed); row 8 is category 合计
  for (let i = 9; i < data.length; i++) {
    const row = data[i];
    const sku = cleanSku(row[2]);
    if (!sku || sku === '合计') continue;

    const month = String(row[3] || '').trim();
    if (month === '合计') continue;

    const salesVol = toNum(row[4]) || 0;
    const salesRev = toNum(row[5]) || 0;
    const unitPrice = salesVol > 0 ? salesRev / salesVol : 0;

    insert.run(
      sku, '滤清组套', month,
      salesVol, salesRev,
      toNum(row[6]) || 0, toNum(row[7]) || 0,
      toNum(row[10]) || 0, toNum(row[11]) || 0, toNum(row[12]) || 0,
      toNum(row[13]) || 0, toNum(row[14]) || 0, toNum(row[15]) || 0,
      unitPrice
    );
    count++;
  }
  console.log(`Parsed P&L: ${count} rows`);
  return count;
}

// =========================================================
// INVENTORY: 进销存报表.xlsx
// Header at row index 4, data starts at row index 6 (skip row 5 = 合计)
// =========================================================
function parseInventory(db) {
  const filePath = path.join(DATA_DIR, '进销存报表.xlsx');
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const insert = db.prepare(`
    INSERT INTO inventory (sku, brand, fba_first_arrival, fba_available_stock,
      fba_in_transit, total_stock, sales_7d, sales_14d, sales_30d)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  // Data starts at row 6 (0-indexed); row 5 is 合计
  for (let i = 6; i < data.length; i++) {
    const row = data[i];
    const sku = cleanSku(row[0]);
    if (!sku || sku === '合计') continue;

    const fbaArrival = excelSerialToDate(toNum(row[40]));

    insert.run(
      sku,
      String(row[37] || ''),     // 品牌
      fbaArrival,                 // FBA首次到货时间
      parseInt(row[7]) || 0,     // FBA可用库存
      parseInt(row[8]) || 0,     // FBA在途库存
      parseInt(row[12]) || 0,    // 总库存
      toNum(row[17]) || 0,       // 7天销量
      toNum(row[18]) || 0,       // 14天销量
      toNum(row[19]) || 0        // 30天销量
    );
    count++;
  }
  console.log(`Parsed inventory: ${count} rows`);
  return count;
}

// =========================================================
// Main
// =========================================================
function seedAll() {
  console.log('Initializing database...');
  const db = initDb();

  db.exec('DELETE FROM profit_estimation');
  db.exec('DELETE FROM profit_loss');
  db.exec('DELETE FROM inventory');
  db.exec('DELETE FROM upload_log');

  const insertLog = db.prepare(`
    INSERT INTO upload_log (filename, file_type, rows_imported, uploaded_by)
    VALUES (?, ?, ?, ?)
  `);

  console.log('\n--- Parsing Excel files ---');

  try {
    const c1 = parseFirstBatch(db);
    insertLog.run('第一批滤清器组套新品利润测算-最终确定.xlsx', 'profit_estimation', c1, 'admin');
  } catch (e) {
    console.error('Error parsing first batch:', e.message);
  }

  try {
    const c2 = parseSecondBatch(db);
    insertLog.run('第二批滤清器组套新品利润测算-最终确定.xlsx', 'profit_estimation', c2, 'admin');
  } catch (e) {
    console.error('Error parsing second batch:', e.message);
  }

  try {
    const c3 = parseProfitLoss(db);
    insertLog.run('滤清组套损益分析.xlsx', 'profit_loss', c3, 'admin');
  } catch (e) {
    console.error('Error parsing P&L:', e.message);
  }

  try {
    const c4 = parseInventory(db);
    insertLog.run('进销存报表.xlsx', 'inventory', c4, 'admin');
  } catch (e) {
    console.error('Error parsing inventory:', e.message);
  }

  const peCount = db.prepare('SELECT COUNT(*) as c FROM profit_estimation').get().c;
  const plCount = db.prepare('SELECT COUNT(*) as c FROM profit_loss').get().c;
  const invCount = db.prepare('SELECT COUNT(*) as c FROM inventory').get().c;

  console.log('\n--- Seed Complete ---');
  console.log(`profit_estimation: ${peCount} rows`);
  console.log(`profit_loss: ${plCount} rows`);
  console.log(`inventory: ${invCount} rows`);
}

seedAll();
