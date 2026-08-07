// ============================================================
// App State
// ============================================================
let currentUser = null;
let currentCategory = '';
let charts = {};
let currentMonthFilter = '';

// Format helpers
const fmt2 = v => (v != null && !isNaN(v)) ? Number(v).toFixed(2) : '--';
const fmtPct = v => (v != null && !isNaN(v)) ? Number(v).toFixed(2) + '%' : '--';
const fmtUSD = v => (v != null && !isNaN(v)) ? '$' + Number(v).toFixed(2) : '--';

// ============================================================
// Init
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  const resp = await fetch('/api/user');
  const data = await resp.json();
  if (data.user) {
    currentUser = data.user;
    showCategorySelection();
  } else {
    document.getElementById('loginModal').style.display = 'flex';
    document.getElementById('loginName').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  }

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Upload zone
  const zone = document.getElementById('uploadZone');
  if (zone) {
    zone.addEventListener('click', () => document.getElementById('fileInput').click());
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('dragover'); document.getElementById('fileInput').files = e.dataTransfer.files; });
  }
  document.getElementById('fileInput')?.addEventListener('change', () => uploadFile());
});

// ============================================================
// Auth
// ============================================================
async function doLogin() {
  const name = document.getElementById('loginName').value.trim();
  if (!name) return alert('请输入姓名');
  const resp = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  const data = await resp.json();
  if (data.success) { currentUser = data.user; showCategorySelection(); }
  else alert(data.error || '登录失败');
}

async function doLogout() {
  await fetch('/api/logout', { method: 'POST' });
  currentUser = null; currentCategory = '';
  document.getElementById('app').style.display = 'none';
  document.getElementById('categoryModal').style.display = 'none';
  document.getElementById('loginModal').style.display = 'flex';
  document.getElementById('loginName').value = '';
}

function switchToLogin() {
  document.getElementById('categoryModal').style.display = 'none';
  document.getElementById('loginModal').style.display = 'flex';
}

// ============================================================
// Category Selection
// ============================================================
async function showCategorySelection() {
  document.getElementById('loginModal').style.display = 'none';
  const resp = await fetch('/api/categories');
  const data = await resp.json();
  const list = document.getElementById('categoryList');
  list.innerHTML = data.categories.map(c => `
    <div class="cat-item" onclick="selectCategory('${c.name}')">
      📂 ${c.name}
    </div>
  `).join('');

  // Admin can add categories
  if (currentUser.role === 'admin') {
    document.getElementById('newCategoryBox').style.display = 'block';
  }
  document.getElementById('categoryModal').style.display = 'flex';
  document.getElementById('newCategoryName').addEventListener('keydown', e => { if (e.key === 'Enter') createCategory(); });
}

async function selectCategory(name) {
  currentCategory = name;
  document.getElementById('categoryModal').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('currentCategoryName').textContent = name;
  document.getElementById('userDisplay').textContent = `👤 ${currentUser.name}`;
  document.getElementById('uploadCategory').textContent = name;

  // Save category preference
  await fetch('/api/user/category', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({category:name}) });

  // Refresh user info with category permissions
  const resp = await fetch('/api/user');
  const data = await resp.json();
  if (data.user) currentUser = data.user;

  switchTab('panel1');
  updateShareUrl();
}

function canManage() {
  return currentUser.role === 'admin' || (currentUser.managed_categories || []).includes(currentCategory);
}

async function createCategory() {
  const name = document.getElementById('newCategoryName').value.trim();
  if (!name) return alert('请输入品类名称');
  const resp = await fetch('/api/categories', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  const data = await resp.json();
  if (data.success) { showCategorySelection(); }
  else alert(data.error);
}

function showCategorySwitch() {
  // Show category selection modal to switch
  document.getElementById('categoryModal').style.display = 'flex';
}

// ============================================================
// API Helper
// ============================================================
function apiUrl(path, extraParams) {
  const sep = path.includes('?') ? '&' : '?';
  let url = path + sep + 'category=' + encodeURIComponent(currentCategory);
  if (extraParams) url += '&' + extraParams;
  if (currentMonthFilter) url += '&months=' + currentMonthFilter;
  return url;
}

// ============================================================
// Tabs
// ============================================================
let currentTab = 'panel1';
let kpiAllData = [];
let kpiSort = { field: null, asc: true };

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelector(`[data-tab="${tabName}"]`)?.classList.add('active');
  document.getElementById(tabName)?.classList.add('active');
  currentTab = tabName;
  refreshCurrentPanel();
}

function refreshCurrentPanel() {
  Object.values(charts).forEach(c => c.destroy());
  charts = {};
  switch (currentTab) {
    case 'panel1': loadPanel1(); break;
    case 'panel2': loadPanel2(); break;
    case 'panel3': loadPanel3(); break;
    case 'panel4': loadPanel4(); break;
    case 'datamgmt': loadDataMgmt(); break;
    default: loadPanel1();
  }
}

