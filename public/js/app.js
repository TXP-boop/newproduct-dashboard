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
    let extra = currentMonthFilter ? 'months=' + currentMonthFilter : '';
    const resp = await fetch(apiUrl('/api/dashboard/kpi', extra));
    const data = await resp.json();

    document.getElementById('kpi-activation').textContent = data.summary.sales_activation_rate + '%';
    document.getElementById('kpi-dd').textContent = data.summary.dd_achievement_rate + '%';
    document.getElementById('kpi-margin').textContent = data.summary.gross_margin + '%';
    document.getElementById('kpi-count').textContent = data.summary.launched_count;

    const ddSkus = data.details.filter(d => d.estimated_dd > 0).slice(0, 30);
    charts.dd = new Chart(document.getElementById('chartDD').getContext('2d'), {
      type: 'bar',
      data: { labels: ddSkus.map(d => d.sku.replace('PT','').replace('KX','')), datasets: [
        { label: '预测DD', data: ddSkus.map(d => d.estimated_dd), backgroundColor: '#91caff' },
        { label: '实际DD', data: ddSkus.map(d => d.actual_dd), backgroundColor: '#1677ff' }
      ]},
      options: { responsive: true, plugins: { legend: { position: 'top' } }, scales: { y: { title: { display: true, text: '日均销量' } } } }
    });

    const mSkus = data.details.filter(d => d.has_sales).slice(0, 30);
    charts.margin = new Chart(document.getElementById('chartMargin').getContext('2d'), {
      type: 'bar',
      data: { labels: mSkus.map(d => d.sku.replace('PT','').replace('KX','')), datasets: [{ label: '毛利率',
        data: mSkus.map(d => Math.round((d.max_monthly_margin||0)*10000)/100),
        backgroundColor: mSkus.map(d => (d.max_monthly_margin||0)>=0.2?'#52c41a':(d.max_monthly_margin||0)>=0?'#faad14':'#ff4d4f') }] },
      options: { responsive: true, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ctx.raw + '%' } } }, scales: { y: { title: { display: true, text: '毛利率 %' } } } }
    });

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
      else { va = (a.max_monthly_margin != null) ? a.max_monthly_margin : -999; vb = (b.max_monthly_margin != null) ? b.max_monthly_margin : -999; }
      return kpiSort.asc ? va - vb : vb - va;
    });
  }
  document.querySelector('#kpiTable tbody').innerHTML = data.map(d => {
    const ddPct = d.dd_achievement;
    const marginPct = d.max_monthly_margin ? Math.round(d.max_monthly_margin*10000)/100 : null;
    return `<tr data-ddpct="${ddPct}" data-margin="${marginPct!==null?marginPct:'--'}">
    <td><a href="#" onclick="showSkuDetail('${d.sku}');return false" style="color:#1677ff;text-decoration:underline" title="${d.product_name||''}">${d.sku}</a></td>
    <td>${d.launch_date||''}</td>
    <td>${Math.round(d.max_monthly_sales)}</td><td>${d.max_month||''}</td><td>${fmt2(d.actual_dd)}</td><td>${fmt2(d.estimated_dd)}</td>
    <td class="${ddPct>=100?'good':ddPct>=60?'warn':'bad'}">${fmtPct(ddPct)}</td>
    <td>${d.max_margin_month||''}</td><td class="${(d.max_monthly_margin||0)>=0.2?'good':(d.max_monthly_margin||0)>=0?'warn':'bad'}">${marginPct!==null?fmtPct(marginPct):'--'}</td>
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

    charts.feeRate = new Chart(document.getElementById('chartFeeRate').getContext('2d'), {
      type: 'bar', data: { labels: feeLabels, datasets: [
        { label: '测算费率', data: feeKeys.map(k => data.summary[k].est_rate), backgroundColor: '#91caff' },
        { label: '实际费率', data: feeKeys.map(k => data.summary[k].act_rate), backgroundColor: '#1677ff' }
      ]},
      options: { responsive: true, plugins: { legend: { position: 'top' }, tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + ctx.raw + '%' } } }, scales: { y: { title: { display: true, text: '费率 %' }, ticks: { callback: v => v + '%' } } } }
    });
    charts.feeValue = new Chart(document.getElementById('chartFeeValue').getContext('2d'), {
      type: 'bar', data: { labels: feeLabels, datasets: [
        { label: '测算费用($)', data: feeKeys.map(k => Math.round(data.summary[k].est_total*100)/100), backgroundColor: '#91caff' },
        { label: '实际费用($)', data: feeKeys.map(k => Math.round(data.summary[k].act_total*100)/100), backgroundColor: '#1677ff' }
      ]},
      options: { responsive: true, plugins: { legend: { position: 'top' } }, scales: { y: { title: { display: true, text: '费用 $' } } } }
    });

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
    // SKU-level chart data
    const skuResp = await fetch(apiUrl('/api/dashboard/price-sku'));
    const skuData = await skuResp.json();
    const skus = skuData.details.slice(0, 30);

    charts.price = new Chart(document.getElementById('chartPrice').getContext('2d'), {
      type: 'bar',
      data: { labels: skus.map(d => d.sku.replace('PT','').replace('KX','')), datasets: [
        { label: '测算价', data: skus.map(d => d.estimated_price), backgroundColor: '#91caff' },
        { label: '红线价', data: skus.map(d => d.redline_price), backgroundColor: '#ffccc7', borderColor: '#ff4d4f', borderWidth: 1 },
        { label: '实际售价', data: skus.map(d => d.actual_price), backgroundColor: '#ffd591', borderColor: '#fa8c16', borderWidth: 1 }
      ]},
      options: { responsive: true, plugins: { legend: { position: 'top' } }, scales: { y: { title: { display: true, text: '价格 $' } } } }
    });

    const statusCounts = { normal: 0, below_redline: 0 };
    skuData.details.forEach(d => statusCounts[d.price_status] = (statusCounts[d.price_status]||0)+1);
    charts.priceStatus = new Chart(document.getElementById('chartPriceStatus').getContext('2d'), {
      type: 'doughnut',
      data: { labels: ['正常','低于红线价'], datasets: [{ data: [statusCounts.normal,statusCounts.below_redline], backgroundColor: ['#52c41a','#ff4d4f'] }] },
      options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
    });

    // Model table
    let url = apiUrl('/api/dashboard/price');
    if (searchQuery) url += '&search=' + encodeURIComponent(searchQuery);
    const modelResp = await fetch(url);
    const modelData = await modelResp.json();
    const statusMap = { normal: '🟢 正常', below_redline: '🔴 低于红线', below_target: '🟡 低于目标' };

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
              <b>${c.asin}</b> | <b style="color:#1677ff">当前: $${c.current_price.toFixed(2)}</b> | 月销: ~${c.current_volume||'?'} | 卖家: ${c.seller}
              ${histInfo?`<br>${histInfo}`:''}
              ${c.price_change_note?` <span class="warn">${c.price_change_note}</span>`:''}
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
  const rows = [['SKU','产品名称','型号','测算价$','红线价$','实际售价$','状态']];
  data.details.forEach(d => rows.push([d.sku,d.product_name,d.fram_model,d.estimated_price,d.redline_price,d.actual_price,d.price_status]));
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

    const statusMap = { normal: '🟢 正常', below_redline: '🔴 低于红线价' };
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
        <p>最高毛利率: ${rp(d.kpi.max_margin)} (${d.kpi.max_margin_month})</p>
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
