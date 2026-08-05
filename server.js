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
        if (sn === '新品利润测算') type = 'profit_estimation';
        else if (sn === '月度损益') type = 'profit_loss';
        else if (sn === '进销存') type = 'inventory';
        else return;
        const count = importExcelData(db, data, type, '滤清组套');
        console.log(`  ${sn}: ${count} rows imported`);
      });
    } catch(e) {
      console.log('Auto-import skipped:', e.message);
    }
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

// ============================================================
// DASHBOARD API
// ============================================================

// Helper: get new product period months for a SKU
function getNewProductMonths(db, sku) {
  const inv = db.prepare('SELECT fba_first_arrival FROM inventory WHERE sku = ?').get(sku);
  if (!inv || !inv.fba_first_arrival) return null;
  const arrival = new Date(inv.fba_first_arrival);
  const months = [];
  for (let i = 0; i < 4; i++) {
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
  `).all(category);

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
    if (!sku.fba_first_arrival) continue;

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
      SELECT month, sales_volume, sales_revenue, gross_profit, gross_margin
      FROM profit_loss
      WHERE sku = ? AND month IN (${placeholders})
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
        max_monthly_margin: null,
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
        has_sales: false, max_monthly_sales: 0, max_monthly_margin: null,
        actual_dd: 0, estimated_dd: sku.dd_value || 0, dd_achievement: 0
      });
      continue;
    }

    const maxSales = monthsWithSales.reduce((max, m) =>
      (m.sales_volume || 0) > (max.sales_volume || 0) ? m : max, monthsWithSales[0]);

    // Find max margin month (取新品期内毛利率最高的月份)
    const maxMargin = monthsWithSales.reduce((max, m) =>
      (m.gross_margin ?? -999) > (max.gross_margin ?? -999) ? m : max, monthsWithSales[0]);

    const actualDD = (maxSales.sales_volume || 0) / 30;
    const estimatedDD = sku.dd_value || 0;

    totalActualDD += actualDD;
    totalEstimatedDD += estimatedDD;

    results.push({
      sku: sku.sku,
      product_name: sku.product_name,
      fram_model: sku.fram_model,
      brand: sku.brand,
      batch: sku.batch,
      launch_date: sku.fba_first_arrival,
      has_sales: true,
      max_monthly_sales: maxSales.sales_volume || 0,
      max_month: maxSales.month,
      max_monthly_margin: maxMargin.gross_margin || 0,
      max_margin_month: maxMargin.month,
      max_monthly_revenue: maxMargin.sales_revenue || 0,
      max_monthly_profit: maxMargin.gross_profit || 0,
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

  // Gross margin (using each SKU's max margin month)
  const totalProfit = results.filter(r => r.has_sales).reduce((s, r) => s + (r.max_monthly_profit || 0), 0);
  const totalRevenue = results.filter(r => r.has_sales).reduce((s, r) => s + (r.max_monthly_revenue || 0), 0);
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
    const maxMonth = monthlyData.reduce((max, m) =>
      (m.sales_volume || 0) > (max.sales_volume || 0) ? m : max, monthlyData[0]);

    const revenue = maxMonth.sales_revenue || 1;
    const actualUnitPriceRMB = (maxMonth.sales_volume > 0) ? revenue / maxMonth.sales_volume : 0;
    const actualUnitPriceUSD = actualUnitPriceRMB / 6.7;
    const estPrice = sku.est_price || 1;
    // 实测费率 = 实际占比 × 实际售价$ / 测算价$（消除售价变化对占比的影响）
    const priceRatio = actualUnitPriceUSD / estPrice;

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
      max_sales_month: maxMonth.month,
      revenue: revenue,
      actual_unit_price: Math.round(actualUnitPriceUSD * 100) / 100,
      estimated_price: estPrice,
      fees: {
        first_leg: feeObj(sku.est_first_leg, maxMonth.first_leg_ratio),
        last_leg: feeObj(sku.est_last_leg, maxMonth.last_leg_ratio),
        warehouse: feeObj(sku.est_warehouse, maxMonth.warehouse_ratio),
        promotion: feeObj(sku.est_promotion_rate || 0.1769, maxMonth.promotion_ratio),
        refund: feeObj(sku.est_refund_rate || 0.0336, maxMonth.refund_rate)
      }
    });
  }

  // Aggregate summary
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

  res.json({ summary, details: results });
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

  if (search) {
    modelQuery += ` AND (pe.fram_model LIKE ? OR pe.sku LIKE ?)`;
    return processPriceResults(
      db.prepare(modelQuery + ' GROUP BY pe.fram_model ORDER BY pe.fram_model').all(category, `%${search}%`, `%${search}%`), db, res);
  }

  processPriceResults(db.prepare(modelQuery + ' GROUP BY pe.fram_model ORDER BY pe.fram_model').all(category), db, res);
});

// SKU-level price data for chart
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

  const results = [];
  for (const sku of skus) {
    const npMonths = getNewProductMonths(db, sku.sku);
    if (!npMonths) continue;
    const ph = npMonths.months.map(() => '?').join(',');
    const monthly = db.prepare(`SELECT month, sales_volume, sales_revenue, unit_price FROM profit_loss WHERE sku=? AND month IN (${ph}) AND sales_volume>0`).all(sku.sku, ...npMonths.months);
    if (monthly.length === 0) continue;
    const maxMonth = monthly.reduce((max,m) => m.sales_volume>(max.sales_volume||0)?m:max, monthly[0]);
    results.push({
      sku: sku.sku,
      product_name: sku.product_name,
      fram_model: sku.fram_model,
      estimated_price: sku.estimated_price ? Math.round(sku.estimated_price*100)/100 : null,
      redline_price: sku.redline_price ? Math.round(sku.redline_price*100)/100 : null,
      actual_price: Math.round((maxMonth.unit_price||0)/6.7*100)/100,
      price_status: sku.redline_price && (maxMonth.unit_price/6.7) < sku.redline_price ? 'below_redline' : 'normal'
    });
  }
  res.json({ details: results });
});

// SKU综合详情（费率+价格+退款+KPI）
app.get('/api/dashboard/sku-detail/:sku', requireAuth, (req, res) => {
  const db = getDb();
  const { sku } = req.params;

  const pe = db.prepare('SELECT * FROM profit_estimation WHERE sku = ? LIMIT 1').get(sku);
  if (!pe) return res.status(404).json({ error: 'SKU not found' });

  const inv = db.prepare('SELECT * FROM inventory WHERE sku = ? LIMIT 1').get(sku);
  const npMonths = getNewProductMonths(db, sku);
  const EST_REF = pe.est_refund_rate || 0.0336, EST_PROMO = pe.est_promotion_rate || 0.1769;

  let feeData = null, priceData = null, kpiData = null;
  if (npMonths) {
    const ph = npMonths.months.map(() => '?').join(',');
    const monthly = db.prepare(`SELECT * FROM profit_loss WHERE sku=? AND month IN (${ph}) AND sales_volume>0`).all(sku, ...npMonths.months);
    if (monthly.length > 0) {
      const maxS = monthly.reduce((max,m) => m.sales_volume>(max.sales_volume||0)?m:max, monthly[0]);
      const maxM = monthly.reduce((max,m) => (m.gross_margin??-999)>(max.gross_margin??-999)?m:max, monthly[0]);
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
        max_sales: maxS.sales_volume, max_sales_month: maxS.month,
        max_margin: maxM.gross_margin, max_margin_month: maxM.month
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
        const actualPrice = (maxMonth.unit_price || 0) / 6.7;

        // 每个SKU独立判断价格状态
        let skuStatus = 'normal';
        if (redlinePrice && actualPrice < redlinePrice) {
          skuStatus = 'below_redline';
        } else if (estimatedPrice && actualPrice < estimatedPrice * 0.9) {
          skuStatus = 'below_target';
        }

        skuDetails.push({
          sku: sku,
          actual_price: Math.round(actualPrice * 100) / 100,
          price_status: skuStatus,
          max_sales_month: maxMonth.month,
          max_sales_volume: maxMonth.sales_volume
        });
      } else {
        skuDetails.push({
          sku: sku,
          actual_price: null,
          price_status: 'no_data',
          max_sales_month: null,
          max_sales_volume: 0
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
        const m = part.match(/^(B0[A-Z0-9]+):\$?([\d.]+)\/([\d.]+)\/([\d.]+)(?:\(([^)]*)\))?\s*(?:\[(.+)\])?/);
        if (!m) continue;

        const price = parseFloat(m[2]);
        const volume = parseFloat(m[3]);
        const revenue = parseFloat(m[4]);
        const seller = m[5] || 'Unknown';
        const note = m[6] || '';
        const isScraped = note.includes('涨') || note.includes('跌');

        // Reconstruct historical price from change note
        let histPrice = isScraped ? null : price;
        let histVolume = isScraped ? null : volume;
        let curPrice = isScraped ? price : null;
        let curVolume = isScraped ? volume : null;

        if (isScraped && note) {
          const chgMatch = note.match(/[涨跌]\$?([\d.]+)/);
          if (chgMatch) {
            const chg = parseFloat(chgMatch[1]);
            histPrice = note.includes('跌') ? price + chg : price - chg;
            histPrice = Math.round(histPrice * 100) / 100;
          }
          // Keep historical volume if available from original data (stored in revenue/price)
          if (revenue > 0 && histPrice > 0) {
            histVolume = Math.round(revenue / histPrice);
          }
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

// Panel 4: High Refund Warning (按型号聚合)
app.get('/api/dashboard/refunds', requireAuth, (req, res) => {
  const db = getDb();
  const category = getCategory(req);

  const refundData = db.prepare(`
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
        total_refund_value: 0
      };
    }
    skuRefundMap[row.sku].months.push(row);
    skuRefundMap[row.sku].total_revenue += (row.sales_revenue || 0);
    skuRefundMap[row.sku].total_refund_value += (row.refund_rate || 0) * (row.sales_revenue || 0);
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
  const S = (arr) => arr.slice(0, 3).join('、');

  const depts = {
    product: { label: '📦 产品部门', items: [] },
    operations: { label: '📊 运营部门', items: [] },
    engineering: { label: '🔧 工程/供应链', items: [] },
    aftersales: { label: '🛡 售后/质量', items: [] }
  };

  if (panel === 'panel1') {
    // Query actual KPI data
    const allSkus = db.prepare(`SELECT pe.sku,pe.dd_value,pe.fram_model,pe.product_name,inv.fba_first_arrival FROM profit_estimation pe LEFT JOIN inventory inv ON pe.sku=inv.sku AND pe.category=inv.category WHERE inv.fba_first_arrival IS NOT NULL AND pe.category=?`).all(category);
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
    const feeData = db.prepare(`SELECT pe.sku,pe.est_promotion_rate,pe.est_refund_rate,pe.first_leg_ratio as est_fl,pe.last_leg_ratio as est_ll,pe.warehouse_ratio as est_wh,inv.fba_first_arrival FROM profit_estimation pe LEFT JOIN inventory inv ON pe.sku=inv.sku AND pe.category=inv.category WHERE inv.fba_first_arrival IS NOT NULL AND pe.category=?`).all(category);
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
    const priceData = db.prepare(`SELECT pe.sku,pe.fram_model,pe.estimated_price,pe.redline_price,pe.competitor_detail,inv.fba_first_arrival FROM profit_estimation pe LEFT JOIN inventory inv ON pe.sku=inv.sku AND pe.category=inv.category WHERE inv.fba_first_arrival IS NOT NULL AND pe.category=?`).all(category);
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
  // Template format: skip header row (row 0), data from row 1
  // Legacy format: skip metadata rows
  const isTemplate = data.length > 0 && Array.isArray(data[0]) && String(data[0][0]).includes('商品编码');
  const startRow = isTemplate ? 1 : (file_type === 'profit_loss' ? 9 : file_type === 'inventory' ? 6 : 3);

  for (let i = startRow; i < data.length; i++) {
    const row = data[i];
    if (!row || !Array.isArray(row)) continue;

    if (file_type === 'profit_estimation') {
      // 用户模版格式:
      // col0=SKU, col1=商品名称, col2=型号, col3=DD值
      // col4=不含税采购价, col5=预估头程, col6=预估FBA尾程
      // col18=AMZ竞对详情
      // col23=FBA-测算价, col25=FBA-红线价
      // col26=材料占比, col27=税费占比, col28=头程占比, col29=尾程占比
      // col30=FBA-推广占比, col31=FBA-退款占比, col35=FBA-仓储占比
      const sku = String(row[0] || '').trim().toUpperCase();
      if (!sku) continue;
      const estPromo = parseFloat(row[30]); // 模版中的推广占比
      const estRefund = parseFloat(row[31]); // 模版中的退款占比
      db.prepare(`INSERT OR REPLACE INTO profit_estimation (category, product_code, sku, product_name, fram_model, batch, estimated_price, redline_price, dd_value, material_ratio, tax_ratio, first_leg_ratio, last_leg_ratio, warehouse_ratio, purchase_price, purchase_price_ex_tax, est_first_leg_fee, est_last_leg_fee, est_promotion_rate, est_refund_rate, competitor_detail) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(category, sku, sku, row[1]||'', row[2]||'', '', parseFloat(row[23])||null, parseFloat(row[25])||null, parseFloat(row[3])||0, parseFloat(row[26])||null, parseFloat(row[27])||null, parseFloat(row[28])||null, parseFloat(row[29])||null, parseFloat(row[35])||null, null, parseFloat(row[4])||null, parseFloat(row[5])||null, parseFloat(row[6])||null, isNaN(estPromo)?0.1769:estPromo, isNaN(estRefund)?0.0336:estRefund, String(row[18]||'').replace(/\n/g,' | '));
      count++;
    } else if (file_type === 'profit_loss') {
      // 用户模版: col2=SKU, col5=月份, col6=销量, col7=销售额, col8=毛利润, col9=毛利率
      // col12=材料占比, col13=头程占比, col14=尾程占比, col15=退款率含vc, col16=仓储费占比, col17=推广占比
      const sku = String(row[2] || '').trim().toUpperCase();
      if (!sku || sku === '合计') continue;
      const month = String(row[5] || '').trim();
      if (month === '合计' || !month) continue;
      const salesVol = parseFloat(row[6]) || 0; const salesRev = parseFloat(row[7]) || 0;
      db.prepare(`INSERT OR REPLACE INTO profit_loss (category, sku, month, sales_volume, sales_revenue, gross_profit, gross_margin, material_ratio, first_leg_ratio, last_leg_ratio, refund_rate, warehouse_ratio, promotion_ratio, unit_price) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(category, sku, month, salesVol, salesRev, parseFloat(row[8])||0, parseFloat(row[9])||0, parseFloat(row[12])||0, parseFloat(row[13])||0, parseFloat(row[14])||0, parseFloat(row[15])||0, parseFloat(row[16])||0, parseFloat(row[17])||0, salesVol>0?salesRev/salesVol:0);
      count++;
    } else if (file_type === 'inventory') {
      // 用户模版: col0=SKU, col5=FBA可用, col6=FBA在途, col10=总库存
      // col15=7天, col16=14天, col17=30天, col35=品牌, col38=FBA首次到货
      const sku = String(row[0] || '').trim().toUpperCase();
      if (!sku || sku === '合计') continue;
      const serialToDate = (s) => { if(!s||s<=0||isNaN(s)) return String(s||''); const d=new Date((new Date(1899,11,30)).getTime()+s*86400000); return d.toISOString().slice(0,10); };
      db.prepare(`INSERT OR REPLACE INTO inventory (category, sku, brand, fba_first_arrival, fba_available_stock, fba_in_transit, total_stock, sales_7d, sales_14d, sales_30d) VALUES (?,?,?,?,?,?,?,?,?,?)`)
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

    // Detect template format: multi-sheet with specific names
    const isTemplate = sheetNames.includes('新品利润测算') || sheetNames.includes('月度损益') || sheetNames.includes('进销存');

    if (isTemplate) {
      // Preserve scraped competitor data before clearing
      const scrapedData = db.prepare('SELECT sku, competitor_detail FROM profit_estimation WHERE category = ? AND competitor_detail LIKE ?').all(category, '%[↑%');
      // Clear existing data then import fresh
      db.prepare('DELETE FROM profit_estimation WHERE category = ?').run(category);
      db.prepare('DELETE FROM profit_loss WHERE category = ?').run(category);
      db.prepare('DELETE FROM inventory WHERE category = ?').run(category);
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
        db.prepare('UPDATE profit_estimation SET competitor_detail = ? WHERE sku = ? AND category = ?').run(s.competitor_detail, s.sku, category);
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