// ============================================================
// Month Filter Dropdown
// ============================================================
function toggleMonthDropdown() {
  const menu = document.getElementById('monthDropdownMenu');
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}
function updateMonthSelection() {
  const checked = document.querySelectorAll('#monthDropdownMenu input:checked');
  const label = document.getElementById('monthDropdownLabel');
  if (checked.length === 0) label.textContent = '全部月份';
  else if (checked.length <= 3) label.textContent = Array.from(checked).map(c => c.value + '月').join('、');
  else label.textContent = checked.length + '个月份已选';
}
function applyMonthFilter() {
  const checked = document.querySelectorAll('#monthDropdownMenu input:checked');
  currentMonthFilter = Array.from(checked).map(c => c.value).join(',');
  updateMonthSelection();
  kpiSort = { field: null, asc: true };
  refreshCurrentPanel();
}
function clearMonthFilter() {
  document.querySelectorAll('#monthDropdownMenu input').forEach(c => c.checked = false);
  currentMonthFilter = '';
  document.getElementById('monthDropdownLabel').textContent = '全部月份';
  kpiSort = { field: null, asc: true };
  refreshCurrentPanel();
}
document.addEventListener('click', (e) => {
  const dd = document.getElementById('monthDropdown');
  if (dd && !dd.contains(e.target)) document.getElementById('monthDropdownMenu').style.display = 'none';
});

// ============================================================
// Panel 1: KPI
// ============================================================
async function loadPanel1() {
  try {
    // Destroy existing charts before redrawing
    Object.values(charts).forEach(c => c.destroy());
    charts = {};
    const resp = await fetch(apiUrl('/api/dashboard/kpi'));
    const data = await resp.json();

    document.getElementById('kpi-activation').textContent = data.summary.sales_activation_rate + '%';
    document.getElementById('kpi-dd').textContent = data.summary.dd_achievement_rate + '%';
    document.getElementById('kpi-margin').textContent = data.summary.gross_margin + '%';
    document.getElementById('kpi-count').textContent = data.summary.launched_count;

    // DD达成率分布饼图
    const ddDetails = data.details.filter(d => d.estimated_dd > 0);
    let ddBelow50 = 0, dd50to100 = 0, dd100to200 = 0, ddAbove200 = 0;
    ddDetails.forEach(d => {
      const v = d.dd_achievement || 0;
      if (v < 50) ddBelow50++;
      else if (v <= 100) dd50to100++;
      else if (v <= 200) dd100to200++;
      else ddAbove200++;
    });
    const ddTotal = ddDetails.length || 1;
    charts.dd = new Chart(document.getElementById('chartDD').getContext('2d'), {
      type: 'pie',
      data: {
        labels: ['<50%', '50%-100%', '100%-200%', '>200%'],
        datasets: [{
          data: [ddBelow50, dd50to100, dd100to200, ddAbove200],
          backgroundColor: ['#ff4d4f', '#faad14', '#91caff', '#52c41a']
        }]
      },
      options: { responsive: true, maintainAspectRatio: true, plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => {
          const pct = (ctx.raw / ddTotal * 100).toFixed(1);
          return ctx.label + ': ' + ctx.raw + '个SKU (' + pct + '%)';
        }}}
      }}
    });
    document.getElementById('ddDataList').innerHTML = [
      {label:'<50%', count:ddBelow50, color:'#ff4d4f'},
      {label:'50%-100%', count:dd50to100, color:'#faad14'},
      {label:'100%-200%', count:dd100to200, color:'#91caff'},
      {label:'>200%', count:ddAbove200, color:'#52c41a'}
    ].map(d => `<div class="data-item" style="background:${d.color}15">
      <span><span class="data-dot" style="background:${d.color}"></span>${d.label}</span>
      <span><span class="data-pct">${(d.count/ddTotal*100).toFixed(1)}%</span> <span class="data-count">(${d.count}个)</span></span>
    </div>`).join('');

    // 毛利率分布饼图
    const marginDetails = data.details.filter(d => d.has_sales && d.np_margin != null);
    let mBelow0 = 0, m0to10 = 0, m10to20 = 0, mAbove20 = 0;
    marginDetails.forEach(d => {
      const v = (d.np_margin || 0) * 100;
      if (v < 0) mBelow0++;
      else if (v <= 10) m0to10++;
      else if (v <= 20) m10to20++;
      else mAbove20++;
    });
    const mTotal = marginDetails.length || 1;
    charts.margin = new Chart(document.getElementById('chartMargin').getContext('2d'), {
      type: 'pie',
      data: {
        labels: ['<0%', '0%-10%', '10%-20%', '>20%'],
        datasets: [{
          data: [mBelow0, m0to10, m10to20, mAbove20],
          backgroundColor: ['#ff4d4f', '#faad14', '#91caff', '#52c41a']
        }]
      },
      options: { responsive: true, maintainAspectRatio: true, plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => {
          const pct = (ctx.raw / mTotal * 100).toFixed(1);
          return ctx.label + ': ' + ctx.raw + '个SKU (' + pct + '%)';
        }}}
      }}
    });
    document.getElementById('marginDataList').innerHTML = [
      {label:'<0%', count:mBelow0, color:'#ff4d4f'},
      {label:'0%-10%', count:m0to10, color:'#faad14'},
      {label:'10%-20%', count:m10to20, color:'#91caff'},
      {label:'>20%', count:mAbove20, color:'#52c41a'}
    ].map(d => `<div class="data-item" style="background:${d.color}15">
      <span><span class="data-dot" style="background:${d.color}"></span>${d.label}</span>
      <span><span class="data-pct">${(d.count/mTotal*100).toFixed(1)}%</span> <span class="data-count">(${d.count}个)</span></span>
    </div>`).join('');

    kpiAllData = data.details;
    renderKpiTable();
    loadAISuggestions('panel1');
  } catch(e) { console.error('Panel1:', e); }
}

