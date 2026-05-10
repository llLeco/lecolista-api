// Scraper do Carrefour.com.br (mercado online de verdade — preços reais de
// supermercado, não eletrônicos como o Buscapé).
//
// Estrutura observada:
//   - URL de busca: https://mercado.carrefour.com.br/QUERY?_q=QUERY
//   - Links de produto: <a href="/produto/SLUG-NUMID">
//   - Preço: <span class="text-price-default ...">R$ X,XX</span>
//   - Preço original (riscado): <span class="line-through">R$ Y,YY</span>
//
// HTML é server-rendered (Next.js), então scraping simples funciona — sem JS.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
};

const TIMEOUT_MS = 12000;
const BASE = 'https://mercado.carrefour.com.br';

function urlFor(query) {
  const q = encodeURIComponent(String(query).trim());
  return `${BASE}/${q}?_q=${q}&map=ft`;
}

async function fetchHTML(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    if (text.length < 10000) throw new Error('html muito curto');
    return text;
  } finally {
    clearTimeout(t);
  }
}

function slugToName(slug) {
  return slug
    .split('-')
    .filter((w) => !/^\d+$/.test(w)) // remove tokens só-numéricos no fim
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function parsePriceBR(str) {
  // "R$ 5,54" / "R$ 1.234,56" → 5.54 / 1234.56
  const m = String(str).match(/([0-9.]+),([0-9]{2})/);
  if (!m) return null;
  const intPart = m[1].replace(/\./g, '');
  return parseFloat(intPart + '.' + m[2]);
}

// Extrai produtos do HTML do Carrefour.
// Estratégia: identifica cada link /produto/... e procura o próximo preço
// text-price-default dentro de uma janela razoável (mesmo card).
function parseProducts(html) {
  const products = [];
  const seen = new Set();

  // Regex pra link de produto
  const linkRe = /href="(\/produto\/([^"]+))"/g;
  const priceClassRe = /class="[^"]*text-price-default[^"]*"[^>]*>\s*R\$\s*([0-9.,]+)/g;

  // Coleta posições de preços
  const prices = [];
  let pm;
  while ((pm = priceClassRe.exec(html)) !== null) {
    const price = parsePriceBR('R$ ' + pm[1]);
    if (price) prices.push({ pos: pm.index, price });
  }

  // Coleta posições de imagens (src ou data-src próximas)
  const imgRe = /<img[^>]+(?:src|data-src)="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/g;
  const imgs = [];
  let im;
  while ((im = imgRe.exec(html)) !== null) {
    imgs.push({ pos: im.index, src: im[1] });
  }

  let lm;
  while ((lm = linkRe.exec(html)) !== null) {
    const href = lm[1];
    const slug = lm[2];
    if (seen.has(href)) continue;
    seen.add(href);

    // Acha o próximo preço depois do link (dentro de 2500 chars = mesmo card)
    const linkPos = lm.index;
    const priceCand = prices.find((p) => p.pos > linkPos && p.pos < linkPos + 2500);
    if (!priceCand) continue;

    // Acha imagem mais próxima (antes ou logo após o link, dentro de 1500 chars)
    const imgCand = imgs.find((i) => Math.abs(i.pos - linkPos) < 1500);

    products.push({
      name: slugToName(slug),
      price: priceCand.price,
      link: BASE + href,
      thumbnail: imgCand?.src || null,
      _slug: slug,
    });
  }
  return products;
}

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export async function searchPrice(query) {
  const url = urlFor(query);
  try {
    const html = await fetchHTML(url);
    const all = parseProducts(html);
    if (!all.length) return { found: false, source: 'carrefour', queryUrl: url, error: 'sem produtos' };

    // Filtra pelos que contêm alguma palavra-chave da query no nome (>2 chars)
    const tokens = norm(query).split(' ').filter((t) => t.length > 2);
    const matches = tokens.length
      ? all.filter((p) => tokens.some((t) => norm(p.name).includes(t)))
      : all;
    const pool = matches.length >= 2 ? matches : all;

    pool.sort((a, b) => a.price - b.price);
    const top5 = pool.slice(0, 5);
    const med = median(top5.map((p) => p.price));
    // Principal: preço mais próximo da mediana
    const principal = top5.reduce((best, p) =>
      Math.abs(p.price - med) < Math.abs(best.price - med) ? p : best, top5[0]);

    return {
      found: true,
      price: principal.price,
      currency: 'BRL',
      title: principal.name,
      link: principal.link,
      thumbnail: principal.thumbnail,
      source: 'carrefour',
      median: med,
      range: top5.length > 1 ? { min: top5[0].price, max: top5[top5.length - 1].price } : null,
      alternatives: top5.filter((p) => p !== principal).slice(0, 4).map((p) => ({
        name: p.name, price: p.price, link: p.link,
      })),
      queryUrl: url,
    };
  } catch (err) {
    return { found: false, source: 'carrefour', queryUrl: url, error: String(err.message || err) };
  }
}
