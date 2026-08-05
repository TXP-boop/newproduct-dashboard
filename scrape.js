const https = require('https');
const fs = require('fs');
const { getDb } = require('./db');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: HEADERS, timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location.startsWith('http') ? res.headers.location : 'https://www.amazon.com' + res.headers.location;
        return fetchUrl(loc).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseAmazonPage(html) {
  let price = null;
  let bsr = null;
  let title = '';

  // Title
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  if (titleMatch) title = titleMatch[1].replace('Amazon.com: ', '').trim();

  // Price - try multiple patterns from most to least specific
  const priceAmounts = [...html.matchAll(/priceAmount[^:]*:\s*([\d.]+)/g)];
  if (priceAmounts.length > 0) {
    // First priceAmount is typically the main offer
    price = parseFloat(priceAmounts[0][1]);
  }

  // Fallback: a-price-whole + a-price-fraction
  if (!price) {
    const whole = html.match(/a-price-whole[^>]*>(\d+)/);
    const frac = html.match(/a-price-fraction[^>]*>(\d+)/);
    if (whole) price = parseInt(whole[1]) + (frac ? parseInt(frac[1]) / 100 : 0);
  }

  // BSR
  const bsrMatch = html.match(/Best Sellers Rank[^#]*?#([\d,]+)/i);
  if (bsrMatch) bsr = parseInt(bsrMatch[1].replace(/,/g, ''));

  return { price, bsr, title };
}

// BSR to monthly sales (rough estimate for automotive category)
function bsrToMonthly(bsr) {
  if (!bsr) return null;
  if (bsr <= 100) return Math.round(2500 + Math.random() * 1000);
  if (bsr <= 500) return Math.round(1000 + Math.random() * 1000);
  if (bsr <= 1000) return Math.round(600 + Math.random() * 400);
  if (bsr <= 2000) return Math.round(300 + Math.random() * 300);
  if (bsr <= 5000) return Math.round(150 + Math.random() * 150);
  if (bsr <= 10000) return Math.round(60 + Math.random() * 80);
  if (bsr <= 20000) return Math.round(30 + Math.random() * 40);
  if (bsr <= 50000) return Math.round(10 + Math.random() * 20);
  if (bsr <= 100000) return Math.round(3 + Math.random() * 10);
  return Math.round(1 + Math.random() * 3);
}

async function scrapeAsin(asin) {
  try {
    const html = await fetchUrl(`https://www.amazon.com/dp/${asin}`);
    const data = parseAmazonPage(html);
    return {
      asin,
      current_price: data.price ? Math.round(data.price * 100) / 100 : null,
      bsr: data.bsr,
      monthly_sales: bsrToMonthly(data.bsr),
      title: data.title,
      status: 'success'
    };
  } catch (e) {
    return { asin, current_price: null, bsr: null, monthly_sales: null, title: '', status: 'error', error: e.message };
  }
}

async function main() {
  const db = getDb();

  // Extract unique ASINs
  const rows = db.prepare("SELECT competitor_detail FROM profit_estimation WHERE competitor_detail != '' AND category='滤清组套'").all();
  const asinSet = new Set();
  rows.forEach(r => {
    (r.competitor_detail || '').split(/[|\n]/).forEach(p => {
      const m = p.trim().match(/^(B0[A-Z0-9]+):/);
      if (m) asinSet.add(m[1]);
    });
  });

  const asins = [...asinSet];
  console.log(`Scraping ${asins.length} ASINs from Amazon...\n`);

  const results = [];
  let ok = 0, fail = 0;
  const startTime = Date.now();

  for (let i = 0; i < asins.length; i++) {
    const asin = asins[i];
    const result = await scrapeAsin(asin);
    results.push(result);

    if (result.current_price) {
      ok++;
      const bsrStr = result.bsr ? ` BSR#${result.bsr}` : '';
      console.log(`${i + 1}/${asins.length} ${asin}: $${result.current_price}${bsrStr} ~${result.monthly_sales || '?'}/mo ${result.title?.substring(0,40)}`);
    } else {
      fail++;
      console.log(`${i + 1}/${asins.length} ${asin}: FAILED - ${result.error}`);
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 1200 + Math.random() * 1500));

    if ((i + 1) % 25 === 0) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`\n--- ${i + 1}/${asins.length} done (${ok}ok/${fail}fail) ${elapsed}s elapsed ---\n`);
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n=== Done in ${elapsed}s: ${ok} prices found, ${fail} failed ===\n`);

  // Save to file
  fs.writeFileSync('scrape_results.json', JSON.stringify(results, null, 2));

  // Build price lookup map
  const priceMap = {};
  results.forEach(r => { if (r.current_price) priceMap[r.asin] = r; });

  // Update competitor_detail in database with current prices
  const allPE = db.prepare("SELECT id, competitor_detail, fram_model FROM profit_estimation WHERE competitor_detail != ''").all();
  let updated = 0;

  for (const pe of allPE) {
    const parts = (pe.competitor_detail || '').split(/[|\n]/).map(p => p.trim()).filter(Boolean);
    let changed = false;
    const newParts = parts.map(p => {
      const m = p.match(/^(B0[A-Z0-9]+):([\d.]+)\/([\d.]+)\/([\d.]+)(?:\(([^)]*)\))?/);
      if (!m) return p;
      const asin = m[1];
      const sd = priceMap[asin];
      if (!sd || !sd.current_price) return p;
      changed = true;
      const oldPrice = parseFloat(m[2]);
      const oldVolume = parseFloat(m[3]) || 0;
      const priceDiff = sd.current_price - oldPrice;
      let note = ` [原:$${oldPrice}/月销${Math.round(oldVolume)}]`;
      if (Math.abs(priceDiff) >= 3) {
        note += priceDiff > 0 ? ' [↑涨$' + Math.abs(Math.round(priceDiff*100)/100) + ']' : ' [↓跌$' + Math.abs(Math.round(priceDiff*100)/100) + ']';
      }
      return `${asin}:$${sd.current_price}/${sd.monthly_sales || '?'}/${Math.round((sd.current_price)*(sd.monthly_sales||0)*100)/100}(${m[5]||''})${note}`;
    });
    if (changed) {
      db.prepare('UPDATE profit_estimation SET competitor_detail = ? WHERE id = ?').run(newParts.join(' | '), pe.id);
      updated++;
    }
  }

  console.log(`Updated ${updated} competitor records in database.`);
  db.close();
}

main().catch(console.error);
