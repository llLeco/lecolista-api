// Scraper do Buscapé. Estratégia: pega __NEXT_DATA__ (Next.js dehydrated state)
// que vem no HTML server-side e tem preços estruturados.
//
// Por que Buscapé e não ML?
// - ML detecta bot e redireciona pra /gz/account-verification
// - api.mercadolibre.com retorna 403 forbidden sem auth OAuth
// - Buscapé é agregador, retorna HTML completo com dados embutidos
// - Buscapé já agrega preços de vários sellers (incluindo ML), então é mais
//   representativo do "preço médio de mercado" do que um único anúncio

import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
};

const TIMEOUT_MS = 12000;

function urlFor(query) {
  const q = encodeURIComponent(String(query).trim());
  return `https://www.buscape.com.br/search?q=${q}`;
}

async function fetchHTML(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    if (text.length < 5000) throw new Error('html muito curto (anti-bot ou sem resultados)');
    return text;
  } finally {
    clearTimeout(t);
  }
}

// Walk recursivo procurando objetos com {name, price} parecidos com produtos
function findProducts(obj, acc = [], depth = 0) {
  if (depth > 12 || acc.length >= 30) return acc;
  if (obj == null) return acc;
  if (Array.isArray(obj)) {
    for (const x of obj) findProducts(x, acc, depth + 1);
    return acc;
  }
  if (typeof obj !== 'object') return acc;

  const hasName = typeof obj.name === 'string' && obj.name.length > 2;
  const hasPrice = typeof obj.price === 'number' && obj.price > 0;
  const hasUrl = typeof obj.url === 'string' || typeof obj.productUrl === 'string';
  if (hasName && hasPrice) {
    acc.push({
      name: obj.name,
      price: obj.price,
      url: obj.url || obj.productUrl || null,
      image: obj.image || obj.thumbnail || obj.photoUrl || null,
      sellerName: obj.sellerName || obj.store?.name || null,
    });
    // não desce mais nesse galho — evita pegar duplicatas
    return acc;
  }
  for (const k in obj) findProducts(obj[k], acc, depth + 1);
  return acc;
}

// Normaliza pra comparação: lowercase, sem acentos, só letras/números/espaços
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Filtra produtos irrelevantes (não contém termos da query no nome).
// Ex.: query "arroz" → exclui "panela de arroz elétrica" (porque também não bate "arroz" em palavra inteira? bate. Hmm.)
// Estratégia: o nome do produto DEVE conter pelo menos uma palavra-chave da query (de >2 chars).
function relevant(queryTokens, productName) {
  if (!queryTokens.length) return true;
  const nameN = ' ' + norm(productName) + ' ';
  // Pelo menos uma palavra-chave da query precisa estar como palavra inteira no nome
  return queryTokens.some((t) => t.length > 2 && nameN.includes(' ' + t + ' '));
}

// Exclui categorias claramente fora de "supermercado" baseado em termos no nome.
// Lista enxuta de palavras de outros segmentos comuns no Buscapé (eletro, brinquedos).
const EXCLUDE_HINTS = [
  'panela', 'fogao', 'fogão', 'forno', 'liquidificador', 'cafeteira', 'micro-ondas', 'microondas',
  'geladeira', 'maquina', 'máquina', 'aspirador', 'ventilador', 'ar condicionado',
  'controle', 'console', 'video game', 'videogame', 'jogo ', 'brinquedo',
  'kit ferramenta', 'parafusadeira', 'furadeira',
  'lampada', 'lâmpada', 'led ', 'forma de bolo',
  'capa ', 'capinha', 'celular', 'smartphone', 'fone ',
  'suplemento', 'whey', 'creatina', 'colageno', 'colágeno',
];

function looksLikeWrongCategory(name) {
  const n = ' ' + norm(name) + ' ';
  return EXCLUDE_HINTS.some((h) => n.includes(' ' + norm(h) + ' '));
}

// Mediana de array de números (mais robusto que média contra outliers)
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function fromNextData(html, originalQuery) {
  const $ = cheerio.load(html);
  const raw = $('#__NEXT_DATA__').contents().text();
  if (!raw) return null;
  let data;
  try { data = JSON.parse(raw); } catch { return null; }

  const products = findProducts(data).filter((p) => p.price > 0);
  if (!products.length) return null;

  const queryTokens = norm(originalQuery).split(' ').filter(Boolean);

  // Filtra por relevância (nome bate com a query) e categoria errada
  const filtered = products
    .filter((p) => relevant(queryTokens, p.name))
    .filter((p) => !looksLikeWrongCategory(p.name));

  const pool = filtered.length >= 2 ? filtered : products; // se filtrou demais, volta pro raw
  pool.sort((a, b) => a.price - b.price);

  // Pega top 5 e tira a mediana — robusto a outliers (ex.: 0.99 "a partir de")
  const top5 = pool.slice(0, 5);
  const medPrice = median(top5.map((p) => p.price));

  // Produto principal: o que tem preço mais próximo da mediana (representativo)
  const principal = top5.reduce((best, p) =>
    Math.abs(p.price - medPrice) < Math.abs(best.price - medPrice) ? p : best, top5[0]);

  const linkBase = 'https://www.buscape.com.br';
  const fixLink = (u) => u ? (u.startsWith('http') ? u : linkBase + u) : null;

  return {
    found: true,
    price: principal.price,
    currency: 'BRL',
    title: principal.name,
    link: fixLink(principal.url),
    thumbnail: principal.image || null,
    source: 'buscape',
    median: medPrice,
    range: top5.length > 1 ? { min: top5[0].price, max: top5[top5.length - 1].price } : null,
    alternatives: top5.filter((p) => p !== principal).slice(0, 4).map((p) => ({
      name: p.name, price: p.price, link: fixLink(p.url),
    })),
  };
}

export async function searchPrice(query) {
  const url = urlFor(query);
  try {
    const html = await fetchHTML(url);
    const r = fromNextData(html, query);
    if (r) return { ...r, queryUrl: url };
    return { found: false, source: 'buscape', queryUrl: url, error: 'sem resultados parseáveis' };
  } catch (err) {
    return { found: false, source: 'buscape', queryUrl: url, error: String(err.message || err) };
  }
}
