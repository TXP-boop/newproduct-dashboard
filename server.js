const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const { initDb, getDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3456;

// Initialize database
initDb();

// Auto-import built-in template if DB is empty (Render persistence)
const db = getDb();
const rowCount = db.prepare('SELECT COUNT(*) as c FROM profit_estimation').get().c;
if (rowCount === 0) {
  const fs = require('fs');
  const path = require('path');
  const tmplPath = path.join(__dirname, 'public', 'template.xlsx');
  if (fs.existsSync(tmplPath)) {
    console.log('Database empty, auto-importing from template...');
    try {
      const XLSX = require('xlsx');
      const wb = XLSX.readFile(tmplPath);
      wb.SheetNames.forEach(sn => {
        const data = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' });
        let type;
        if (sn.includes('利润测算')) type = 'profit_estimation';
        else if (sn.includes('损益')) type = 'profit_loss';
        else if (sn.includes('进销存')) type = 'inventory';
        else return;
        const count = importExcelData(db, data, type, '滤清组套');
        console.log(`  ${sn}: ${count} rows imported`);
      });
    } catch(e) {
      console.log('Auto-import error:', e.message);
    }
  }

  // Restore scraped competitor data from backup
  const scrapedBackup = require('path').join(__dirname, 'scraped_backup.json');
  if (fs.existsSync(scrapedBackup)) {
    try {
      const backup = JSON.parse(fs.readFileSync(scrapedBackup, 'utf8'));
      let restored = 0;
      for (const s of backup) {
        const r = db.prepare("UPDATE profit_estimation SET competitor_detail = ? WHERE sku = ? AND competitor_detail NOT LIKE '%[$%'").run(s.competitor_detail, s.sku);
        restored += r.changes;
      }
      if (restored > 0) console.log('Restored scraped data for ' + restored + ' SKUs');
    } catch(e) {}
  }
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'npd-secret-' + Math.random().toString(36),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24h
}));

// File upload config
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls', '.csv'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持 Excel/CSV 文件'));
    }
  }
});

// Auth middleware
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: '请先登录' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  if (req.session.user.role === 'admin') return next(); // system admin

  // Check category-level admin
  const category = req.body.category || req.query.category || req.session.currentCategory;
  if (category) {
    const db = getDb();
    const ca = db.prepare('SELECT * FROM category_admins WHERE user_id = ? AND category = ?').get(req.session.user.id, category);
    if (ca) return next();
  }
  return res.status(403).json({ error: '需要品类管理员权限' });
}

// Check if user can manage a category
function canManageCategory(db, userId, category) {
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  if (user && user.role === 'admin') return true;
  const ca = db.prepare('SELECT * FROM category_admins WHERE user_id = ? AND category = ?').get(userId, category);
  return !!ca;
}

// ============================================================
// AUTH ROUTES
// ============================================================
app.post('/api/login', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '请输入姓名' });
  }
  const db = getDb();
  let user = db.prepare('SELECT * FROM users WHERE name = ?').get(name.trim());
  if (!user) {
    db.prepare('INSERT INTO users (name, role) VALUES (?, ?)').run(name.trim(), 'viewer');
    user = db.prepare('SELECT * FROM users WHERE name = ?').get(name.trim());
  }
  req.session.user = { id: user.id, name: user.name, role: user.role };
  res.json({ success: true, user: { id: user.id, name: user.name, role: user.role } });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/user', (req, res) => {
  if (!req.session.user) return res.json({ user: null });
  const db = getDb();
  const cats = db.prepare('SELECT category FROM category_admins WHERE user_id = ?').all(req.session.user.id);
  res.json({ user: { ...req.session.user, managed_categories: cats.map(c => c.category) } });
});

app.post('/api/user/category', (req, res) => {
  // Save user's last selected category to session
  if (req.body.category) {
    req.session.currentCategory = req.body.category;
  }
  res.json({ success: true });
});

// ============================================================
// CATEGORY API
// ============================================================
app.get('/api/categories', (req, res) => {
  const db = getDb();
  const cats = db.prepare('SELECT * FROM categories ORDER BY id').all();
  res.json({ categories: cats });
});

app.post('/api/categories', requireAdmin, (req, res) => {
  const db = getDb();
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: '请输入品类名称' });
  try {
    db.prepare('INSERT INTO categories (name) VALUES (?)').run(name.trim());
    res.json({ success: true });
  } catch(e) {
    res.status(400).json({ error: '品类已存在' });
  }
});

// Helper: extract category from query or session
function getCategory(req) {
  return req.query.category || req.session.currentCategory || '滤清组套';
}

// Helper: filter list by launch month
function filterByLaunchMonth(items, monthsParam, skuField) {
  if (!monthsParam) return items;
  const monthSet = new Set(monthsParam.split(',').map(m => parseInt(m.trim())));
  const db = getDb();
  return items.filter(item => {
    // Try to get SKU: from comma-separated skus field first, then from sku field
    let sku = null;
    if (item.skus && typeof item.skus === 'string') sku = item.skus.split(',')[0].trim();
    if (!sku) sku = typeof item === 'string' ? item : (item[skuField || 'sku'] || item.sku);
    if (!sku) return false;
    const inv = db.prepare('SELECT fba_first_arrival FROM inventory WHERE sku = ?').get(sku);
    if (!inv || !inv.fba_first_arrival) return false;
    return monthSet.has(new Date(inv.fba_first_arrival).getMonth() + 1);
  });
}

// ============================================================
// DASHBOARD API
// ============================================================

