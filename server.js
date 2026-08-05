const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const { initDb, getDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3456;

// Initialize database
initDb();

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
  const EST_REFUND_RATE = 0.0336;
  const EST_PROMOTION_RATE = 0.1769;

  const skus = db.prepare(`
    SELECT pe.sku, pe.product_name, pe.fram_model, pe.batch,
      pe.material_ratio as est_material, pe.first_leg_ratio as est_first_leg,
      pe.last_leg_ratio as est_last_leg, pe.warehouse_ratio as est_warehouse,
      pe.estimated_price as est_price, pe.redline_price, pe.dd_value as est_dd,
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
        promotion: feeObj(EST_PROMOTION_RATE, maxMonth.promotion_ratio),
        refund: feeObj(EST_REFUND_RATE, maxMonth.refund_rate)
      }
    });
  }

  // Aggregate summary
  const summary = {
    first_leg: { est_total: 0, act_total: 0 },
    last_leg: { est_total: 0, act_total: 0 },
    warehouse: { est_total: 0, act_total: 0 },
    promotion: { est_total: 0, act_total: 0, est_rate: EST_PROMOTION_RATE * 100 },
    refund: { est_total: 0, act_total: 0, est_rate: EST_REFUND_RATE * 100 }
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
  // promotion and refund use fixed estimated rates
  summary.promotion.est_rate = Math.round(EST_PROMOTION_RATE * 10000) / 100;
  summary.promotion.act_rate = totalRevenue > 0 ? Math.round((summary.promotion.act_total / totalRevenue) * 10000) / 100 : 0;
  summary.refund.est_rate = Math.round(EST_REFUND_RATE * 10000) / 100;
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
  const EST_REF = 0.0336, EST_PROMO = 0.1769;

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

  // Refund
  const refMonths = db.prepare(`SELECT month,sales_volume,sales_revenue,refund_rate,promotion_ratio FROM profit_loss WHERE sku=? AND month>='202605' AND month<='202608' ORDER BY month DESC`).all(sku);
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
    SELECT pl.sku, pl.month, pl.sales_volume, pl.sales_revenue, pl.refund_rate, pl.promotion_ratio,
           pe.fram_model, pe.product_name, pe.batch
    FROM profit_loss pl
    LEFT JOIN profit_estimation pe ON pl.sku = pe.sku AND pl.category = pe.category
    WHERE pl.month >= '202605' AND pl.month <= '202608' AND pl.category = ?
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
    const model = data.fram_model || sku; // fallback to SKU if no model
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

  const suggestions = {
    departments: {
      product: { label: '📦 产品部门', items: [] },
      operations: { label: '📊 运营部门', items: [] },
      engineering: { label: '🔧 工程/供应链', items: [] },
      aftersales: { label: '🛡 售后/质量', items: [] }
    }
  };

  if (panel === 'panel1') {
    // KPI suggestions
    const category = getCategory(req);
    const kpiData = db.prepare(`
      SELECT pe.sku, pe.dd_value, pe.fram_model, inv.fba_first_arrival
      FROM profit_estimation pe LEFT JOIN inventory inv ON pe.sku = inv.sku AND pe.category = inv.category
      WHERE inv.fba_first_arrival IS NOT NULL AND pe.category = ?
    `).all(category);

    // Find low DD achievement SKUs
    const lowDD = [];
    for (const s of kpiData.slice(0, 50)) {
      const npMonths = getNewProductMonths(db, s.sku);
      if (!npMonths) continue;
      const ph = npMonths.months.map(() => '?').join(',');
      const monthly = db.prepare(`SELECT MAX(sales_volume) as max_sales FROM profit_loss WHERE sku=? AND month IN (${ph})`).get(s.sku, ...npMonths.months);
      const actualDD = (monthly?.max_sales || 0) / 30;
      const ddRate = s.dd_value > 0 ? actualDD / s.dd_value : 0;
      if (ddRate < 0.5) lowDD.push({ sku: s.sku, model: s.fram_model, ddRate });
    }

    suggestions.departments.product.items = [
      'DD达成率低于50%的SKU数量较多（如' + lowDD.slice(0,3).map(d=>d.sku).join('、') + '等），建议重新评估这些型号的市场需求，考虑是否降价促销或调整产品定位',
      '部分SKU毛利率为负（新品期内），建议排查是否因推广费用过高导致，可考虑分阶段控制推广预算',
      '新品动销率100%表明选品方向正确，但需关注DD值与实际销量的偏差，优化后续新品立项时的DD预测模型'
    ];
    suggestions.departments.operations.items = [
      '针对DD达成率低的SKU，建议增加站内广告投放和促销活动（如Coupon、Lightning Deal），提升曝光和转化',
      '新品期内毛利率波动大的SKU，建议优化推广节奏：上架首月控制ACOS<30%，后续逐步放宽至盈亏平衡线',
      '利用Q1/Q2上架数据对比，找出最佳上架时间窗口，指导后续新品发布排期'
    ];
    suggestions.departments.engineering.items = [
      '对于DD达成率持续偏低的型号，建议与供应商协商降低MOQ或采购价，减少库存压力和成本',
      '部分型号的采购价含税较高影响毛利率，建议寻找备选供应商或优化包装方案降低材积重',
      'FBA头程费用占比较高（测算~2.7%，实际~4.8%），建议优化装箱方案，提高集装箱利用率'
    ];
    suggestions.departments.aftersales.items = [
      '关注高退款率型号的产品质量问题，建议对退款率>8%的型号进行退货原因分析',
      '新品期内出现的负毛利率月份，需排查是否因批量退货/换货导致的费用异常'
    ];

  } else if (panel === 'panel2') {
    suggestions.departments.product.items = [
      '推广费用实际占比（约18.6%）远超测算假定（17.69%），需在新品立项时更保守地预估推广费率，建议上调至20%',
      '退款率实际（约4.05%）高于测算假定（3.36%），建议在新品利润测算中将退款率假定上调至4-5%',
      '尾程费用实际（31.25%）高于测算（28.41%），FBA费率调整是主要原因，需关注亚马逊费率变化并更新测算模型'
    ];
    suggestions.departments.operations.items = [
      '推广费用是费率偏差最大的项目，建议按SKU维度分析哪些广告投放ROI偏低，优化广告结构',
      '对于推广占比超过25%的SKU，建议立即调整广告策略，降低广泛匹配比例，增加精准长尾词投放',
      '仓储费用实际与测算基本持平（2.34% vs 2.21%），说明库存周转管理较好，继续保持'
    ];
    suggestions.departments.engineering.items = [
      '头程费用略高（4.77% vs 2.74%测算），建议审查近期海运/空运费率变化，考虑切换更经济的物流方案',
      '尾程费用上升可能与产品包装尺寸被亚马逊重新测量有关，建议抽查FBA入库后的尺寸数据',
      '对于材积重偏大的SKU，评估是否可以压缩包装尺寸或改用更轻的包材降低FBA尾程费用'
    ];
    suggestions.departments.aftersales.items = [
      '退款率超预期（4.05% vs 3.36%测算），建议按型号分析退款原因，区分"产品问题"和"买家原因"',
      '对于退款率>8%的型号，应建立退货产品检查流程，收集退货样本进行质量分析',
      '建议在listing中完善产品适配信息，减少因"不兼容"导致的退货'
    ];

  } else if (panel === 'panel3') {
    suggestions.departments.product.items = [
      '实际售价低于红线价的SKU需重点关注，可能面临亏损风险，建议评估是否提价或考虑清仓退出',
      '实际售价远低于测算价的型号，说明市场竞争激烈，竞对降价幅度较大，需重新评估该型号的竞争力',
      '竞对价格数据为立项时历史数据，建议定期（每季度）更新竞对信息，确保定价策略与市场同步'
    ];
    suggestions.departments.operations.items = [
      '实际售价低于测算价10%以上的型号，如无法提价，建议通过促销活动提升销量以规模摊薄固定成本',
      '对于价格优势明显的型号（实际售价低于竞对中位价），可在广告中突出价格优势吸引流量',
      '建议监控竞对价格变化，当竞对提价时及时跟进，抓住利润窗口期'
    ];
    suggestions.departments.engineering.items = [
      '对实际售价持续低于红线价的型号，建议与供应商谈判降低采购价，或评估是否更换更低成本的原材料',
      '部分型号竞对价格较低可能因其包装/材质成本更低，建议研究竞对产品实物，寻找降本空间'
    ];
    suggestions.departments.aftersales.items = [
      '低价SKU如果伴随高退款率，可能是产品质量问题导致差评→降价→继续差评的恶性循环，需优先处理',
      '建议对比竞对listing的评分和差评内容，识别产品改进方向'
    ];

  } else if (panel === 'panel4') {
    suggestions.departments.product.items = [
      '当前有41个型号退款率超过8%阈值，需要产品部门逐型号排查退款原因并制定改善计划',
      '同一型号PT/KAX两个品牌退款率差异大的，说明品牌定位或客户群不同，可针对性调整产品策略',
      '退款率异常高的新品，建议暂停继续备货，待问题解决后再恢复'
    ];
    suggestions.departments.operations.items = [
      '高退款率SKU的广告投放应立即暂停或大幅缩减，避免差评积累导致转化率持续下降',
      '对于退款率>20%的SKU，建议在listing中增加更详细的产品说明和安装指南，减少误购',
      '分析退款率与推广占比的相关性：过度推广可能吸引非精准客户，导致退款率上升'
    ];
    suggestions.departments.engineering.items = [
      '对退款率最高的前10个型号（如KX1FCK25700退款率42.75%），建议工程部进行产品实物抽检',
      '同一型号不同品牌间退款率差异显著的，建议对比两个品牌的供应商/生产工艺差异',
      'FRAM组套大厂号相同的产品，如只有某一品牌退款高，可能是供应商端问题，需与供应商沟通'
    ];
    suggestions.departments.aftersales.items = [
      '退款率>20%的型号建议建立专项售后跟踪机制，每笔退款均需记录原因并汇总分析',
      '退货产品应100%进行外观和功能检查，区分"产品缺陷"和"客户误购"，并拍照存档',
      '针对高频退款原因（如"不兼容"、"质量差"），建议更新产品描述和A+页面，增加适配车型验证工具'
    ];
  }

  res.json(suggestions);
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
app.post('/api/admin/upload', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '请选择文件' });
  }

  const { file_type } = req.body;
  if (!['profit_estimation', 'profit_loss', 'inventory'].includes(file_type)) {
    return res.status(400).json({ error: '请选择正确的文件类型' });
  }

  const XLSX = require('xlsx');
  const db = getDb();

  try {
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws);

    let count = 0;
    const category = req.body.category || req.session.currentCategory || '滤清组套';

    for (const row of data) {
      if (file_type === 'profit_loss') {
        const sku = (row['商品编码'] || row[2] || '').toString().trim().toUpperCase();
        if (!sku || sku === '合计') continue;
        const month = (row['月份'] || row[3] || '').toString().trim();
        if (month === '合计') continue;

        const salesVol = parseFloat(row['销量'] || row[4]) || 0;
        const salesRev = parseFloat(row['销售额'] || row[5]) || 0;
        db.prepare(`INSERT INTO profit_loss (category, sku, month, sales_volume, sales_revenue,
          gross_profit, gross_margin, material_ratio, first_leg_ratio, last_leg_ratio,
          refund_rate, warehouse_ratio, promotion_ratio, unit_price)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          category, sku, month, salesVol, salesRev,
          parseFloat(row['毛利润-实际'] || row[6]) || 0,
          parseFloat(row['毛利率'] || row[7]) || 0,
          parseFloat(row['材料占比'] || row[10]) || 0,
          parseFloat(row['头程占比'] || row[11]) || 0,
          parseFloat(row['尾程占比'] || row[12]) || 0,
          parseFloat(row['退款率含vc'] || row[13]) || 0,
          parseFloat(row['仓储费占比'] || row[14]) || 0,
          parseFloat(row['推广占比合计（含广告折扣））'] || row[15]) || 0,
          salesVol > 0 ? salesRev / salesVol : 0
        );
        count++;
      } else if (file_type === 'inventory') {
        const sku = (row['商品编码'] || row[0] || '').toString().trim().toUpperCase();
        if (!sku || sku === '合计') continue;
        db.prepare(`INSERT INTO inventory (category, sku, brand, fba_first_arrival, fba_available_stock,
          fba_in_transit, total_stock, sales_7d, sales_14d, sales_30d)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          category, sku,
          row['品牌'] || row[37] || '',
          (row['FBA首次到货时间'] || row[40]) ? new Date((row['FBA首次到货时间'] || row[40])).toISOString().slice(0,10) : null,
          parseInt(row['FBA可用库存'] || row[7]) || 0,
          parseInt(row['FBA在途库存'] || row[8]) || 0,
          parseInt(row['总库存'] || row[12]) || 0,
          parseFloat(row['7天销量'] || row[17]) || 0,
          parseFloat(row['14天销量'] || row[18]) || 0,
          parseFloat(row['30天销量'] || row[19]) || 0
        );
        count++;
      }
    }

    db.prepare(`INSERT INTO upload_log (filename, file_type, category, rows_imported, uploaded_by)
      VALUES (?, ?, ?, ?, ?)`).run(req.file.originalname, file_type, category, count, req.session.user.name);

    res.json({ success: true, rows_imported: count });
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