function renderKpiTable() {
  let data = [...kpiAllData];
  if (kpiSort.field) {
    data.sort((a,b) => {
      let va, vb;
      if (kpiSort.field === 'dd') { va = a.dd_achievement || 0; vb = b.dd_achievement || 0; }
      else { va = (a.np_margin != null) ? a.np_margin : -999; vb = (b.np_margin != null) ? b.np_margin : -999; }
      return kpiSort.asc ? va - vb : vb - va;
    });
  }
  document.querySelector('#kpiTable tbody').innerHTML = data.map(d => {
    const ddPct = d.dd_achievement;
    const npMarginPct = d.np_margin != null ? Math.round(d.np_margin*10000)/100 : null;
    const latestMarginPct = d.latest_margin != null ? Math.round(d.latest_margin*10000)/100 : null;
    return `<tr data-ddpct="${ddPct}" data-margin="${npMarginPct!==null?npMarginPct:'--'}">
    <td><a href="#" onclick="showSkuDetail('${d.sku}');return false" style="color:#1677ff;text-decoration:underline" title="${d.product_name||''}">${d.sku}</a></td>
    <td>${d.launch_date||''}</td>
    <td>${Math.round(d.max_monthly_sales)}</td><td>${d.max_month||''}</td><td>${fmt2(d.actual_dd)}</td><td>${fmt2(d.estimated_dd)}</td>
    <td class="${ddPct>=100?'good':ddPct>=60?'warn':'bad'}">${fmtPct(ddPct)}</td>
    <td class="${(d.np_margin||0)>=0.2?'good':(d.np_margin||0)>=0?'warn':'bad'}">${npMarginPct!==null?fmtPct(npMarginPct):'--'}</td>
    <td class="${(d.latest_margin||0)>(d.np_margin||0)?'green':(d.latest_margin||0)<(d.np_margin||0)-0.02?'bad':''}">${latestMarginPct!==null?fmtPct(latestMarginPct):'--'}</td>
  </tr>`;
  }).join('');
  applyKpiFilters();
}

function sortKpiTable(field) {
  if (kpiSort.field === field) kpiSort.asc = !kpiSort.asc;
  else { kpiSort.field = field; kpiSort.asc = false; }
  document.getElementById('arrow-dd').textContent = '';
  document.getElementById('arrow-margin').textContent = '';
  document.getElementById('arrow-'+field).textContent = kpiSort.asc ? ' ▲' : ' ▼';
  renderKpiTable();
}

// ============================================================
// Panel 2: Fees
// ============================================================
async function loadPanel2() {
  try {
    const resp = await fetch(apiUrl('/api/dashboard/fees'));
    const data = await resp.json();
    const feeKeys = ['first_leg','last_leg','warehouse','promotion','refund'];
    const feeLabels = ['头程','尾程','仓储','推广','退款'];

    // 实测费率 vs 测算费率（用销量加权汇总）
    let totalRev = 0;
    const adjSums = {}, estSums = {};
    feeKeys.forEach(k => { adjSums[k] = 0; estSums[k] = 0; });
    for (const r of data.details) {
      totalRev += (r.revenue || 0);
      for (const k of feeKeys) {
        adjSums[k] += (r.fees[k].adjusted_value || 0);
        estSums[k] += (r.fees[k].estimated_value || 0);
      }
    }
    charts.feeRate = new Chart(document.getElementById('chartFeeRate').getContext('2d'), {
      type: 'bar', data: { labels: feeLabels, datasets: [
        { label: '测算费率', data: feeKeys.map(k => totalRev>0 ? Math.round(estSums[k]/totalRev*10000)/100 : 0), backgroundColor: '#91caff' },
        { label: '实测费率', data: feeKeys.map(k => totalRev>0 ? Math.round(adjSums[k]/totalRev*10000)/100 : 0), backgroundColor: '#1677ff' }
      ]},
      options: { responsive: true, plugins: { legend: { position: 'top' }, tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + ctx.raw + '%' } } }, scales: { y: { title: { display: true, text: '费率 %' }, ticks: { callback: v => v + '%' } } } }
    });
    document.getElementById('feeDataList').innerHTML = feeKeys.map((k, i) => {
      const est = totalRev>0 ? Math.round(estSums[k]/totalRev*10000)/100 : 0;
      const adj = totalRev>0 ? Math.round(adjSums[k]/totalRev*10000)/100 : 0;
      const diff = adj - est;
      const cls = Math.abs(diff) > 2 ? 'bad' : Math.abs(diff) > 1 ? 'warn' : '';
      return `<div class="data-item"><span>${feeLabels[i]}</span><span><span style="font-size:12px;color:#999">测算${fmtPct(est)}</span> <b>实测${fmtPct(adj)}</b> <span class="${cls}">${diff>0?'↑':diff<0?'↓':''}${Math.abs(diff).toFixed(1)}pp</span></span></div>`;
    }).join('');

    const fp = v => (v!=null&&!isNaN(v)) ? Number(v).toFixed(2) + '%' : '--';
    document.querySelector('#feeTable tbody').innerHTML = data.details.slice(0,200).map(d => {
      const cols = ['first_leg','last_leg','warehouse','promotion','refund'];
      const cells = cols.map(k => {
        const f = d.fees[k];
        return `<td>${fp(f.estimated_rate*100)}</td><td>${fp(f.actual_rate*100)}</td>
          <td class="${Math.abs((f.adjusted_rate||0)-(f.estimated_rate||0))>0.02?'warn':''}">${fp(f.adjusted_rate*100)}</td>`;
      }).join('');
      return `<tr>
        <td>${d.sku}</td>
        <td>${fmtUSD(d.estimated_price)}</td><td>${fmtUSD(d.actual_unit_price)}</td>
        ${cells}
      </tr>`;
    }).join('');
    loadAISuggestions('panel2');
  } catch(e) { console.error('Panel2:', e); }
}