// Helper: get new product period months (上架次月/次次月/次次次月)
// 1月上架 → 新品期为2、3、4月
function getNewProductMonths(db, sku) {
  const inv = db.prepare('SELECT fba_first_arrival FROM inventory WHERE sku = ?').get(sku);
  if (!inv || !inv.fba_first_arrival) return null;
  const arrival = new Date(inv.fba_first_arrival);
  const months = [];
  for (let i = 1; i <= 3; i++) { // i=1次月, i=2次次月, i=3次次次月
    const d = new Date(arrival.getFullYear(), arrival.getMonth() + i, 1);
    months.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return { arrival: inv.fba_first_arrival, months };
}

// Panel 1: KPI Achievement (支持按月/品类筛选)
app.get('/api/dashboard/kpi', requireAuth, (req, res) => {
  const db = getDb();
  const { months } = req.query;
  const category = getCategory(req);

  let allSkus = db.prepare(`
    SELECT pe.sku, pe.dd_value, pe.estimated_price, pe.redline_price,
           pe.fram_model, pe.product_name, pe.batch,
           inv.fba_first_arrival, inv.brand
    FROM profit_estimation pe
    LEFT JOIN inventory inv ON pe.sku = inv.sku AND pe.category = inv.category
    WHERE pe.category = ?
  `).all(category); // Include all SKUs, even without inventory

  // Filter by launch month if specified
  if (months) {
    const monthSet = new Set(months.split(',').map(m => parseInt(m.trim())));
    allSkus = allSkus.filter(s => {
      if (!s.fba_first_arrival) return false;
      const launchMonth = new Date(s.fba_first_arrival).getMonth() + 1; // 1-12
      return monthSet.has(launchMonth);
    });
  }

  const results = [];
  let totalEstimatedDD = 0;
  let totalActualDD = 0;

  for (const sku of allSkus) {
    if (!sku.fba_first_arrival) {
      results.push({ sku: sku.sku, product_name: sku.product_name, fram_model: sku.fram_model, brand: sku.brand, batch: sku.batch, launch_date: null, has_sales: false, max_monthly_sales: 0, np_margin: null, latest_margin: null, actual_dd: 0, estimated_dd: sku.dd_value || 0, dd_achievement: 0 });
      continue;
    }

    const npMonths = getNewProductMonths(db, sku.sku);
    if (!npMonths) continue;

    // Get monthly P&L data for this SKU in the new product period
    const placeholders = npMonths.months.map(() => '?').join(',');
    const monthlyData = db.prepare(`
      SELECT month, sales_volume, sales_revenue, gross_profit, gross_margin
      FROM profit_loss
      WHERE sku = ? AND month IN (${placeholders})
      ORDER BY month
    `).get(sku.sku, ...npMonths.months);

    // Also get ALL monthly data for finding max
    const allMonthly = db.prepare(`
      SELECT month, SUM(sales_volume) as sales_volume, SUM(sales_revenue) as sales_revenue, SUM(gross_profit) as gross_profit, AVG(gross_margin) as gross_margin
      FROM profit_loss
      WHERE sku = ? AND month IN (${placeholders})
      GROUP BY month
    `).all(sku.sku, ...npMonths.months);

    if (allMonthly.length === 0) {
      results.push({
        sku: sku.sku,
        product_name: sku.product_name,
        fram_model: sku.fram_model,
        batch: sku.batch,
        launch_date: sku.fba_first_arrival,
        has_sales: false,
        max_monthly_sales: 0,
        np_margin: null,
        latest_margin: null,
        actual_dd: 0,
        estimated_dd: sku.dd_value || 0,
        dd_achievement: 0
      });
      continue;
    }

    // Find max sales month (only consider months with actual sales)
    const monthsWithSales = allMonthly.filter(m => (m.sales_volume || 0) > 0);
    if (monthsWithSales.length === 0) {
      results.push({
        sku: sku.sku, product_name: sku.product_name, fram_model: sku.fram_model,
        batch: sku.batch, launch_date: sku.fba_first_arrival,
        has_sales: false, max_monthly_sales: 0, np_margin: null, latest_margin: null,
        actual_dd: 0, estimated_dd: sku.dd_value || 0, dd_achievement: 0
      });
      continue;
    }

    const maxSales = monthsWithSales.reduce((max, m) =>
      (m.sales_volume || 0) > (max.sales_volume || 0) ? m : max, monthsWithSales[0]);

    const actualDD = (maxSales.sales_volume || 0) / 30;
    const estimatedDD = sku.dd_value || 0;

    totalActualDD += actualDD;
    totalEstimatedDD += estimatedDD;

    // 新品期毛利率 = 新品期内累计毛利额 / 累计销售额
    const npTotalProfit = allMonthly.reduce((s, m) => s + (m.gross_profit || 0), 0);
    const npTotalRevenue = allMonthly.reduce((s, m) => s + (m.sales_revenue || 0), 0);
    const npMargin = npTotalRevenue > 0 ? npTotalProfit / npTotalRevenue : null;

    // 最新月份毛利率
    const latestPL = db.prepare(`SELECT gross_margin FROM profit_loss WHERE sku=? AND sales_volume>0 ORDER BY month DESC LIMIT 1`).get(sku.sku);
    const latestMargin = latestPL ? latestPL.gross_margin : null;

    results.push({
      sku: sku.sku,
      product_name: sku.product_name,
      fram_model: sku.fram_model,
      brand: sku.brand,
      batch: sku.batch,
      launch_date: sku.fba_first_arrival,
      has_sales: true,
      max_monthly_sales: Math.round(maxSales.sales_volume || 0),
      max_month: maxSales.month,
      np_margin: npMargin,
      np_total_profit: Math.round(npTotalProfit * 100) / 100,
      np_total_revenue: Math.round(npTotalRevenue * 100) / 100,
      latest_margin: latestMargin,
      actual_dd: Math.round(actualDD * 100) / 100,
      estimated_dd: Math.round(estimatedDD * 100) / 100,
      dd_achievement: estimatedDD > 0 ? Math.round((actualDD / estimatedDD) * 10000) / 100 : 0,
      monthly_detail: allMonthly
    });
  }

  const launchedCount = results.length;
  const activeCount = results.filter(r => r.has_sales).length;
  const salesActivationRate = launchedCount > 0 ? Math.round((activeCount / launchedCount) * 10000) / 100 : 0;
  const ddAchievementRate = totalEstimatedDD > 0 ? Math.round((totalActualDD / totalEstimatedDD) * 10000) / 100 : 0;

  // 毛利率 = 新品期内 ΣSKU累计毛利额 / ΣSKU累计销售额 × 100%
  const totalProfit = results.filter(r => r.has_sales).reduce((s, r) => s + (r.np_total_profit || 0), 0);
  const totalRevenue = results.filter(r => r.has_sales).reduce((s, r) => s + (r.np_total_revenue || 0), 0);
  const grossMargin = totalRevenue > 0 ? Math.round((totalProfit / totalRevenue) * 10000) / 100 : 0;

  res.json({
    summary: {
      launched_count: launchedCount,
      active_count: activeCount,
      sales_activation_rate: salesActivationRate,
      dd_achievement_rate: ddAchievementRate,
      gross_margin: grossMargin,
      total_estimated_dd: Math.round(totalEstimatedDD * 100) / 100,
      total_actual_dd: Math.round(totalActualDD * 100) / 100
    },
    details: results
  });
});

// Panel 2: Fee Rate Comparison (FBA渠道)
app.get('/api/dashboard/fees', requireAuth, (req, res) => {
  const db = getDb();
  const category = getCategory(req);

  const skus = db.prepare(`
    SELECT pe.sku, pe.product_name, pe.fram_model, pe.batch,
      pe.material_ratio as est_material, pe.first_leg_ratio as est_first_leg,
      pe.last_leg_ratio as est_last_leg, pe.warehouse_ratio as est_warehouse,
      pe.estimated_price as est_price, pe.redline_price, pe.dd_value as est_dd,
      pe.est_promotion_rate, pe.est_refund_rate,
      inv.fba_first_arrival
    FROM profit_estimation pe
    LEFT JOIN inventory inv ON pe.sku = inv.sku AND pe.category = inv.category
    WHERE inv.fba_first_arrival IS NOT NULL AND pe.category = ?
  `).all(category);
  const results = [];

  for (const sku of skus) {
    const npMonths = getNewProductMonths(db, sku.sku);
    if (!npMonths) continue;

    const placeholders = npMonths.months.map(() => '?').join(',');
    const monthlyData = db.prepare(`
      SELECT month, sales_volume, sales_revenue, gross_profit, gross_margin,
             material_ratio, first_leg_ratio, last_leg_ratio,
             refund_rate, warehouse_ratio, promotion_ratio
      FROM profit_loss
      WHERE sku = ? AND month IN (${placeholders})
    `).all(sku.sku, ...npMonths.months);

    if (monthlyData.length === 0) continue;

    // Find max sales month
    const totalVol = monthlyData.reduce((s,m)=>s+(m.sales_volume||0),0);
    const totalRev = monthlyData.reduce((s,m)=>s+(m.sales_revenue||0),0);
    const wavg = (field) => totalVol===0?0:monthlyData.reduce((s,m)=>s+(m[field]||0)*(m.sales_volume||0),0)/totalVol;
    const actualUnitPriceRMB = totalVol>0 ? totalRev/totalVol : 0;
    const actualUnitPriceUSD = actualUnitPriceRMB / 6.7;
    const estPrice = sku.est_price || 1;
    // 实测费率 = 实际占比 × 实际售价$ / 测算价$（消除售价变化对占比的影响）
    const priceRatio = actualUnitPriceUSD / estPrice;
    const revenue = totalRev || 1;

    function feeObj(estRate, actRate) {
      return {
        estimated_rate: estRate || 0,
        actual_rate: actRate || 0,
        adjusted_rate: (actRate || 0) * priceRatio,
        estimated_value: (estRate || 0) * revenue,
        actual_value: (actRate || 0) * revenue,
        adjusted_value: (actRate || 0) * priceRatio * revenue
      };
    }

    results.push({
      sku: sku.sku,
      product_name: sku.product_name,
      batch: sku.batch,
      launch_date: sku.fba_first_arrival,
      max_sales_month: '',
      revenue: Math.round(totalRev*100)/100,
      actual_unit_price: Math.round(actualUnitPriceUSD * 100) / 100,
      estimated_price: estPrice,
      fees: {
        first_leg: feeObj(sku.est_first_leg, wavg('first_leg_ratio')),
        last_leg: feeObj(sku.est_last_leg, wavg('last_leg_ratio')),
        warehouse: feeObj(sku.est_warehouse, wavg('warehouse_ratio')),
        promotion: feeObj(sku.est_promotion_rate || 0, wavg('promotion_ratio')),
        refund: feeObj(sku.est_refund_rate || 0.0336, wavg('refund_rate'))
      }
    });
  }

  // 汇总费率 = Σ各SKU费用额 ÷ Σ各SKU销售额（销售额加权，非各SKU费率的算术平均）
  // 测算费用额 = 测算费率% × 实际销售额（用实际销售额做权重，确保与实测口径一致，差异仅来自费率偏差）
  // 实测费用额已消除售价偏差，公式：实际占比 × (实际售价$/测算价$) × 实际销售额
  const summary = {
    first_leg: { est_total: 0, act_total: 0 },
    last_leg: { est_total: 0, act_total: 0 },
    warehouse: { est_total: 0, act_total: 0 },
    promotion: { est_total: 0, act_total: 0 },
    refund: { est_total: 0, act_total: 0 }
  };

  for (const r of results) {
    for (const key of ['first_leg', 'last_leg', 'warehouse', 'promotion', 'refund']) {
      summary[key].est_total += r.fees[key].estimated_value;
      summary[key].act_total += r.fees[key].actual_value;
    }
  }

  const totalRevenue = results.reduce((s, r) => s + r.revenue, 0);
  for (const key of ['first_leg', 'last_leg', 'warehouse']) {
    summary[key].est_rate = totalRevenue > 0 ? Math.round((summary[key].est_total / totalRevenue) * 10000) / 100 : 0;
    summary[key].act_rate = totalRevenue > 0 ? Math.round((summary[key].act_total / totalRevenue) * 10000) / 100 : 0;
  }
  // promotion and refund rates from template data
  summary.promotion.est_rate = totalRevenue > 0 ? Math.round((summary.promotion.est_total / totalRevenue) * 10000) / 100 : 0;
  summary.promotion.act_rate = totalRevenue > 0 ? Math.round((summary.promotion.act_total / totalRevenue) * 10000) / 100 : 0;
  summary.refund.est_rate = totalRevenue > 0 ? Math.round((summary.refund.est_total / totalRevenue) * 10000) / 100 : 0;
  summary.refund.act_rate = totalRevenue > 0 ? Math.round((summary.refund.act_total / totalRevenue) * 10000) / 100 : 0;

  const { months } = req.query;
  res.json({ summary, details: months ? filterByLaunchMonth(results, months, 'sku') : results });
});

// Panel 3: Price Monitoring (按型号聚合 + SKU级别图表)
app.get('/api/dashboard/price', requireAuth, (req, res) => {
  const db = getDb();
  const { search } = req.query;
  const category = getCategory(req);

  let modelQuery = `
    SELECT pe.fram_model,
           GROUP_CONCAT(pe.sku) as skus,
           MAX(pe.product_name) as product_name,
           MAX(pe.estimated_price) as estimated_price,
           MAX(pe.redline_price) as redline_price,
           MAX(pe.competitor_detail) as competitor_detail,
           MAX(pe.batch) as batch,
           MAX(inv.fba_first_arrival) as fba_first_arrival
    FROM profit_estimation pe
    LEFT JOIN inventory inv ON pe.sku = inv.sku AND pe.category = inv.category
    WHERE pe.fram_model != '' AND inv.fba_first_arrival IS NOT NULL AND pe.category = ?
  `;

  const { months } = req.query;
  if (search) {
    modelQuery += ` AND (pe.fram_model LIKE ? OR pe.sku LIKE ?)`;
    let models = db.prepare(modelQuery + ' GROUP BY pe.fram_model ORDER BY pe.fram_model').all(category, `%${search}%`, `%${search}%`);
    if (months) models = filterByLaunchMonth(models, months, 'fram_model');
    return processPriceResults(models, db, res);
  }

  let models = db.prepare(modelQuery + ' GROUP BY pe.fram_model ORDER BY pe.fram_model').all(category);
  if (months) models = filterByLaunchMonth(models, months, 'fram_model');
  processPriceResults(models, db, res);
});

// SKU-level price data for chart (top 30 by NP sales volume)
app.get('/api/dashboard/price-sku', requireAuth, (req, res) => {
  const db = getDb();
  const category = getCategory(req);

  const skus = db.prepare(`
    SELECT pe.sku, pe.product_name, pe.fram_model, pe.batch,
           pe.estimated_price, pe.redline_price, pe.competitor_detail,
           inv.fba_first_arrival
    FROM profit_estimation pe
    LEFT JOIN inventory inv ON pe.sku = inv.sku AND pe.category = inv.category
    WHERE inv.fba_first_arrival IS NOT NULL AND pe.category = ?
  `).all(category);

  let filteredSkus = skus;
  const { months } = req.query;
  if (months) filteredSkus = filterByLaunchMonth(skus, months, 'sku');

  const results = [];
  for (const sku of filteredSkus) {
    const npMonths = getNewProductMonths(db, sku.sku);
    if (!npMonths) continue;
    const ph = npMonths.months.map(() => '?').join(',');
    const monthly = db.prepare(`SELECT month, sales_volume, sales_revenue, unit_price FROM profit_loss WHERE sku=? AND month IN (${ph}) AND sales_volume>0`).all(sku.sku, ...npMonths.months);
    if (monthly.length === 0) continue;
    // 销量加权均价 = 新品期内总销售额÷总销量
    const totalVol = monthly.reduce((s,m)=>s+(m.sales_volume||0),0);
    const totalRev = monthly.reduce((s,m)=>s+(m.sales_revenue||0),0);
    const avgPrice = totalVol>0 ? totalRev/totalVol : 0;
    const avgPriceUSD = avgPrice / 6.7;

    // Latest month price & status
    const latestPL = db.prepare(`SELECT month, unit_price, sales_revenue, sales_volume FROM profit_loss WHERE sku=? AND sales_volume>0 ORDER BY month DESC LIMIT 1`).get(sku.sku);
    const latestPrice = latestPL ? latestPL.unit_price / 6.7 : null;
    let npStatus = 'normal', latestStatus = 'normal';
    if (sku.redline_price && avgPriceUSD < sku.redline_price) npStatus = 'below_redline';
    else if (sku.estimated_price && avgPriceUSD > sku.estimated_price) npStatus = 'above_estimated';
    else npStatus = 'redline_to_estimated';
    if (sku.redline_price && latestPrice && latestPrice < sku.redline_price) latestStatus = 'below_redline';
    else if (sku.estimated_price && latestPrice && latestPrice > sku.estimated_price) latestStatus = 'above_estimated';
    else latestStatus = latestPrice ? 'redline_to_estimated' : 'normal';

    results.push({
      sku: sku.sku,
      product_name: sku.product_name,
      fram_model: sku.fram_model,
      estimated_price: sku.estimated_price ? Math.round(sku.estimated_price*100)/100 : null,
      redline_price: sku.redline_price ? Math.round(sku.redline_price*100)/100 : null,
      actual_price: Math.round(avgPriceUSD*100)/100,
      np_volume: Math.round(totalVol),
      price_status: npStatus,
      latest_price: latestPrice ? Math.round(latestPrice*100)/100 : null,
      latest_month: latestPL ? latestPL.month : null,
      latest_status: latestStatus
    });
  }
  // Sort by NP sales volume desc
  results.sort((a, b) => (b.np_volume || 0) - (a.np_volume || 0));
  res.json({ details: results, all_count: results.length });
});

// SKU综合详情（费率+价格+退款+KPI）
app.get('/api/dashboard/sku-detail/:sku', requireAuth, (req, res) => {
  const db = getDb();
  const { sku } = req.params;

  const pe = db.prepare('SELECT * FROM profit_estimation WHERE sku = ? LIMIT 1').get(sku);
  if (!pe) return res.status(404).json({ error: 'SKU not found' });

  const inv = db.prepare('SELECT * FROM inventory WHERE sku = ? LIMIT 1').get(sku);
  const npMonths = getNewProductMonths(db, sku);
  const EST_REF = pe.est_refund_rate || 0.0336, EST_PROMO = pe.est_promotion_rate || 0;

  let feeData = null, priceData = null, kpiData = null;
  if (npMonths) {
    const ph = npMonths.months.map(() => '?').join(',');
    const monthly = db.prepare(`SELECT * FROM profit_loss WHERE sku=? AND month IN (${ph}) AND sales_volume>0`).all(sku, ...npMonths.months);
    if (monthly.length > 0) {
      const maxS = monthly.reduce((max,m) => m.sales_volume>(max.sales_volume||0)?m:max, monthly[0]);
      // 新品期累计毛利额/累计销售额
      const npTotalProfit = monthly.reduce((s,m)=>s+(m.gross_profit||0),0);
      const npTotalRevenue = monthly.reduce((s,m)=>s+(m.sales_revenue||0),0);
      const npMargin = npTotalRevenue > 0 ? npTotalProfit / npTotalRevenue : null;
      // 最新月份毛利率
      const latestPL = db.prepare(`SELECT month, gross_margin FROM profit_loss WHERE sku=? AND sales_volume>0 ORDER BY month DESC LIMIT 1`).get(sku);
      const latestMargin = latestPL ? latestPL.gross_margin : null;

      const actUSD = (maxS.unit_price||0)/6.7;
      const estP = pe.estimated_price || 1;

      const priceRatio = actUSD / estP;
      feeData = {
        month: maxS.month, revenue: maxS.sales_revenue, act_price_usd: Math.round(actUSD*100)/100, est_price: pe.estimated_price,
        fees: {
          first_leg: { est: pe.first_leg_ratio, act: maxS.first_leg_ratio, adj: (maxS.first_leg_ratio||0)*priceRatio },
          last_leg: { est: pe.last_leg_ratio, act: maxS.last_leg_ratio, adj: (maxS.last_leg_ratio||0)*priceRatio },
          warehouse: { est: pe.warehouse_ratio, act: maxS.warehouse_ratio, adj: (maxS.warehouse_ratio||0)*priceRatio },
          promotion: { est: EST_PROMO, act: maxS.promotion_ratio, adj: (maxS.promotion_ratio||0)*priceRatio },
          refund: { est: EST_REF, act: maxS.refund_rate, adj: (maxS.refund_rate||0)*priceRatio }
        }
      };
      priceData = {
        est_price: pe.estimated_price?Math.round(pe.estimated_price*100)/100:null,
        redline: pe.redline_price?Math.round(pe.redline_price*100)/100:null,
        actual: Math.round(actUSD*100)/100,
        status: pe.redline_price&&actUSD<pe.redline_price?'below_redline':'normal'
      };
      kpiData = {
        est_dd: pe.dd_value, actual_dd: Math.round((maxS.sales_volume||0)/30*100)/100,
        dd_pct: pe.dd_value>0?Math.round((maxS.sales_volume/30/pe.dd_value)*10000)/100:0,
        max_sales: Math.round(maxS.sales_volume), max_sales_month: maxS.month,
        np_margin: npMargin, latest_margin: latestMargin
      };
    }
  }

  // Refund data (dedup by month)
  const refMonths = db.prepare(`SELECT month,SUM(sales_volume) as sales_volume,SUM(sales_revenue) as sales_revenue,AVG(refund_rate) as refund_rate,AVG(promotion_ratio) as promotion_ratio FROM profit_loss WHERE sku=? AND month>='202605' AND month<='202608' GROUP BY month ORDER BY month DESC`).all(sku);
  const totRev = refMonths.reduce((s,m)=>s+(m.sales_revenue||0),0);
  const totRef = refMonths.reduce((s,m)=>s+(m.refund_rate||0)*(m.sales_revenue||0),0);

  res.json({
    sku, product_name: pe.product_name, fram_model: pe.fram_model, batch: pe.batch,
    brand: inv?.brand, launch_date: inv?.fba_first_arrival,
    kpi: kpiData, fees: feeData, price: priceData,
    refund: { weighted_rate: totRev>0?Math.round(totRef/totRev*10000)/100:0, monthly: refMonths }
  });
});

// Debug endpoint: check a SKU's raw data
app.get('/api/debug/sku/:sku', requireAuth, (req, res) => {
  const db = getDb();
  const sku = req.params.sku.toUpperCase();
  const pe = db.prepare('SELECT * FROM profit_estimation WHERE sku=?').get(sku);
  const inv = db.prepare('SELECT * FROM inventory WHERE sku=?').get(sku);
  const pl = db.prepare('SELECT month,sales_volume,sales_revenue FROM profit_loss WHERE sku=? ORDER BY month').all(sku);
  const npMonths = inv?.fba_first_arrival ? getNewProductMonths(db, sku) : null;
  res.json({ sku, pe: !!pe, inv: inv?{arrival:inv.fba_first_arrival}:null, pl_count: pl.length, pl_months: pl.map(r=>r.month), new_product_months: npMonths?.months, sample: pl.slice(0,6) });
});

function processPriceResults(models, db, res) {
  const results = [];

  for (const model of models) {
    if (!model.fba_first_arrival) continue;
    const skuList = model.skus.split(',').map(s => s.trim()).filter(Boolean);

    // Get actual prices for each SKU — 每个SKU独立计算实际售价和状态
    const skuDetails = [];
    const estimatedPrice = model.estimated_price;
    const redlinePrice = model.redline_price;

    for (const sku of skuList) {
      const npMonths = getNewProductMonths(db, sku);
      if (!npMonths) continue;

      const placeholders = npMonths.months.map(() => '?').join(',');
      const monthlyData = db.prepare(`
        SELECT month, sales_volume, sales_revenue, unit_price
        FROM profit_loss
        WHERE sku = ? AND month IN (${placeholders}) AND sales_volume > 0
      `).all(sku, ...npMonths.months);

      if (monthlyData.length > 0) {
        const maxMonth = monthlyData.reduce((max, m) =>
          m.sales_volume > (max.sales_volume || 0) ? m : max, monthlyData[0]);
        const totalV = monthlyData.reduce((s,m)=>s+(m.sales_volume||0),0);
        const totalR = monthlyData.reduce((s,m)=>s+(m.sales_revenue||0),0);
        const actualPrice = totalV>0 ? (totalR/totalV)/6.7 : 0;

        // 每个SKU独立判断价格状态
        const lm = db.prepare(`SELECT month,unit_price FROM profit_loss WHERE sku=? AND sales_volume>0 ORDER BY month DESC LIMIT 1`).get(sku);
        const lp = lm ? Math.round((lm.unit_price/6.7)*100)/100 : null;
        const lmStr = lm ? lm.month : null;
        let skuStatus = 'normal';
        if (redlinePrice && actualPrice < redlinePrice) {
          skuStatus = lp && lp >= redlinePrice ? 'adjusted_up' : 'below_redline';
        } else if (estimatedPrice && actualPrice < estimatedPrice * 0.9) {
          skuStatus = 'below_target';
        }

        skuDetails.push({
          sku: sku,
          actual_price: Math.round(actualPrice * 100) / 100,
          price_status: skuStatus,
          max_sales_month: maxMonth.month,
          max_sales_volume: Math.round(maxMonth.sales_volume),
          latest_price: lp,
          latest_month: lmStr
        });
      } else {
        skuDetails.push({
          sku: sku,
          actual_price: null,
          price_status: 'no_data',
          max_sales_month: null,
          max_sales_volume: 0,
          latest_price: null,
          latest_month: null
        });
      }
    }

    // Parse competitor detail
    // Format after scraping: B0XXX:$price/volume/revenue(seller) [↑涨$X]
    // Format before scraping: B0XXX:price/volume/revenue(seller)
    const competitors = [];
    const compDetail = model.competitor_detail || '';
    if (compDetail) {
      const parts = compDetail.split('|').map(p => p.trim()).filter(Boolean);
      for (const part of parts) {
        // New format: B0XXX:$price/seller [原:$oldPrice/月销oldVol] | [↑涨$X]
        // Old format: B0XXX:price/volume/revenue(seller) or B0XXX:$price/volume/revenue(seller) [原:...]
        let m = part.match(/^(B0[A-Z0-9]+):\$?([\d.]+)\/([\d.]+)\/([\d.]+)(?:\(([^)]*)\))?\s*(?:\[(.+)\])?/);
        if (!m) {
          // Try new scraper format: B0XXX:$price/seller [原:...]
          m = part.match(/^(B0[A-Z0-9]+):\$?([\d.]+)\/([A-Za-z_]+)\s*(\[.+\])?/);
          if (!m) continue;
          const newFormatPrice = parseFloat(m[2]);
          const newFormatSeller = m[3];
          const newFormatNote = m[4] || '';
          const origMatch = newFormatNote.match(/\[原:\$?([\d.]+)\/月销(\d+)\]/);
          const chgMatch = newFormatNote.match(/\[[↑↓][涨跌]\$?([\d.]+)\]/);
          competitors.push({
            asin: m[1],
            historical_price: origMatch ? parseFloat(origMatch[1]) : null,
            historical_volume: origMatch ? parseInt(origMatch[2]) : null,
            historical_revenue: null,
            seller: newFormatSeller,
            current_price: newFormatPrice,
            current_volume: null,
            price_change_note: chgMatch ? (newFormatNote.includes('↑') ? '↑涨$' + chgMatch[1] : '↓跌$' + chgMatch[1]) : ''
          });
          continue;
        }

        const price = parseFloat(m[2]);
        const volume = parseFloat(m[3]);
        const revenue = parseFloat(m[4]);
        const seller = m[5] || 'Unknown';
        const note = m[6] || '';
        const isScraped = note.includes('涨') || note.includes('跌') || note.includes('[原:') || part.includes(':$');

        let histPrice = null, histVolume = null;
        let curPrice = null, curVolume = null;
        let priceNote = note;

        if (isScraped) {
          curPrice = price;
          curVolume = volume;
          // Extract historical from [原:$XX/月销XX]
          const origMatch = note.match(/\[原:\$?([\d.]+)\/月销(\d+)\]/);
          if (origMatch) {
            histPrice = parseFloat(origMatch[1]);
            histVolume = parseInt(origMatch[2]);
          }
        } else {
          histPrice = price;
          histVolume = volume;
        }

        competitors.push({
          asin: m[1],
          historical_price: histPrice,
          historical_volume: histVolume,
          historical_revenue: revenue,
          seller,
          current_price: curPrice,
          current_volume: curVolume,
          price_change_note: note
        });
      }
    }

    results.push({
      fram_model: model.fram_model,
      skus: skuList,
      product_name: model.product_name,
      batch: model.batch,
      launch_date: model.fba_first_arrival,
      estimated_price: estimatedPrice ? Math.round(estimatedPrice * 100) / 100 : null,
      redline_price: redlinePrice ? Math.round(redlinePrice * 100) / 100 : null,
      sku_details: skuDetails,    // 每个SKU的实际售价和状态
      competitors: competitors
    });
  }

  res.json({ details: results });
}

