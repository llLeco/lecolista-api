// Scraper do Mercado Livre.
// Estratégia:
//   1. Busca a página de resultados de busca (lista.mercadolivre.com.br/QUERY)
//   2. Tenta JSON-LD (structured data) — formato estável que ML mantém pra SEO
//   3. Fallback: parsing de classes andes-money-amount (do design system deles)
//   4. Headers de browser real pra evitar 403 anti-bot

import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
};

const TIMEOUT_MS = 12000;

function urlFor(query) {
  const slug = String(query).trim().replace(/\s+/g, '-').toLowerCase();
  return `https://lista.mercadolivre.com.br/${encodeURIComponent(slug)}`;
}

async function fetchHTML(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    if (text.length < 1000) throw new Error('html muito curto (anti-bot?)');
    return text;
  } finally {
    clearTimeout(t);
  }
}

// Tenta extrair via JSON-LD structured data (formato oficial schema.org)
function fromJsonLd(html) {
  const $ = cheerio.load(html);
  const scripts = $('script[type="application/ld+json"]').toArray();

  for (const s of scripts) {
    const raw = $(s).contents().text();
    if (!raw) continue;
    let data;
    try { data = JSON.parse(raw); } catch { continue; }
    const items = Array.isArray(data) ? data : [data];
    for (const d of items) {
      // Caso 1: ItemList com produtos
      if (d['@type'] === 'ItemList' && Array.isArray(d.itemListElement)) {
        for (const el of d.itemListElement) {
          const item = el.item || el;
          const offers = item?.offers;
          if (offers && (offers.price || offers.lowPrice)) {
            return {
              found: true,
              price: parseFloat(offers.price || offers.lowPrice),
              currency: offers.priceCurrency || 'BRL',
              title: item.name || item.alternateName || null,
              link: item.url || item['@id'] || null,
              thumbnail: item.image || null,
              source: 'ml',
            };
          }
        }
      }
      // Caso 2: Product direto
      if (d['@type'] === 'Product' && d.offers) {
        const o = Array.isArray(d.offers) ? d.offers[0] : d.offers;
        if (o.price || o.lowPrice) {
          return {
            found: true,
            price: parseFloat(o.price || o.lowPrice),
            currency: o.priceCurrency || 'BRL',
            title: d.name || null,
            link: d.url || o.url || null,
            thumbnail: Array.isArray(d.image) ? d.image[0] : d.image,
            source: 'ml',
          };
        }
      }
    }
  }
  return null;
}

// Fallback: classes do design system Andes do ML
function fromDom(html) {
  const $ = cheerio.load(html);

  // Item de busca tem várias formas; tentamos os layouts mais comuns
  const candidateSelectors = [
    '.ui-search-layout__item',
    '.ui-search-results .ui-search-result',
    'li.ui-search-layout__item',
    'div.poly-card',
  ];

  for (const sel of candidateSelectors) {
    const card = $(sel).first();
    if (!card.length) continue;

    // Preço: andes-money-amount__fraction + andes-money-amount__cents
    const fracEl = card.find('.andes-money-amount__fraction').first();
    const fraction = fracEl.text().trim();
    if (!fraction) continue;

    const centsEl = card.find('.andes-money-amount__cents').first();
    const cents = centsEl.text().trim();

    // Constroi número: "1.234" + "56" → 1234.56
    const intPart = fraction.replace(/\./g, '');
    const decPart = cents.padEnd(2, '0').slice(0, 2);
    const price = parseFloat(`${intPart}.${decPart || '00'}`);
    if (isNaN(price) || price <= 0) continue;

    const title = card.find('a[title], h2 a, .poly-component__title a, .ui-search-item__title').first().text().trim()
      || card.find('a[title]').first().attr('title')
      || null;
    const link = card.find('a').first().attr('href') || null;
    const thumbnail = card.find('img').first().attr('data-src') || card.find('img').first().attr('src') || null;

    return { found: true, price, currency: 'BRL', title, link, thumbnail, source: 'ml' };
  }
  return null;
}

export async function searchPrice(query) {
  const url = urlFor(query);
  try {
    const html = await fetchHTML(url);
    const r = fromJsonLd(html) || fromDom(html);
    if (r) return { ...r, queryUrl: url };
    return { found: false, source: 'ml', queryUrl: url, error: 'sem resultados parseáveis' };
  } catch (err) {
    return { found: false, source: 'ml', queryUrl: url, error: String(err.message || err) };
  }
}