// ============================================================
// Panel 3: Price (SKU chart + model table)
// ============================================================
async function loadPanel3(searchQuery) {
  try {
    // SKU-level chart data (now returns top 30 by volume)
    const skuResp = await fetch(apiUrl('/api/dashboard/price-sku'));
    const skuData = await skuResp.json();
    const skus = skuData.details; // already top 30 sorted by volume

    // Line chart: 实际售价 vs 测算价 vs 红线价
    charts.price = new Chart(document.getElementById('chartPrice').getContext('2d'), {
      type: 'line',
      data: { labels: skus.map(d => d.sku), datasets: [
        { label: '测算价', data: skus.map(d => d.estimated_price), borderColor: '#1677ff', backgroundColor: 'transparent', tension: 0.1, pointRadius: 3 },
        { label: '红线价', data: skus.map(d => d.redline_price), borderColor: '#ff4d4f', backgroundColor: 'transparent', borderDash: [5,3], tension: 0.1, pointRadius: 3 },
        { label: '实际售价', data: skus.map(d => d.actual_price), borderColor: '#fa8c16', backgroundColor: 'transparent', tension: 0.1, pointRadius: 4, borderWidth: 2 }
      ]},
      options: { responsive: true, plugins: { legend: { position: 'top' } }, scales: { x: { ticks: { maxRotation: 90, font: { size: 9 } } }, y: { title: { display: true, text: '价格 $' } } } }
    });

    // 新品期价格状态分布饼图
    const npStatusCounts = { below_redline: 0, redline_to_estimated: 0, above_estimated: 0 };
    skuData.details.forEach(d => { npStatusCounts[d.price_status] = (npStatusCounts[d.price_status]||0)+1; });
    charts.priceStatusNP = new Chart(document.getElementById('chartPriceStatusNP').getContext('2d'), {
      type: 'pie',
      data: { labels: ['低于红线价','红线价-测算价','高于测算价'], datasets: [{ data: [npStatusCounts.below_redline, npStatusCounts.redline_to_estimated, npStatusCounts.above_estimated], backgroundColor: ['#ff4d4f','#faad14','#52c41a'] }] },
      options: { responsive: true, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => { const t = ctx.dataset.data.reduce((a,b)=>a+b,0)||1; return ctx.label + ': ' + ctx.raw + '个 (' + (ctx.raw/t*100).toFixed(1) + '%)'; } } } } }
    });

    // 最新月价格状态分布饼图
    const latestStatusCounts = { below_redline: 0, redline_to_estimated: 0, above_estimated: 0 };
    skuData.details.forEach(d => { if (d.latest_status) latestStatusCounts[d.latest_status] = (latestStatusCounts[d.latest_status]||0)+1; });
    charts.priceStatusLatest = new Chart(document.getElementById('chartPriceStatusLatest').getContext('2d'), {
      type: 'pie',
      data: { labels: ['低于红线价','红线价-测算价','高于测算价'], datasets: [{ data: [latestStatusCounts.below_redline, latestStatusCounts.redline_to_estimated, latestStatusCounts.above_estimated], backgroundColor: ['#ff4d4f','#faad14','#52c41a'] }] },
      options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => { const t = ctx.dataset.data.reduce((a,b)=>a+b,0)||1; return ctx.label + ': ' + ctx.raw + '个 (' + (ctx.raw/t*100).toFixed(1) + '%)'; } } } } }
    });
    // Populate data boxes
    const priceBuckets = [
      {key:'below_redline',label:'低于红线价',color:'#ff4d4f'},
      {key:'redline_to_estimated',label:'红线价-测算价',color:'#faad14'},
      {key:'above_estimated',label:'高于测算价',color:'#52c41a'}
    ];
    const npTotal = skuData.details.length || 1;
    document.getElementById('npPriceDataList').innerHTML = priceBuckets.map(b => {
      const c = npStatusCounts[b.key] || 0;
      return `<div class="data-item" style="background:${b.color}15">
        <span><span class="data-dot" style="background:${b.color}"></span>${b.label}</span>
        <span><span class="data-pct">${(c/npTotal*100).toFixed(1)}%</span> <span class="data-count">(${c}个)</span></span>
      </div>`;
    }).join('');
    const hasLatest = skuData.details.filter(d => d.latest_price != null);
    const latestTotal = hasLatest.length || 1;
    document.getElementById('latestPriceDataList').innerHTML = priceBuckets.map(b => {
      const c = latestStatusCounts[b.key] || 0;
      return `<div class="data-item" style="background:${b.color}15">
        <span><span class="data-dot" style="background:${b.color}"></span>${b.label}</span>
        <span><span class="data-pct">${(c/latestTotal*100).toFixed(1)}%</span> <span class="data-count">(${c}个)</span></span>
      </div>`;
    }).join('');

    // Model table
    let url = apiUrl('/api/dashboard/price');
    if (searchQuery) url += '&search=' + encodeURIComponent(searchQuery);
    const modelResp = await fetch(url);
    const modelData = await modelResp.json();
    const statusMap = { normal: '🟢 正常', below_redline: '🔴 低于红线', below_target: '🟡 低于目标', adjusted_up: '🔵 已调价回升' };

    document.querySelector('#priceTable tbody').innerHTML = modelData.details.slice(0,200).map(d => {
      const sds = d.sku_details || [];
      const competitors = d.competitors || [];
      let html = '';

      // Build competitor info HTML
      let compHtml = '';
      if (competitors.length > 0) {
        compHtml = '<div style="font-size:12px;line-height:1.6">';
        competitors.forEach(c => {
          const histInfo = c.historical_price ? `立项时: $${c.historical_price.toFixed(2)} / 月销${Math.round(c.historical_volume||0)}` : '';
          if (c.current_price) {
            compHtml += `<div style="margin:2px 0;padding:3px 6px;background:#f6ffed;border-radius:3px;border-left:3px solid #52c41a">
              <b>${c.asin}</b> | ${histInfo} | 卖家: ${c.seller}
              <br>当前: <b style="color:#1677ff">$${c.current_price.toFixed(2)}</b>${c.price_change_note?` <span class="warn">${c.price_change_note}</span>`:''}
            </div>`;
          } else {
            compHtml += `<div style="margin:2px 0;padding:3px 6px;background:#fafafa;border-radius:3px">
              <b>${c.asin}</b> | ${histInfo} | 卖家: ${c.seller}
              <br>当前: <span style="color:#faad14">⏳ 待爬取</span>
            </div>`;
          }
        });
        compHtml += '</div>';
      } else {
        compHtml = '<span style="color:#ccc">无竞对</span>';
      }

      // Each SKU gets its own row
      sds.forEach((sd, si) => {
        html += '<tr>';
        if (si === 0) {
          html += `<td rowspan="${sds.length}"><strong>${d.fram_model}</strong></td>`;
        }
        const sStatus = statusMap[sd.price_status] || (sd.price_status === 'no_data' ? '⚪ 无数据' : '🟢 正常');
        html += `<td>${sd.sku}</td>
          <td>${fmtUSD(d.estimated_price)}</td>
          <td>${fmtUSD(d.redline_price)}</td>
          <td class="${sd.price_status==='below_redline'?'bad':sd.price_status==='below_target'?'warn':'good'}">${sd.actual_price!=null?fmtUSD(sd.actual_price):'--'}</td>
          <td class="${sd.latest_price&&sd.latest_price>sd.actual_price?'green':''}">${sd.latest_price!=null?fmtUSD(sd.latest_price)+(sd.latest_month?'('+sd.latest_month+')':''):'--'}</td>
          <td>${sStatus}</td>`;
        if (si === 0) {
          html += `<td rowspan="${sds.length}" style="max-width:350px;white-space:normal">${compHtml}</td>`;
        }
        html += '</tr>';
      });
      return html;
    }).join('');
    loadAISuggestions('panel3');
  } catch(e) { console.error('Panel3:', e); }
}