// Panel 4: High Refund Warning (按型号聚合, 支持月份筛选)
app.get('/api/dashboard/refunds', requireAuth, (req, res) => {
  const db = getDb();
  const category = getCategory(req);
  const { months } = req.query;

  let refundData = db.prepare(`
    SELECT pl.sku, pl.month,
           SUM(pl.sales_volume) as sales_volume, SUM(pl.sales_revenue) as sales_revenue,
           AVG(pl.refund_rate) as refund_rate, AVG(pl.promotion_ratio) as promotion_ratio,
           MAX(pe.fram_model) as fram_model, MAX(pe.product_name) as product_name, MAX(pe.batch) as batch
    FROM profit_loss pl
    LEFT JOIN profit_estimation pe ON pl.sku = pe.sku AND pl.category = pe.category
    WHERE pl.month >= '202605' AND pl.month <= '202608' AND pl.category = ?
    GROUP BY pl.sku, pl.month
    ORDER BY pl.sku, pl.month DESC
  `).all(category);

  // Filter by launch month if specified
  if (months) refundData = filterByLaunchMonth(refundData, months, 'sku');

  // Group by SKU first, compute weighted refund rate
  const skuRefundMap = {};
  for (const row of refundData) {
    if (!skuRefundMap[row.sku]) {
      skuRefundMap[row.sku] = {
        sku: row.sku,
        fram_model: row.fram_model || '',
        product_name: row.product_name || '',
        batch: row.batch || '',
        months: [],
        total_revenue: 0,
        total_refund_value: 0,
        total_volume: 0
      };
    }
    skuRefundMap[row.sku].months.push(row);
    skuRefundMap[row.sku].total_revenue += (row.sales_revenue || 0);
    skuRefundMap[row.sku].total_refund_value += (row.refund_rate || 0) * (row.sales_revenue || 0);
    skuRefundMap[row.sku].total_volume += (row.sales_volume || 0);
  }

  // Compute weighted refund rate per SKU
  for (const [sku, data] of Object.entries(skuRefundMap)) {
    data.weighted_refund_rate = data.total_revenue > 0
      ? data.total_refund_value / data.total_revenue : 0;
  }

  // Group by fram_model
  const modelMap = {};
  for (const [sku, data] of Object.entries(skuRefundMap)) {
    if (!data.fram_model) continue; // skip SKUs without model
    const model = data.fram_model;
    if (!modelMap[model]) {
      modelMap[model] = {
        fram_model: model,
        skus: [],
        max_refund_rate: 0,
        brands: {}
      };
    }
    modelMap[model].skus.push(data);
    modelMap[model].max_refund_rate = Math.max(modelMap[model].max_refund_rate, data.weighted_refund_rate);

    // Group by brand
    const inv = db.prepare('SELECT brand FROM inventory WHERE sku = ? LIMIT 1').get(sku);
    const brand = inv ? inv.brand : 'Unknown';
    if (!modelMap[model].brands[brand]) {
      modelMap[model].brands[brand] = [];
    }
    modelMap[model].brands[brand].push(data);
  }

  // Filter models where any SKU has >8% refund rate
  const highRefundModels = [];
  for (const [model, data] of Object.entries(modelMap)) {
    if (data.max_refund_rate > 0.08) {
      // Build brand-side-by-side data
      const brandEntries = Object.entries(data.brands);
      const brandDetails = brandEntries.map(([brand, skus]) => ({
        brand,
        skus: skus.map(s => ({
          sku: s.sku,
          product_name: s.product_name,
          weighted_refund_rate: Math.round(s.weighted_refund_rate * 10000) / 100,
          total_revenue_3m: Math.round(s.total_revenue * 100) / 100,
          total_volume_3m: Math.round(s.total_volume),
          monthly_data: s.months
        }))
      }));

      // Get inventory info for the first SKU
      const firstSku = data.skus[0];
      const inv = db.prepare('SELECT fba_first_arrival FROM inventory WHERE sku = ? LIMIT 1').get(firstSku.sku);

      highRefundModels.push({
        fram_model: model,
        brands: brandDetails,
        max_refund_rate: Math.round(data.max_refund_rate * 10000) / 100,
        launch_date: inv ? inv.fba_first_arrival : null,
        sku_count: data.skus.length
      });
    }
  }

  // Sort by max refund rate descending
  highRefundModels.sort((a, b) => b.max_refund_rate - a.max_refund_rate);

  res.json({
    summary: {
      high_refund_model_count: highRefundModels.length,
      threshold: 8
    },
    details: highRefundModels
  });
});