function searchModel() {
  loadPanel3(document.getElementById('modelSearch').value.trim() || undefined);
}

async function exportPriceSkuExcel() {
  const resp = await fetch(apiUrl('/api/dashboard/price-sku'));
  const data = await resp.json();
  const rows = [['SKU','产品名称','型号','测算价$','红线价$','新品期实际售价$','新品期状态','最新月售价$','最新月状态']];
  data.details.forEach(d => rows.push([d.sku,d.product_name,d.fram_model,d.estimated_price,d.redline_price,d.actual_price,d.price_status,d.latest_price,d.latest_status]));
  XLSX.writeFile(XLSX.utils.book_new(XLSX.utils.aoa_to_sheet(rows),'SKU价格'), 'SKU价格数据.xlsx');
}

async function exportPriceExcel() {
  const resp = await fetch(apiUrl('/api/dashboard/price'));
  const data = await resp.json();
  const rows = [['型号','关联SKU','测算价','红线价','实际售价','状态','竞对ASIN','历史价格','历史月销','卖家']];
  data.details.forEach(d => {
    (d.competitors||[]).forEach(c => rows.push([d.fram_model,(d.skus||[]).join(';'),d.estimated_price,d.redline_price,d.actual_price,d.price_status,c.asin,c.historical_price,c.historical_volume,c.seller]));
    if (!d.competitors.length) rows.push([d.fram_model,(d.skus||[]).join(';'),d.estimated_price,d.redline_price,d.actual_price,d.price_status,'','','','']);
  });
  XLSX.writeFile(XLSX.utils.book_new(XLSX.utils.aoa_to_sheet(rows),'竞对数据'), '竞对价格数据.xlsx');
}

// ============================================================
// Panel 4: Refunds
// ============================================================
async function loadPanel4() {
  try {
    const resp = await fetch(apiUrl('/api/dashboard/refunds'));
    const data = await resp.json();
    document.getElementById('refundCount').textContent = data.summary.high_refund_model_count;

    let html = '';
    data.details.forEach(d => {
      const brands = d.brands || [];
      const maxRows = Math.max(...brands.map(b => (b.skus||[]).length), 1);
      for (let i = 0; i < maxRows; i++) {
        html += '<tr>';
        if (i === 0) html += `<td rowspan="${maxRows}"><strong>${d.fram_model}</strong></td>`;
        brands.forEach((b, bi) => {
          const s = (b.skus||[])[i];
          if (s) {
            html += `<td>${b.brand}</td><td>${s.sku}</td><td class="bad">${s.weighted_refund_rate}%</td><td>${Math.round(s.total_volume_3m||0)}</td>`;
            if (i === 0 && bi === 0) html += `<td rowspan="${maxRows}"><button class="btn btn-sm" onclick="showRefundDetail('${d.fram_model}')">📋 详情</button></td>`;
          } else { html += '<td></td><td></td><td></td><td></td>'; }
        });
        if (brands.length === 1) html += '<td></td><td></td><td></td><td></td>';
        html += '</tr>';
      }
    });
    document.querySelector('#refundTable tbody').innerHTML = html;
    loadAISuggestions('panel4');
  } catch(e) { console.error('Panel4:', e); }
}