// ============================================================
// AI SUGGESTIONS (基于实际数据分析)
// ============================================================
app.get('/api/dashboard/suggestions/:panel', requireAuth, (req, res) => {
  const db = getDb();
  const { panel } = req.params;
  const category = getCategory(req);
  const { months } = req.query;
  const monthSet = months ? new Set(months.split(',').map(m => parseInt(m.trim()))) : null;
  const S = (arr) => arr.slice(0, 3).join('、');

  // Helper: filter SKU data by launch month
  const filterMonth = (arr) => {
    if (!monthSet) return arr;
    return arr.filter(s => {
      if (!s.fba_first_arrival) return false;
      return monthSet.has(new Date(s.fba_first_arrival).getMonth() + 1);
    });
  };

  const depts = {
    product: { label: '📦 产品部门', items: [] },
    operations: { label: '📊 运营部门', items: [] },
    engineering: { label: '🔧 工程/供应链', items: [] },
    aftersales: { label: '🛡 售后/质量', items: [] }
  };

  if (panel === 'panel1') {
    // Query actual KPI data
    let allSkus = db.prepare(`SELECT pe.sku,pe.dd_value,pe.fram_model,pe.product_name,inv.fba_first_arrival FROM profit_estimation pe LEFT JOIN inventory inv ON pe.sku=inv.sku AND pe.category=inv.category WHERE inv.fba_first_arrival IS NOT NULL AND pe.category=?`).all(category);
    allSkus = filterMonth(allSkus);
    const ddResults = []; const marginResults = [];
    for (const s of allSkus) {
      const npM = getNewProductMonths(db, s.sku); if (!npM) continue;
      const ph = npM.months.map(()=>'?').join(',');
      const mth = db.prepare(`SELECT MAX(sales_volume) as mv, month FROM profit_loss WHERE sku=? AND month IN (${ph}) AND sales_volume>0`).get(s.sku, ...npM.months);
      const mMargin = db.prepare(`SELECT MAX(gross_margin) as mm FROM profit_loss WHERE sku=? AND month IN (${ph}) AND sales_volume>0`).get(s.sku, ...npM.months);
      if (mth?.mv) { const ad=(mth.mv/30); const ddPct=s.dd_value>0?ad/s.dd_value:0; ddResults.push({sku:s.sku,model:s.fram_model,ddPct,ad,ed:s.dd_value}); }
      if (mMargin?.mm != null) marginResults.push({sku:s.sku,model:s.fram_model,margin:mMargin.mm});
    }
    const lowDD = ddResults.filter(d=>d.ddPct<0.5).sort((a,b)=>a.ddPct-b.ddPct);
    const highDD = ddResults.filter(d=>d.ddPct>=1.0).length;
    const negMargin = marginResults.filter(d=>d.margin<0);
    const totalSKUs = allSkus.length;

    depts.product.items = [
      `${totalSKUs}个上架SKU中，DD达成率≥100%的有${highDD}个(${(highDD/totalSKUs*100).toFixed(0)}%)，DD达成率<50%的有${lowDD.length}个，如${S(lowDD.map(d=>d.sku))}，建议重新评估低达成率型号的市场需求与定价策略`,
      `毛利率为负的SKU有${negMargin.length}个(${(negMargin.length/totalSKUs*100).toFixed(0)}%)，如${S(negMargin.map(d=>d.sku))}，建议排查推广费用是否过高或定价偏低`,
      `整体动销率100%，但DD预测值普遍偏高，建议优化后续新品DD预测模型，参考实际达成数据调整`
    ];
    depts.operations.items = [
      `DD达成率<50%的${lowDD.length}个SKU建议加大促销力度，如Coupon+Lightning Deal组合，目标30天内将达成率提升至60%以上`,
      `毛利率为负的SKU建议控制ACOS上限，首月推广占比不超过测算值的1.2倍，待排名稳定后再加大投入`,
      highDD > totalSKUs*0.3 ? `DD达成率≥100%的SKU占比较高，应保持当前推广力度并适当增加预算抢占市场份额` : `建议分析DD达成率高的SKU特征，复制成功模式到新品`
    ];
    depts.engineering.items = [
      `低DD达成率型号如${S(lowDD.slice(0,5).map(d=>d.model))}，建议与供应商协商降低MOQ或最小起订量，减少滞销库存风险`,
      ddResults.filter(d=>d.ddPct>1.5).length > 0 ? `部分SKU实际销量远超预测(达成率>150%)，建议检查库存水位，确保不断货` : ``,
      `对比实际头程费用与测算差异，建议评估更经济的海运拼箱方案`
    ].filter(Boolean);
    depts.aftersales.items = [
      `排查${negMargin.length}个负毛利率SKU是否因批量退货导致收入冲减，建议比对退货率数据`,
      `建议对低DD达成率且高退款率的交叉SKU优先处理，可能存在产品质量影响复购的问题`
    ];

  } else if (panel === 'panel2') {
    let feeData = db.prepare(`SELECT pe.sku,pe.est_promotion_rate,pe.est_refund_rate,pe.first_leg_ratio as est_fl,pe.last_leg_ratio as est_ll,pe.warehouse_ratio as est_wh,inv.fba_first_arrival FROM profit_estimation pe LEFT JOIN inventory inv ON pe.sku=inv.sku AND pe.category=inv.category WHERE inv.fba_first_arrival IS NOT NULL AND pe.category=?`).all(category);
    feeData = filterMonth(feeData);
    const feeResults = [];
    for (const s of feeData) {
      const npM = getNewProductMonths(db, s.sku); if (!npM) continue;
      const ph = npM.months.map(()=>'?').join(',');
      const mth = db.prepare(`SELECT * FROM profit_loss WHERE sku=? AND month IN (${ph}) AND sales_volume>0 ORDER BY sales_volume DESC LIMIT 1`).get(s.sku, ...npM.months);
      if (mth) {
        const actUSD = (mth.sales_revenue/(mth.sales_volume||1))/6.7; const estP = 1;
        feeResults.push({
          sku:s.sku, promo_est:s.est_promotion_rate, promo_act:mth.promotion_ratio, promo_diff:(mth.promotion_ratio||0)-(s.est_promotion_rate||0),
          refund_est:s.est_refund_rate, refund_act:mth.refund_rate, refund_diff:(mth.refund_rate||0)-(s.est_refund_rate||0),
          fl_diff:(mth.first_leg_ratio||0)-(s.est_fl||0), ll_diff:(mth.last_leg_ratio||0)-(s.est_ll||0)
        });
      }
    }
    const promoHigh = feeResults.filter(f=>f.promo_diff>0.1).sort((a,b)=>b.promo_diff-a.promo_diff);
    const refundHigh = feeResults.filter(f=>f.refund_diff>0.05).sort((a,b)=>b.refund_diff-a.refund_diff);
    const avgPromoDiff = feeResults.length>0?feeResults.reduce((s,f)=>s+f.promo_diff,0)/feeResults.length:0;

    depts.product.items = [
      avgPromoDiff > 0 ? `推广实际费率平均比测算高${(avgPromoDiff*100).toFixed(1)}个百分点，建议新品立项时推广费率预估上调至${((feeResults.reduce((s,f)=>s+f.promo_act,0)/(feeResults.length||1))*100).toFixed(1)}%` : '',
      refundHigh.length > 0 ? `退款率超测算的SKU有${refundHigh.length}个，如${S(refundHigh.map(f=>f.sku))}，建议分析退款原因并更新退款率测算基准` : '',
      `尾程费率普遍高于测算，建议关注亚马逊FBA费率调整并定期更新测算模型`
    ].filter(Boolean);
    depts.operations.items = [
      promoHigh.length > 0 ? `推广超标的${promoHigh.length}个SKU（如${S(promoHigh.map(f=>f.sku))}偏差>10pp），建议立即优化广告结构` : '',
      `建议按SKU维度建立推广费用预警线：实际推广占比超过测算值50%时自动预警`,
      feeResults.filter(f=>Math.abs(f.fl_diff)<0.01).length > feeResults.length*0.5 ? `头程费用偏差较小，说明物流成本控制较好` : `头程费用波动较大，建议检查物流供应商报价`
    ].filter(Boolean);
    depts.engineering.items = [
      `头程费用整体偏差${feeResults.length>0?(feeResults.reduce((s,f)=>s+Math.abs(f.fl_diff),0)/feeResults.length*100).toFixed(1):'--'}个百分点，建议评估不同物流渠道的成本效益`,
      `部分SKU尾程费用显著偏高，可能与包装尺寸被FBA重新测量有关，建议抽查`
    ].filter(Boolean);
    depts.aftersales.items = [
      refundHigh.length > 0 ? `${refundHigh.length}个SKU退款率超模板预期，建议对退款率前5的SKU进行退货分析，建立改善计划` : '',
      `退款率>8%的SKU建议在listing增加车型适配验证工具，减少误购退货`
    ].filter(Boolean);

  } else if (panel === 'panel3') {
    let priceData = db.prepare(`SELECT pe.sku,pe.fram_model,pe.estimated_price,pe.redline_price,pe.competitor_detail,inv.fba_first_arrival FROM profit_estimation pe LEFT JOIN inventory inv ON pe.sku=inv.sku AND pe.category=inv.category WHERE inv.fba_first_arrival IS NOT NULL AND pe.category=?`).all(category);
    priceData = filterMonth(priceData);
    const priceResults = [];
    for (const s of priceData) {
      const npM = getNewProductMonths(db, s.sku); if (!npM) continue;
      const ph = npM.months.map(()=>'?').join(',');
      const mth = db.prepare(`SELECT sales_revenue,sales_volume FROM profit_loss WHERE sku=? AND month IN (${ph}) AND sales_volume>0 ORDER BY sales_volume DESC LIMIT 1`).get(s.sku, ...npM.months);
      if (mth) {
        const ap = (mth.sales_revenue/(mth.sales_volume||1))/6.7;
        const status = s.redline_price && ap < s.redline_price ? 'below_redline' : s.estimated_price && ap < s.estimated_price*0.9 ? 'below_target' : 'normal';
        priceResults.push({sku:s.sku,model:s.fram_model,est:s.estimated_price,redline:s.redline_price,actual:Math.round(ap*100)/100,status});
      }
    }
    const belowRedline = priceResults.filter(p=>p.status==='below_redline');
    const belowTarget = priceResults.filter(p=>p.status==='below_target');

    depts.product.items = [
      belowRedline.length > 0 ? `${belowRedline.length}个SKU实际售价低于红线价(${(belowRedline.length/priceResults.length*100).toFixed(0)}%)，如${S(belowRedline.map(p=>p.sku))}，存在亏损风险，建议评估提价或清仓退出` : '',
      belowTarget.length > 0 ? `${belowTarget.length}个SKU售价低于测算价10%以上，市场竞争激烈，建议重新评估定价策略` : '',
      `建议每季度更新竞对价格数据，确保定价策略与市场同步`
    ].filter(Boolean);
    depts.operations.items = [
      belowTarget.length > 0 ? `对售价低于测算价的SKU，建议通过Vine计划获取早期评价提升转化率，以量补价` : '',
      priceResults.filter(p=>p.status==='normal'&&p.actual>p.est*1.1).length > 0 ? `部分SKU实际售价高于测算价10%以上，利润空间充足，可适当增加广告投入` : '',
      `对低于红线价的SKU立即暂停大额折扣活动，优先恢复价格至红线以上`
    ].filter(Boolean);
    depts.engineering.items = [
      belowRedline.length > 3 ? `${belowRedline.length}个SKU长期低于红线价，建议与供应商重新谈判采购价` : '',
      `研究竞对产品包装和材质，寻找在不影响质量前提下的降本机会`
    ].filter(Boolean);
    depts.aftersales.items = [
      `对比低价SKU与高退款率SKU的交叉情况，如两者重叠，优先处理产品质量问题`
    ].filter(Boolean);

  } else if (panel === 'panel4') {
    const refData = db.prepare(`SELECT pl.sku,pl.month,SUM(pl.sales_revenue) as sales_revenue,AVG(pl.refund_rate) as refund_rate,MAX(pe.fram_model) as fram_model,MAX(pe.product_name) as product_name FROM profit_loss pl LEFT JOIN profit_estimation pe ON pl.sku=pe.sku AND pl.category=pe.category WHERE pl.month>='202605' AND pl.month<='202608' AND pl.category=? GROUP BY pl.sku,pl.month`).all(category);
    const skuRef = {};
    refData.forEach(r => {
      if (!skuRef[r.sku]) skuRef[r.sku] = {sku:r.sku,model:r.fram_model,name:r.product_name,total:0,refund:0};
      skuRef[r.sku].total += (r.sales_revenue||0); skuRef[r.sku].refund += (r.refund_rate||0)*(r.sales_revenue||0);
    });
    const highRef = Object.values(skuRef).filter(s=>s.total>0&&s.refund/s.total>0.08).sort((a,b)=>b.refund/b.total-a.refund/a.total);
    const vHigh = highRef.filter(s=>s.refund/s.total>0.2);
    const modelGroups = {}; highRef.forEach(s=>{const m=s.model||s.sku;if(!modelGroups[m])modelGroups[m]=[];modelGroups[m].push(s);});

    depts.product.items = [
      highRef.length > 0 ? `${highRef.length}个型号退款率超8%，${vHigh.length}个超20%（如${S(vHigh.map(s=>s.sku))}），建议产品部门逐型号排查` : '',
      `同一型号多SKU退款率差异>10pp的，建议对比品牌定位和客户群差异，针对性调整`
    ].filter(Boolean);
    depts.operations.items = [
      vHigh.length > 0 ? `退款率>20%的${vHigh.length}个SKU建议立即暂停广告投放，避免差评扩散` : '',
      highRef.length > 0 ? `对于退款率8%-20%的SKU，建议在listing增加详细安装说明和车型适配表` : '',
      `分析退款率与推广占比的相关性，控制非精准流量的广告支出`
    ].filter(Boolean);
    depts.engineering.items = [
      vHigh.length > 0 ? `退款率前5型号（${S(vHigh.slice(0,5).map(s=>s.sku))}）建议工程部立即进行产品实物抽检` : '',
      Object.keys(modelGroups).filter(m=>modelGroups[m].length>1&&Math.abs((modelGroups[m][0].refund/modelGroups[m][0].total)-(modelGroups[m][1]?.refund/modelGroups[m][1]?.total||0))>0.1).length > 0 ? `同型号不同品牌退款率差异显著的，建议对比供应商/生产工艺差异` : ''
    ].filter(Boolean);
    depts.aftersales.items = [
      vHigh.length > 0 ? `建议对退款率>20%的SKU建立售后专项跟踪，每笔退款记录原因并汇总` : '',
      highRef.length > 0 ? `对高频退款原因（不兼容、质量差），建议更新A+页面，增加车型验证工具` : ''
    ].filter(Boolean);
  }

  res.json({ departments: depts });
});