async function showRefundDetail(model) {
  try {
    const resp = await fetch(apiUrl('/api/dashboard/refunds'));
    const data = await resp.json();
    const detail = data.details.find(d => d.fram_model === model);
    if (!detail) return;
    document.getElementById('refundDetailTitle').textContent = `退款详情 - ${model}`;
    let html = '<div class="refund-detail-section">';
    (detail.brands||[]).forEach(b => {
      html += `<h4 style="margin-top:12px">品牌: ${b.brand}</h4>`;
      (b.skus||[]).forEach(s => {
        html += `<p><strong>${s.sku}</strong> - ${s.product_name||''} | 退款率: <span class="bad">${s.weighted_refund_rate}%</span> | 收入: ${Math.round(s.total_volume_3m||0)}</p>`;
        if (s.monthly_data && s.monthly_data.length > 0) {
          html += `<table class="data-table"><thead><tr><th>月份</th><th>销量</th><th>销售额</th><th>退款率</th><th>推广占比</th></tr></thead><tbody>`
            + s.monthly_data.map(m => `<tr><td>${m.month}</td><td>${Math.round(m.sales_volume||0)}</td><td>$${Math.round((m.sales_revenue||0)*100)/100}</td><td class="${(m.refund_rate||0)>0.08?'bad':''}">${Math.round((m.refund_rate||0)*10000)/100}%</td><td>${Math.round((m.promotion_ratio||0)*10000)/100}%</td></tr>`).join('')
            + `</tbody></table>`;
        }
      });
    });
    html += '</div>';
    document.getElementById('refundDetailContent').innerHTML = html;
    document.getElementById('refundDetailModal').style.display = 'flex';
  } catch(e) { console.error(e); }
}

function closeRefundDetail() { document.getElementById('refundDetailModal').style.display = 'none'; }
async function exportRefundExcel() {
  const resp = await fetch(apiUrl('/api/dashboard/refunds'));
  const data = await resp.json();
  const rows = [['型号','品牌','SKU','产品名称','加权退款率%','近3月收入']];
  data.details.forEach(d => { (d.brands||[]).forEach(b => { (b.skus||[]).forEach(s => rows.push([d.fram_model,b.brand,s.sku,s.product_name,s.weighted_refund_rate,s.total_revenue_3m])); }); });
  XLSX.writeFile(XLSX.utils.book_new(XLSX.utils.aoa_to_sheet(rows),'高退款型号'), '高退款型号清单.xlsx');
}

// ============================================================
// AI Suggestions
// ============================================================
async function loadAISuggestions(panel) {
  try {
    const resp = await fetch(apiUrl('/api/dashboard/suggestions/'+panel));
    if (!resp.ok) return;
    const data = await resp.json();
    const container = document.getElementById('ai'+panel.charAt(0).toUpperCase()+panel.slice(1));
    if (!container) return;
    let html = '<h3>🤖 AI 智能建议</h3><div class="ai-grid">';
    for (const [key, dept] of Object.entries(data.departments||{})) {
      html += `<div class="ai-card"><h4>${dept.label}</h4><ul>${(dept.items||[]).map(i=>'<li>'+i+'</li>').join('')}</ul></div>`;
    }
    html += '</div>';
    container.innerHTML = html;
  } catch(e) {}
}

// ============================================================
// Data Management Tab
// ============================================================
async function loadDataMgmt() {
  updateShareUrl();

  // Only system admin sees users, categories, and category admins
  const isSysAdmin = currentUser.role === 'admin';
  document.getElementById('userMgmtSection').style.display = isSysAdmin ? 'block' : 'none';
  document.getElementById('categoryMgmtSection').style.display = isSysAdmin ? 'block' : 'none';
  document.getElementById('categoryAdminsSection').style.display = isSysAdmin ? 'block' : 'none';

  // Upload button enabled only for admins
  const uploadBtn = document.querySelector('#uploadZone .btn');
  if (uploadBtn) {
    uploadBtn.style.display = canManage() ? 'inline-block' : 'none';
    if (!canManage()) {
      document.querySelector('#uploadZone p').textContent = '仅品类管理员可上传数据';
    }
  }

  if (isSysAdmin) {
    loadUsers();
    loadCategoriesForAdmin();
    loadCategoryAdmins();
    loadCatOptions();
  }
  loadHistory();
}

function updateShareUrl() {
  const url = window.location.origin + window.location.pathname;
  document.getElementById('shareUrl').value = url + '?category=' + encodeURIComponent(currentCategory);
}

function downloadReport() {
  const extra = currentMonthFilter ? 'months=' + currentMonthFilter : '';
  window.open(apiUrl('/api/report', extra), '_blank');
}

function copyShareUrl() {
  const input = document.getElementById('shareUrl');
  input.select();
  document.execCommand('copy');
  alert('链接已复制！分享给同事，输入姓名即可查看' + currentCategory + '看板');
}

async function loadCategoryAdmins() {
  try {
    const resp = await fetch('/api/admin/category-admins');
    const data = await resp.json();
    document.querySelector('#caTable tbody').innerHTML = data.admins.map(a =>
      `<tr><td>${a.user_name}</td><td>${a.category}</td><td>${a.created_at}</td>
       <td><button class="btn btn-sm" onclick="removeCategoryAdmin(${a.id})">移除</button></td></tr>`).join('');
  } catch(e) {}
}

async function loadCatOptions() {
  try {
    const resp = await fetch('/api/categories');
    const data = await resp.json();
    const sel = document.getElementById('caCategory');
    sel.innerHTML = '<option value="">选择品类</option>' + data.categories.map(c => `<option>${c.name}</option>`).join('');
  } catch(e) {}
}

async function addCategoryAdmin() {
  const userName = document.getElementById('caUserName').value.trim();
  const category = document.getElementById('caCategory').value;
  if (!userName || !category) return alert('请填写完整');
  const resp = await fetch('/api/admin/category-admins', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({user_name: userName, category})
  });
  const data = await resp.json();
  if (data.success) { loadCategoryAdmins(); document.getElementById('caUserName').value = ''; }
  else alert(data.error);
}

async function removeCategoryAdmin(id) {
  if (!confirm('确认移除此品类管理员？')) return;
  await fetch('/api/admin/category-admins/' + id, { method: 'DELETE' });
  loadCategoryAdmins();
}

async function loadHistory() {
  try {
    const resp = await fetch('/api/admin/history');
    const data = await resp.json();
    document.querySelector('#historyTable tbody').innerHTML = data.history.map(h =>
      `<tr><td>${h.filename}</td><td>${h.category||''}</td><td>${h.file_type}</td><td>${h.rows_imported}</td><td>${h.uploaded_by}</td><td>${h.uploaded_at}</td></tr>`).join('');
  } catch(e) {}
}

async function loadUsers() {
  try {
    const resp = await fetch('/api/admin/users');
    const data = await resp.json();
    document.querySelector('#userTable tbody').innerHTML = data.users.map(u =>
      `<tr><td>${u.name}</td><td><select onchange="updateUserRole(${u.id},this.value)" ${currentUser.name===u.name?'disabled':''}><option value="viewer" ${u.role==='viewer'?'selected':''}>浏览者</option><option value="admin" ${u.role==='admin'?'selected':''}>管理员</option></select></td><td>${u.created_at}</td><td>${currentUser.name===u.name?'当前用户':''}</td></tr>`).join('');
  } catch(e) {}
}

async function loadCategoriesForAdmin() {
  try {
    const resp = await fetch('/api/categories');
    const data = await resp.json();
    document.querySelector('#catTable tbody').innerHTML = data.categories.map(c =>
      `<tr><td>${c.name}</td><td>${c.created_at}</td></tr>`).join('');
  } catch(e) {}
}

async function updateUserRole(id, role) {
  await fetch('/api/admin/users/'+id, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({role}) });
  loadUsers();
}

async function clearAllData() {
  if (!confirm('⚠️ 确认清空「' + currentCategory + '」所有数据？\n\n将删除：利润测算、月度损益、进销存\n操作不可恢复！')) return;
  const status = document.getElementById('clearStatus');
  status.textContent = '清空中...'; status.style.color = '#666';
  try {
    const resp = await fetch('/api/admin/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: currentCategory })
    });
    const data = await resp.json();
    status.textContent = `✅ 已清空（利润测算${data.deleted.profit_estimation}条、损益${data.deleted.profit_loss}条、进销存${data.deleted.inventory}条）`;
    status.style.color = '#52c41a';
    loadHistory();
    refreshCurrentPanel();
  } catch(e) {
    status.textContent = '❌ 清空失败: ' + e.message;
    status.style.color = '#ff4d4f';
  }
}

async function createCategoryFromAdmin() {
  const name = document.getElementById('newCatInput').value.trim();
  if (!name) return alert('请输入品类名称');
  const resp = await fetch('/api/categories', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name}) });
  if ((await resp.json()).success) { loadCategoriesForAdmin(); document.getElementById('newCatInput').value = ''; }
}

async function uploadFile() {
  const file = document.getElementById('fileInput').files[0];
  if (!file) return;
  const status = document.getElementById('uploadStatus');
  status.textContent = '上传中...'; status.className = '';
  try {
    const result = await doUpload(file);
    status.textContent = `✅ 上传成功！导入 ${result.rows_imported} 行 (${result.detail || ''})`;
    status.className = 'success';
    loadHistory();
    refreshCurrentPanel();
  } catch(e) {
    status.textContent = '❌ ' + (e.message || '上传失败');
    status.className = 'error';
  }
  document.getElementById('fileInput').value = '';
}

async function doUpload(file) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('category', currentCategory);
  const resp = await fetch('/api/admin/upload', { method:'POST', body:formData });
  const data = await resp.json();
  if (!data.success) throw new Error(data.error);
  return data;
}

// ============================================================
// KPI Table Filters
// ============================================================
function applyKpiFilters() {
  const searchQ = (document.getElementById('kpiSearch')?.value || '').toLowerCase();
  const ddMin = parseFloat(document.getElementById('ddMin')?.value) || null;
  const ddMax = parseFloat(document.getElementById('ddMax')?.value) || null;
  const marginMin = parseFloat(document.getElementById('marginMin')?.value) || null;
  const marginMax = parseFloat(document.getElementById('marginMax')?.value) || null;

  document.querySelectorAll('#kpiTable tbody tr').forEach(row => {
    const text = row.textContent.toLowerCase();
    const dd = parseFloat(row.dataset.ddpct) || 0;
    const margin = row.dataset.margin === '--' ? null : parseFloat(row.dataset.margin);

    let show = true;
    if (searchQ && !text.includes(searchQ)) show = false;
    if (show && ddMin !== null && dd < ddMin) show = false;
    if (show && ddMax !== null && dd > ddMax) show = false;
    if (show && marginMin !== null && (margin === null || margin < marginMin)) show = false;
    if (show && marginMax !== null && (margin === null || margin > marginMax)) show = false;
    row.style.display = show ? '' : 'none';
  });
}