// ============================================================
// TEMPLATE DOWNLOAD — 直接使用用户的模版文件
// ============================================================
app.get('/api/admin/template', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const builtin = path.join(__dirname, 'public', 'template.xlsx');

  if (fs.existsSync(builtin)) {
    // 读取模版，每个Sheet只保留首行（表头）
    const XLSX = require('xlsx');
    const wb = XLSX.readFile(builtin);
    const newWb = XLSX.utils.book_new();
    wb.SheetNames.forEach(sn => {
      const data = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' });
      const headerOnly = data.length > 0 ? [data[0]] : [[]];
      const ws = XLSX.utils.aoa_to_sheet(headerOnly);
      ws['!cols'] = (data[0] || []).map(() => ({ wch: 16 }));
      XLSX.utils.book_append_sheet(newWb, ws, sn);
    });
    const buf = XLSX.write(newWb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=import_template.xlsx');
    return res.send(buf);
  }
  res.status(404).json({ error: '模版文件未找到' });
});

// ============================================================
// CATEGORY ADMIN MANAGEMENT
// ============================================================
app.get('/api/admin/category-admins', requireAdmin, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT ca.id, ca.category, ca.user_id, u.name as user_name, ca.created_at
    FROM category_admins ca JOIN users u ON ca.user_id = u.id
    ORDER BY ca.category, u.name
  `).all();
  res.json({ admins: rows });
});

app.post('/api/admin/category-admins', requireAdmin, (req, res) => {
  const db = getDb();
  const { user_name, category } = req.body;
  if (!user_name || !category) return res.status(400).json({ error: '缺少参数' });
  const user = db.prepare('SELECT id FROM users WHERE name = ?').get(user_name);
  if (!user) return res.status(400).json({ error: '用户不存在，请先让该用户登录一次' });
  try {
    db.prepare('INSERT INTO category_admins (user_id, category) VALUES (?, ?)').run(user.id, category);
    res.json({ success: true });
  } catch(e) {
    res.status(400).json({ error: '该用户已是此品类管理员' });
  }
});

app.delete('/api/admin/category-admins/:id', requireAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM category_admins WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ============================================================
// REPORT GENERATION (支持月份筛选，深度分析)
// ============================================================
app.get('/api/report', requireAuth, async (req, res) => {
  const db = getDb();
  const category = getCategory(req);
  const { months } = req.query;
  const now = new Date().toLocaleString('zh-CN');
  const monthLabel = months ? (()=>{const a=months.split(',').map(m=>m+'月');return a.join('、');})() : '全部上架月份';
  const pct = v => (v*100).toFixed(1)+'%';
  const pct2 = v => (v*100).toFixed(2)+'%';

  // ============ FILTER SKUs by launch month ============
  let allPE = db.prepare(`SELECT pe.*, inv.fba_first_arrival, inv.brand FROM profit_estimation pe LEFT JOIN inventory inv ON pe.sku=inv.sku AND pe.category=inv.category WHERE pe.category=?`).all(category);
  if (months) {
    const monthSet = new Set(months.split(',').map(m=>parseInt(m.trim())));
    allPE = allPE.filter(s=>{if(!s.fba_first_arrival) return false;return monthSet.has(new Date(s.fba_first_arrival).getMonth()+1);});
  }
  const validPE = allPE.filter(s=>s.fba_first_arrival);
  if (validPE.length === 0) return res.send('<html><body><h2>无匹配数据</h2></body></html>');

  // ============ BUILD SKU PERFORMANCE DATA ============
  const skuData = [];
  for (const s of validPE) {
    const npM = getNewProductMonths(db, s.sku);
    if (!npM) { skuData.push({sku:s.sku,name:s.product_name,model:s.fram_model,brand:s.brand,estDD:s.dd_value,estPrice:s.estimated_price,redline:s.redline_price,hasData:false,latest:null}); continue; }
    const ph = npM.months.map(()=>'?').join(',');
    const mths = db.prepare(`SELECT * FROM profit_loss WHERE sku=? AND month IN (${ph}) AND sales_volume>0`).all(s.sku, ...npM.months);
    if (mths.length===0) { skuData.push({sku:s.sku,name:s.product_name,model:s.fram_model,brand:s.brand,estDD:s.dd_value,estPrice:s.estimated_price,redline:s.redline_price,hasData:false,latest:null}); continue; }
    const maxS = mths.reduce((a,b)=>b.sales_volume>a.sales_volume?b:a,mths[0]);
    // 新品期累计毛利率
    const npTotalProfit = mths.reduce((sum,m)=>sum+(m.gross_profit||0),0);
    const npTotalRevenue = mths.reduce((sum,m)=>sum+(m.sales_revenue||0),0);
    const npMargin = npTotalRevenue>0 ? npTotalProfit/npTotalRevenue : 0;
    const actPriceUSD = (maxS.sales_revenue/(maxS.sales_volume||1))/6.7;
    skuData.push({
      sku:s.sku, name:s.product_name, model:s.fram_model, brand:s.brand,
      estDD:s.dd_value||0, actDD:Math.round(maxS.sales_volume/30*100)/100,
      ddPct:s.dd_value>0?Math.round(maxS.sales_volume/30/s.dd_value*10000)/100:0,
      ddMonth:maxS.month, ddSales:Math.round(maxS.sales_volume),
      margin:npMargin, marginPct:Math.round(npMargin*10000)/100,
      profit:Math.round(npTotalProfit*100)/100, revenue:npTotalRevenue,
      actPrice:Math.round(actPriceUSD*100)/100, estPrice:s.estimated_price, redline:s.redline_price,
      promoAct:maxS.promotion_ratio, refundAct:maxS.refund_rate,
      flAct:maxS.first_leg_ratio, llAct:maxS.last_leg_ratio, whAct:maxS.warehouse_ratio,
      flEst:s.first_leg_ratio, llEst:s.last_leg_ratio, whEst:s.warehouse_ratio,
      promoEst:s.est_promotion_rate, refundEst:s.est_refund_rate,
      hasData:true,
      latest: null
    });
    if ((skuData[skuData.length-1]).hasData) {
      const latestPL = db.prepare(`SELECT month,sales_volume,sales_revenue,unit_price,gross_margin,gross_profit,promotion_ratio,refund_rate FROM profit_loss WHERE sku=? AND sales_volume>0 ORDER BY month DESC LIMIT 1`).get(s.sku);
      if (latestPL) skuData[skuData.length-1].latest = {
        month: latestPL.month,
        price: Math.round((latestPL.sales_revenue/(latestPL.sales_volume||1))/6.7*100)/100,
        margin: latestPL.gross_margin,
        profit: latestPL.gross_profit,
        promo: latestPL.promotion_ratio,
        refund: latestPL.refund_rate,
        volume: latestPL.sales_volume
      };
    }
  }

  // ============ AGGREGATE STATS ============
  const withData = skuData.filter(s=>s.hasData);
  const noData = skuData.filter(s=>!s.hasData);
  const activationRate = skuData.length>0?Math.round(withData.length/skuData.length*10000)/100:0;
  let totalEstDD=0,totalActDD=0,totalProfit=0,totalRevenue=0;
  withData.forEach(s=>{totalEstDD+=s.estDD;totalActDD+=s.actDD;totalProfit+=s.profit;totalRevenue+=s.revenue;});
  const ddRate = totalEstDD>0?Math.round(totalActDD/totalEstDD*10000)/100:0;
  const grossMargin = totalRevenue>0?Math.round(totalProfit/totalRevenue*10000)/100:0;

  // ============ ANALYSIS: LOW DD ============
  const lowDD = withData.filter(s=>s.ddPct<50).sort((a,b)=>a.ddPct-b.ddPct);
  const modelGroup={};
  withData.forEach(s=>{if(s.model&&s.model!==''){if(!modelGroup[s.model])modelGroup[s.model]=[];modelGroup[s.model].push(s);}});
  // Check if low DD models have multiple SKUs (traffic split)
  const lowDDModels = [...new Set(lowDD.map(s=>s.model).filter(Boolean))];
  const lowDDWithSplit = lowDDModels.filter(m=>modelGroup[m]&&modelGroup[m].length>=2);
  const lowDDWithoutSplit = lowDDModels.filter(m=>!modelGroup[m]||modelGroup[m].length<2);

  // ============ ANALYSIS: LOW MARGIN ============
  const lowMargin = withData.filter(s=>s.margin<0.05).sort((a,b)=>a.margin-b.margin);
  const negMargin = lowMargin.filter(s=>s.margin<0);
  // Classify causes
  const highPromoMargin = lowMargin.filter(s=>s.promoAct>0.3);
  const highRefundMargin = lowMargin.filter(s=>s.refundAct>0.08);
  const lowPriceMargin = lowMargin.filter(s=>s.estPrice&&s.actPrice<s.estPrice*0.85);

  // ============ ANALYSIS: PRICE ============
  const belowRedline = withData.filter(s=>s.redline&&s.actPrice<s.redline);
  const belowTarget = withData.filter(s=>s.estPrice&&s.actPrice<s.estPrice*0.9&&(!s.redline||s.actPrice>=s.redline));
  const adjustedUp = belowRedline.filter(s=>s.latest&&s.latest.price>=s.redline);
  const stillBelow = belowRedline.filter(s=>!s.latest||s.latest.price<s.redline);
  // Check margin improvement after price adjustment
  const marginImproved = adjustedUp.filter(s=>s.latest&&(s.latest.margin||-99)>(s.margin||-99));
  // Price drop since NP period (latest < actual)
  const priceDropped = withData.filter(s=>s.latest&&s.latest.price<s.actPrice*0.95);

  // ============ ANALYSIS: FEES ============
  let flE=0,flA=0,llE=0,llA=0,whE=0,whA=0,prE=0,prA=0,rfE=0,rfA=0,tr=0;
  withData.forEach(s=>{const r=s.revenue||0;tr+=r;flE+=(s.flEst||0)*r;flA+=(s.flAct||0)*r;llE+=(s.llEst||0)*r;llA+=(s.llAct||0)*r;whE+=(s.whEst||0)*r;whA+=(s.whAct||0)*r;prE+=(s.promoEst||0)*r;prA+=(s.promoAct||0)*r;rfE+=(s.refundEst||0)*r;rfA+=(s.refundAct||0)*r;});
  const feeItems = [
    {name:'头程',est:flE/tr,act:flA/tr},{name:'尾程',est:llE/tr,act:llA/tr},{name:'仓储',est:whE/tr,act:whA/tr},{name:'推广',est:prE/tr,act:prA/tr},{name:'退款',est:rfE/tr,act:rfA/tr}
  ];
  const maxDeviation = feeItems.reduce((a,b)=>Math.abs(b.act-b.est)>Math.abs(a.act-a.est)?b:a,feeItems[0]);

  // ============ ANALYSIS: REFUND (3-month weighted) ============
  for (const s of withData) {
    const refData = db.prepare(`SELECT SUM(sales_revenue) as rev, SUM(refund_rate*sales_revenue) as rf FROM profit_loss WHERE sku=? AND month>='202605' AND month<='202608'`).get(s.sku);
    s.refund3m = (refData&&refData.rev>0) ? refData.rf/refData.rev : 0;
  }
  const highRefundSKUs = withData.filter(s=>s.refund3m>0.08).sort((a,b)=>b.refund3m-a.refund3m);

  // ============ BUILD HTML ============
  const badge=(v,th)=>{if(v==null)return'';const n=Number(v);return n>=th?' class="red"':n>=th*0.6?' class="warn"':' class="green"';};

  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>新品复盘报告 - ${category} (${monthLabel})</title>
<style>body{font-family:'PingFang SC','Microsoft YaHei',sans-serif;max-width:1000px;margin:0 auto;padding:30px;color:#333;line-height:1.8}
h1{text-align:center;font-size:24px;border-bottom:2px solid #1677ff;padding-bottom:12px}
.sub{text-align:center;color:#999;font-size:13px;margin-bottom:24px}
h2{font-size:18px;color:#1677ff;border-left:4px solid #1677ff;padding-left:12px;margin:30px 0 14px}
h3{font-size:15px;color:#555;margin:16px 0 8px}
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:12px 0}
.kpi-card{background:#f0f5ff;padding:16px;border-radius:8px;text-align:center}
.kpi-val{font-size:28px;font-weight:700;color:#1677ff}.kpi-lbl{font-size:13px;color:#666;margin-top:4px}
table{width:100%;border-collapse:collapse;margin:10px 0;font-size:13px}
th{background:#fafafa;padding:8px 10px;text-align:left;border:1px solid #e8e8e8;font-weight:600}
td{padding:6px 10px;border:1px solid #e8e8e8}
.red{color:#ff4d4f;font-weight:600}.green{color:#52c41a}.warn{color:#fa8c16}
.analysis-box{background:#f6f8fa;border-radius:8px;padding:14px 18px;margin:10px 0;border-left:3px solid #1677ff}
.analysis-box h4{font-size:14px;margin:0 0 6px;color:#1677ff}
.analysis-box p,.analysis-box li{font-size:13px;margin:3px 0}
.risk-high{background:#fff2f0;border-left-color:#ff4d4f}
.risk-mid{background:#fffbe6;border-left-color:#fa8c16}
.footer{text-align:center;color:#ccc;font-size:12px;margin-top:40px;border-top:1px solid #f0f0f0;padding-top:14px}
@media print{body{padding:10px}}</style></head><body>
<h1>📊 ${category} 新品复盘报告</h1>
<p class="sub">筛选范围: ${monthLabel} | 生成时间: ${now}</p>

<h2>一、核心指标概览</h2>
<div class="kpi-grid">
<div class="kpi-card"><div class="kpi-val">${skuData.length}</div><div class="kpi-lbl">上架SKU (${noData.length}个暂无销售数据)</div></div>
<div class="kpi-card"><div class="kpi-val">${activationRate}%</div><div class="kpi-lbl">动销率</div></div>
<div class="kpi-card"><div class="kpi-val">${ddRate}%</div><div class="kpi-lbl">整体DD达成率</div></div>
<div class="kpi-card"><div class="kpi-val">${grossMargin}%</div><div class="kpi-lbl">整体毛利率</div></div>
</div>

<h2>二、DD达成率深度分析</h2>
<div class="analysis-box">
<h4>📊 整体情况</h4>
<p>整体DD达成率 <b>${ddRate}%</b>，${withData.length}个有销售的SKU中，达成率低于50%的有 <b class="red">${lowDD.length}个</b> (${(lowDD.length/withData.length*100).toFixed(1)}%)，达成率超过100%的有 <b class="green">${withData.filter(s=>s.ddPct>=100).length}个</b>。</p>
</div>
${lowDD.length>0?`
<div class="analysis-box risk-high">
<h4>⚠ 低DD达成率原因诊断</h4>
<ul>
<li><b>型号双链接分流：</b>${lowDDWithSplit.length}个低达成率型号同时上架PT+KAX两条链接，可能导致流量分散。例如：${lowDDWithSplit.slice(0,5).map(m=>m+'('+modelGroup[m].map(s=>s.sku+'达成率'+s.ddPct+'%').join('、')+')').join('，')}${lowDDWithSplit.length>5?' 等':''}</li>
<li><b>单链接表现不佳：</b>${lowDDWithoutSplit.length}个低达成率型号仅上架单一SKU，需分析是否为市场需求不足或竞对挤压导致</li>
<li><b>预测DD值偏高：</b>低达成率SKU的预测DD均值 ${(lowDD.reduce((s,d)=>s+d.estDD,0)/lowDD.length).toFixed(2)}，实际DD均值 ${(lowDD.reduce((s,d)=>s+d.actDD,0)/lowDD.length).toFixed(2)}，建议后续立项时下调DD预测</li>
</ul>
<p><b>建议：</b>双链接型号可评估是否合并为单链接运营以集中流量；单链接低达成率型号需排查listing质量、定价竞争力、广告投放力度</p>
</div>`:''}
${lowDD.length>0?`<h3>DD达成率最低10个SKU</h3><table><tr><th>SKU</th><th>型号</th><th>品牌</th><th>预测DD</th><th>实际DD</th><th>达成率</th><th>最高月销</th></tr>${lowDD.slice(0,10).map(s=>`<tr><td>${s.sku}</td><td>${s.model||''}</td><td>${s.brand||''}</td><td>${s.estDD.toFixed(2)}</td><td>${s.actDD.toFixed(2)}</td><td${badge(s.ddPct,50)}>${s.ddPct}%</td><td>${s.ddSales}</td></tr>`).join('')}</table>`:''}

<h2>三、毛利率深度分析</h2>
<div class="analysis-box">
<h4>💰 整体情况</h4>
<p>整体毛利率 <b>${grossMargin}%</b>，${lowMargin.length}个SKU毛利率低于5%，其中 <b class="red">${negMargin.length}个</b> 为负毛利。</p>
</div>
${lowMargin.length>0?`
<div class="analysis-box risk-high">
<h4>⚠ 低毛利率原因诊断</h4>
<ul>
<li><b>推广费用过高：</b>${highPromoMargin.length}个低毛利SKU推广占比超过30%（如${highPromoMargin.slice(0,3).map(s=>s.sku+'推广占比'+pct(s.promoAct)).join('、')}），推广成本侵蚀利润</li>
<li><b>退货率偏高：</b>${highRefundMargin.length}个低毛利SKU退款率超过8%（如${highRefundMargin.slice(0,3).map(s=>s.sku+'退款率'+pct(s.refundAct)).join('、')}），退款损失直接影响毛利率</li>
<li><b>售价低于预期：</b>${lowPriceMargin.length}个低毛利SKU实际售价比测算价低15%以上，收入端承压</li>
</ul>
<p><b>建议：</b>高推广SKU评估ACOS是否在可接受范围；高退款SKU优先排查产品质量和listing准确性；低售价SKU评估是否可提价或通过降本改善</p>
</div>`:''}
${negMargin.length>0?`<h3>负毛利率SKU</h3><table><tr><th>SKU</th><th>型号</th><th>毛利率</th><th>推广占比</th><th>退款率</th><th>实际售价</th><th>测算价</th></tr>${negMargin.slice(0,10).map(s=>`<tr><td>${s.sku}</td><td>${s.model||''}</td><td class="red">${pct(s.margin)}</td><td>${pct(s.promoAct)}</td><td>${pct(s.refundAct)}</td><td>$${s.actPrice.toFixed(2)}</td><td>$${(s.estPrice||0).toFixed(2)}</td></tr>`).join('')}</table>`:''}

<h2>四、费率比对分析</h2>
<div class="analysis-box">
<h4>📉 费率偏差总览</h4>
<table><tr><th>费用项</th><th>测算占比</th><th>实际占比</th><th>偏差</th><th>状态</th></tr>
${feeItems.map(f=>`<tr><td>${f.name}</td><td>${pct2(f.est)}</td><td>${pct2(f.act)}</td><td class="${Math.abs(f.act-f.est)>0.02?'red':'green'}">${((f.act-f.est)*100).toFixed(2)}pp</td><td>${Math.abs(f.act-f.est)>0.03?'<span class="red">⚠ 偏差较大</span>':Math.abs(f.act-f.est)>0.01?'<span class="warn">⚡ 略有偏差</span>':'<span class="green">✓ 基本吻合</span>'}</td></tr>`).join('')}
</table>
<p>费率偏差最大的是<b>${maxDeviation.name}</b>（偏差${Math.abs((maxDeviation.act-maxDeviation.est)*100).toFixed(2)}个百分点），建议重点关注。</p>
</div>

<h2>五、价格监测与调价分析</h2>
<div class="analysis-box${belowRedline.length>0?' risk-high':''}">
<h4>🏷 新品期价格风险</h4>
<p>新品期（加权均价）低于红线价的SKU: <b class="red">${belowRedline.length}个</b>（占有销售SKU的${(belowRedline.length/withData.length*100).toFixed(1)}%）</p>
<p>低于测算价90%（但高于红线）的SKU: <b class="warn">${belowTarget.length}个</b></p>
${belowRedline.length>0?'<p>低于红线价SKU: '+belowRedline.slice(0,8).map(function(s){return s.sku+'(售价$'+s.actPrice.toFixed(2)+'/红线$'+s.redline.toFixed(2)+')'}).join('、')+(belowRedline.length>8?' 等'+belowRedline.length+'个':'')+'</p>':''}
</div>

<div class="analysis-box${adjustedUp.length>0?'':' risk-mid'}">
<h4>📈 调价动作追踪</h4>
<p>新品期低于红线价的${belowRedline.length}个SKU中，<b class="green">${adjustedUp.length}个</b>已通过调价回升至红线以上（占${belowRedline.length>0?(adjustedUp.length/belowRedline.length*100).toFixed(0):0}%），<b class="red">${stillBelow.length}个</b>仍低于红线。</p>
${adjustedUp.length>0?`<table><tr><th>SKU</th><th>新品期均价</th><th>最新月售价</th><th>红线价</th><th>新品期毛利率</th><th>最新月毛利率</th><th>毛利率变化</th></tr>${adjustedUp.slice(0,15).map(s=>`<tr><td>${s.sku}</td><td>$${s.actPrice.toFixed(2)}</td><td class="green">$${s.latest.price.toFixed(2)}(${s.latest.month})</td><td>$${s.redline.toFixed(2)}</td><td>${pct(s.margin)}</td><td>${pct(s.latest.margin)}</td><td class="${(s.latest.margin||0)>(s.margin||0)?'green':'red'}">${(((s.latest.margin||0)-(s.margin||0))*100).toFixed(1)}pp</td></tr>`).join('')}</table>`:''}
${marginImproved.length>0?`<p>其中 <b class="green">${marginImproved.length}个</b> SKU调价后毛利率同步提升，说明提价策略有效改善了盈利水平。</p>`:''}
${stillBelow.length>0?`<p><b class="red">仍低于红线价的${stillBelow.length}个SKU：</b>${stillBelow.slice(0,8).map(s=>s.sku+'(售价$'+s.actPrice.toFixed(2)+'/红线$'+s.redline.toFixed(2)+')').join('、')}，建议优先处理。</p>`:''}
</div>

${priceDropped.length>0?`
<div class="analysis-box risk-mid">
<h4>⚠ 价格下行预警</h4>
<p><b class="warn">${priceDropped.length}个</b> SKU最新月售价比新品期下降超过5%：${priceDropped.slice(0,5).map(s=>`${s.sku}($${s.actPrice.toFixed(2)}→$${s.latest.price.toFixed(2)})`).join('、')}${priceDropped.length>5?'等':''}。需关注竞对压价或市场需求变化。</p>
</div>`:''}

<h2>六、退款风险分析</h2>
<div class="analysis-box${highRefundSKUs.length>0?' risk-high':''}">
<h4>🛡 高退款SKU (近3月退款率>8%)</h4>
<p>共 <b class="red">${highRefundSKUs.length}个</b> SKU退款率超过8%阈值</p>
${highRefundSKUs.length>0?`<table><tr><th>SKU</th><th>型号</th><th>近3月加权退款率</th></tr>${highRefundSKUs.slice(0,10).map(s=>`<tr><td>${s.sku}</td><td>${s.model||''}</td><td class="red">${pct(s.refund3m)}</td></tr>`).join('')}</table>`:''}
<p><b>建议：</b>高退款SKU需排查产品质量、listing准确性、包装完整性。</p>
</div>

<h2>七、综合结论与行动建议</h2>
<div class="analysis-box">
<h4>📋 关键发现</h4>
<ol>
<li><b>DD达成率：</b>${ddRate>=80?'表现良好，整体达成率'+ddRate+'%':'整体达成率'+ddRate+'%，偏低。'+lowDDWithSplit.length+'个型号因双链接分流导致单链达成率不足，建议合并运营或差异化定价'}</li>
<li><b>毛利率：</b>${grossMargin>=20?'整体毛利率'+grossMargin+'%，盈利状况健康':'整体毛利率'+grossMargin+'%，偏低。'+negMargin.length+'个SKU负毛利，主要原因为'+(highPromoMargin.length>highRefundMargin.length?'推广费用过高':'售价偏低/退款率高')}</li>
<li><b>费率控制：</b>${Math.abs((feeItems[3].act-feeItems[3].est))>0.05?'推广费偏差最大（实际比测算高'+Math.abs((feeItems[3].act-feeItems[3].est)*100).toFixed(1)+'pp），需优化广告投放策略':'各项费率偏差在可控范围内，费用管理较好'}</li>
<li><b>价格与调价：</b>新品期${belowRedline.length}个SKU低于红线价，其中${adjustedUp.length}个已调价回升（${marginImproved.length}个毛利率同步改善），${stillBelow.length}个仍待处理。${priceDropped.length>0?priceDropped.length+'个SKU最新月降价超5%，需关注竞对动态。':''}</li>
<li><b>退款风险：</b>${highRefundSKUs.length>0?highRefundSKUs.length+'个SKU退款率超标，需重点关注产品质量和listing准确性':'退款率整体可控'}</li>
</ol>
</div>
<div class="analysis-box">
<h4>🎯 优先级行动项</h4>
<ol>
${belowRedline.length>0?`<li><b class="red">【紧急】</b>${belowRedline.length}个低于红线价SKU需立即评估提价或降本方案</li>`:''}
${negMargin.length>0?`<li><b class="red">【紧急】</b>${negMargin.length}个负毛利SKU需排查原因并制定改善计划</li>`:''}
${highRefundSKUs.length>0?`<li><b class="warn">【重要】</b>${highRefundSKUs.length}个高退款SKU需进行退款原因分析</li>`:''}
${lowDD.length>0?`<li><b class="warn">【重要】</b>${lowDD.length}个低DD达成率SKU，建议按原因分类（分流/需求/竞争）制定对策</li>`:''}
<li><b>【持续】</b>每季度更新竞对价格数据，确保定价策略与市场同步</li>
<li><b>【持续】</b>建立推广费用预警机制，单SKU推广占比超过测算值50%时自动预警</li>
</ol>
</div>

<div class="footer">本报告由新品监控看板自动生成 | 品类: ${category} | 筛选: ${monthLabel} | ${now}</div>
</body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ============================================================
// ADMIN ROUTES
// ============================================================

// Upload Excel file
// Path-based upload (reads file from local disk)
app.post('/api/admin/upload-path', requireAdmin, (req, res) => {
  const { filePath, file_type } = req.body;
  if (!filePath || !file_type) return res.status(400).json({ error: '缺少参数' });
  if (!['profit_estimation', 'profit_loss', 'inventory'].includes(file_type)) return res.status(400).json({ error: '无效文件类型' });

  const fs = require('fs');
  if (!fs.existsSync(filePath)) return res.status(400).json({ error: '文件路径不存在: ' + filePath });

  const XLSX = require('xlsx');
  const db = getDb();
  const category = req.body.category || req.session.currentCategory || '滤清组套';

  try {
    const wb = XLSX.readFile(filePath);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const filename = filePath.split(/[/\\]/).pop();
    const count = importExcelData(db, data, file_type, category);

    db.prepare(`INSERT INTO upload_log (filename, file_type, category, rows_imported, uploaded_by) VALUES (?, ?, ?, ?, ?)`)
      .run(filename, file_type, category, count, req.session.user.name);

    res.json({ success: true, rows_imported: count });
  } catch (e) {
    res.status(500).json({ error: '文件解析失败: ' + e.message });
  }
});

// Reusable Excel import function (supports all 3 types including template format)
function importExcelData(db, data, file_type, category) {
  let count = 0;
  // Template format: check if first row is a header (contains known column names)
  // Legacy format: skip metadata rows
  const h0 = data.length > 0 && Array.isArray(data[0]) ? String(data[0][0] || '') : '';
  const isTemplate = h0.includes('商品编码') || h0.includes('业务分类') || h0.includes('序号');
  const startRow = isTemplate ? 1 : (file_type === 'profit_loss' ? 9 : file_type === 'inventory' ? 6 : 3);

  for (let i = startRow; i < data.length; i++) {
    const row = data[i];
    if (!row || !Array.isArray(row)) continue;

    if (file_type === 'profit_estimation') {
      // 用户模版格式 (型号后新增4列: 取消下单原因/立项时间/交期/预估到货周期，后续列号+4):
      // col0=SKU, col1=商品名称, col2=型号
      // col3=取消下单原因, col4=立项时间, col5=交期, col6=预估到货周期
      // col7=DD值, col8=不含税采购价, col9=预估头程, col10=预估FBA尾程
      // col22=AMZ竞对详情
      // col27=FBA-测算价, col29=FBA-红线价
      // col30=材料占比, col31=税费占比, col32=头程占比, col33=尾程占比
      // col34=FBA-推广占比, col35=FBA-退款占比, col39=FBA-仓储占比
      const sku = String(row[0] || '').trim().toUpperCase();
      if (!sku) continue;
      const estPromo = parseFloat(row[34]); // 模版中的推广占比
      const estRefund = parseFloat(row[35]); // 模版中的退款占比
      db.prepare(`INSERT OR REPLACE INTO profit_estimation (category, product_code, sku, product_name, fram_model, batch, estimated_price, redline_price, dd_value, material_ratio, tax_ratio, first_leg_ratio, last_leg_ratio, warehouse_ratio, purchase_price, purchase_price_ex_tax, est_first_leg_fee, est_last_leg_fee, est_promotion_rate, est_refund_rate, cancel_reason, project_date, delivery_date, est_arrival_cycle, competitor_detail) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(category, sku, sku, row[1]||'', row[2]||'', '', parseFloat(row[27])||null, parseFloat(row[29])||null, parseFloat(row[7])||0, parseFloat(row[30])||null, parseFloat(row[31])||null, parseFloat(row[32])||null, parseFloat(row[33])||null, parseFloat(row[39])||null, null, parseFloat(row[8])||null, parseFloat(row[9])||null, parseFloat(row[10])||null, isNaN(estPromo)?0:estPromo, isNaN(estRefund)?0.0336:estRefund, String(row[3]||'')||'', String(row[4]||'')||'', String(row[5]||'')||'', String(row[6]||'')||'', String(row[22]||'').replace(/\n/g,' | '));
      count++;
    } else if (file_type === 'profit_loss') {
      // 用户模版: col2=SKU, col5=月份, col6=销量, col7=销售额, col8=毛利润, col9=毛利率
      // col12=材料占比, col13=头程占比, col14=尾程占比, col15=退款率含vc, col16=仓储费占比, col17=推广占比
      const sku = String(row[2] || '').trim().toUpperCase();
      if (!sku || sku === '合计') continue;
      const month = String(row[5] || '').trim();
      if (month === '合计' || !month) continue;
      const salesVol = parseFloat(row[6]) || 0; const salesRev = parseFloat(row[7]) || 0;
      db.prepare(`INSERT INTO profit_loss (category, sku, month, sales_volume, sales_revenue, gross_profit, gross_margin, material_ratio, first_leg_ratio, last_leg_ratio, refund_rate, warehouse_ratio, promotion_ratio, unit_price) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(category, sku, month, salesVol, salesRev, parseFloat(row[8])||0, parseFloat(row[9])||0, parseFloat(row[12])||0, parseFloat(row[13])||0, parseFloat(row[14])||0, parseFloat(row[15])||0, parseFloat(row[16])||0, parseFloat(row[17])||0, salesVol>0?salesRev/salesVol:0);
      count++;
    } else if (file_type === 'inventory') {
      // 用户模版: col0=SKU, col5=FBA可用, col6=FBA在途, col10=总库存
      // col15=7天, col16=14天, col17=30天, col35=品牌, col38=FBA首次到货
      const sku = String(row[0] || '').trim().toUpperCase();
      if (!sku || sku === '合计') continue;
      const serialToDate = (s) => { if(!s||s<=0||isNaN(s)) return String(s||''); const d=new Date((new Date(1899,11,30)).getTime()+s*86400000); return d.toISOString().slice(0,10); };
      db.prepare(`INSERT INTO inventory (category, sku, brand, fba_first_arrival, fba_available_stock, fba_in_transit, total_stock, sales_7d, sales_14d, sales_30d) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(category, sku, String(row[35]||''), serialToDate(parseFloat(row[38])), parseInt(row[5])||0, parseInt(row[6])||0, parseInt(row[10])||0, parseFloat(row[15])||0, parseFloat(row[16])||0, parseFloat(row[17])||0);
      count++;
    }
  }
  return count;
}

app.post('/api/admin/upload', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择文件' });

  const XLSX = require('xlsx');
  const db = getDb();
  const category = req.body.category || req.session.currentCategory || '滤清组套';

  try {
    const wb = XLSX.readFile(req.file.path);
    const sheetNames = wb.SheetNames;
    let totalCount = 0;
    const logs = [];

    // Detect template format: check if any sheet name contains these keywords
    const hasSheet = (kw) => sheetNames.some(s => s.includes(kw));
    const isTemplate = hasSheet('利润测算') || hasSheet('损益') || hasSheet('进销存');

    if (isTemplate) {
      // Preserve scraped competitor data before clearing
      const scrapedData = db.prepare("SELECT sku, competitor_detail FROM profit_estimation WHERE competitor_detail LIKE '%[$%' OR competitor_detail LIKE '%[↑%' OR competitor_detail LIKE '%[↓%' OR competitor_detail LIKE '%[原:%'").all();
      // Clear existing data then import fresh
      db.exec('DELETE FROM profit_estimation');
      db.exec('DELETE FROM profit_loss');
      db.exec('DELETE FROM inventory');
      // Process template sheets
      const processSheet = (sheetName, type) => {
        if (!sheetNames.includes(sheetName)) return 0;
        const data = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
        if (data.length <= 1) return 0;
        const count = importExcelData(db, data, type, category);
        logs.push(`${sheetName}: ${count}行`);
        return count;
      };
      totalCount += processSheet('新品利润测算', 'profit_estimation');
      totalCount += processSheet('月度损益', 'profit_loss');
      totalCount += processSheet('进销存', 'inventory');
      // Restore scraped competitor data
      for (const s of scrapedData) {
        db.prepare('UPDATE profit_estimation SET competitor_detail = ? WHERE sku = ?').run(s.competitor_detail, s.sku);
      }
      // Also save to disk for Render persistence
      if (scrapedData.length > 0) {
        const fs = require('fs');
        fs.writeFileSync(path.join(__dirname, 'scraped_backup.json'), JSON.stringify(scrapedData));
      }
    } else {
      // Legacy: single sheet, try to detect type from sheet name
      const sn = sheetNames[0];
      const data = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' });
      const file_type = req.body.file_type || 'profit_loss';
      totalCount = importExcelData(db, data, file_type, category);
      logs.push(`${sn}: ${totalCount}行`);
    }

    db.prepare(`INSERT INTO upload_log (filename, file_type, category, rows_imported, uploaded_by) VALUES (?, ?, ?, ?, ?)`)
      .run(req.file.originalname, isTemplate ? '导入模版' : req.body.file_type, category, totalCount, req.session.user.name);

    res.json({ success: true, rows_imported: totalCount, detail: logs.join(', ') });
  } catch (e) {
    res.status(500).json({ error: '文件解析失败: ' + e.message });
  }
});