// ============================================================
// SKU Detail Popup
// ============================================================
async function showSkuDetail(sku) {
  try {
    const resp = await fetch(apiUrl('/api/dashboard/sku-detail/' + sku));
    const d = await resp.json();
    document.getElementById('skuDetailTitle').textContent = `SKU详情 - ${sku}`;

    const statusMap = { normal: '🟢 正常', below_redline: '🔴 低于红线价', adjusted_up: '🔵 已调价回升' };
    const rp = v => (v != null && !isNaN(v)) ? Number(v*100).toFixed(2) + '%' : '--';

    let html = `
      <p><b>产品名称:</b> ${d.product_name||''} | <b>型号:</b> ${d.fram_model||''} | <b>品牌:</b> ${d.brand||''} | <b>批次:</b> ${d.batch||''} | <b>上架:</b> ${d.launch_date||''}</p>
      <hr>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:12px">`;

    // KPI
    if (d.kpi) {
      html += `<div style="background:#f6ffed;padding:12px;border-radius:8px">
        <h4>📈 指标达成</h4>
        <p>预测DD: ${d.kpi.est_dd} | 实际DD: ${d.kpi.actual_dd} | <b>达成率: ${d.kpi.dd_pct}%</b></p>
        <p>最高月销: ${d.kpi.max_sales} (${d.kpi.max_sales_month})</p>
        <p>新品期毛利率: <b>${rp(d.kpi.np_margin)}</b></p>
        <p>最新月份毛利率: <b>${rp(d.kpi.latest_margin)}</b></p>
      </div>`;
    }

    // Price
    if (d.price) {
      html += `<div style="background:#fff7e6;padding:12px;border-radius:8px">
        <h4>🏷 价格</h4>
        <p>测算价: $${d.price.est_price||'--'} | 红线价: $${d.price.redline||'--'}</p>
        <p>实际售价: <b>$${d.price.actual}</b> | <span class="${d.price.status==='below_redline'?'bad':'good'}">${statusMap[d.price.status]||''}</span></p>
      </div>`;
    }

    // Fees
    if (d.fees) {
      const f = d.fees;
      html += `<div style="background:#e6f4ff;padding:12px;border-radius:8px">
        <h4>💰 费率比对 (${f.month})</h4>
        <p>测算价: $${f.est_price||'--'} | 实际售价: $${f.act_price_usd}</p>
        <table class="data-table" style="font-size:12px"><thead><tr><th>费用项</th><th>测算</th><th>实际</th><th>实测</th></tr></thead><tbody>
          <tr><td>头程</td><td>${rp(f.fees.first_leg.est)}</td><td>${rp(f.fees.first_leg.act)}</td><td>${rp(f.fees.first_leg.adj)}</td></tr>
          <tr><td>尾程</td><td>${rp(f.fees.last_leg.est)}</td><td>${rp(f.fees.last_leg.act)}</td><td>${rp(f.fees.last_leg.adj)}</td></tr>
          <tr><td>仓储</td><td>${rp(f.fees.warehouse.est)}</td><td>${rp(f.fees.warehouse.act)}</td><td>${rp(f.fees.warehouse.adj)}</td></tr>
          <tr><td>推广</td><td>${rp(f.fees.promotion.est)}</td><td>${rp(f.fees.promotion.act)}</td><td>${rp(f.fees.promotion.adj)}</td></tr>
          <tr><td>退款</td><td>${rp(f.fees.refund.est)}</td><td>${rp(f.fees.refund.act)}</td><td>${rp(f.fees.refund.adj)}</td></tr>
        </tbody></table>
      </div>`;
    }

    // Refund
    html += `<div style="background:#fff2f0;padding:12px;border-radius:8px">
      <h4>⚠ 退款 (近3月加权: <b class="bad">${d.refund.weighted_rate}%</b>)</h4>`;
    if (d.refund.monthly.length > 0) {
      html += `<table class="data-table" style="font-size:12px"><thead><tr><th>月份</th><th>销量</th><th>销售额</th><th>退款率</th><th>推广占比</th></tr></thead><tbody>
        ${d.refund.monthly.map(m => `<tr><td>${m.month}</td><td>${Math.round(m.sales_volume||0)}</td><td>$${Math.round((m.sales_revenue||0)*100)/100}</td><td class="${(m.refund_rate||0)>0.08?'bad':''}">${rp(m.refund_rate)}</td><td>${rp(m.promotion_ratio)}</td></tr>`).join('')}
      </tbody></table>`;
    }
    html += '</div></div>';

    document.getElementById('skuDetailContent').innerHTML = html;
    document.getElementById('skuDetailModal').style.display = 'flex';
  } catch(e) { console.error(e); }
}

function closeSkuDetail() {
  document.getElementById('skuDetailModal').style.display = 'none';
}

// ============================================================
// Table Filter & Export
// ============================================================
function filterTable(tableId, query) {
  const rows = document.getElementById(tableId)?.querySelectorAll('tbody tr') || [];
  const q = query.toLowerCase();
  rows.forEach(row => { row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none'; });
}

function exportTable(tableId, filename) {
  const table = document.getElementById(tableId);
  let csv = '';
  table.querySelectorAll('tr').forEach(row => { csv += Array.from(row.querySelectorAll('th,td')).map(c => '"'+(c.textContent||'').replace(/"/g,'""')+'"').join(',') + '\n'; });
  const blob = new Blob(['﻿'+csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
}

// Close modals
document.addEventListener('click', e => {
  ['refundDetailModal','skuDetailModal'].forEach(id => {
    const m = document.getElementById(id);
    if (m && m.style.display === 'flex' && e.target === m) m.style.display = 'none';
  });
});