// Clear all data for a category
app.post('/api/admin/clear', requireAdmin, (req, res) => {
  const db = getDb();
  const category = req.body.category || req.session.currentCategory || '滤清组套';
  const r1 = db.prepare('DELETE FROM profit_estimation WHERE category = ?').run(category);
  const r2 = db.prepare('DELETE FROM profit_loss WHERE category = ?').run(category);
  const r3 = db.prepare('DELETE FROM inventory WHERE category = ?').run(category);
  res.json({ success: true, deleted: { profit_estimation: r1.changes, profit_loss: r2.changes, inventory: r3.changes } });
});

// Upload history
app.get('/api/admin/history', requireAdmin, (req, res) => {
  const db = getDb();
  const history = db.prepare('SELECT * FROM upload_log ORDER BY uploaded_at DESC LIMIT 100').all();
  res.json({ history });
});

// Browse data
app.get('/api/admin/data/:type', requireAdmin, (req, res) => {
  const db = getDb();
  const { type } = req.params;
  const { search, category, limit = 100, offset = 0 } = req.query;

  const validTypes = ['profit_estimation', 'profit_loss', 'inventory', 'users'];
  if (!validTypes.includes(type)) return res.status(400).json({ error: 'Invalid type' });

  let query = `SELECT * FROM ${type} WHERE 1=1`;
  const params = [];

  if (category && type !== 'users') {
    query += ` AND category = ?`;
    params.push(category);
  }

  if (search) {
    query += ` AND (sku LIKE ? OR product_name LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`);
  }

  query += ` ORDER BY id DESC LIMIT ? OFFSET ?`;
  params.push(parseInt(limit), parseInt(offset));

  const rows = db.prepare(query).all(...params);
  res.json({ rows, total: rows.length });
});

// Delete record
app.delete('/api/admin/data/:type/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const { type, id } = req.params;

  const validTypes = ['profit_estimation', 'profit_loss', 'inventory'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: 'Invalid type' });
  }

  db.prepare(`DELETE FROM ${type} WHERE id = ?`).run(id);
  res.json({ success: true });
});

// Get all users (for admin)
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  res.json({ users });
});

// Update user role
app.put('/api/admin/users/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const { role } = req.body;
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  res.json({ success: true });
});

// ============================================================
// START SERVER
// ============================================================
const os = require('os');

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

app.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  console.log(`\n📊 新品监控看板已启动`);
  console.log(`   本地访问: http://localhost:${PORT}`);
  console.log(`   局域网分享: http://${localIP}:${PORT}`);
  console.log(`   输入姓名即可登录\n`);
});
