const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');

// 구글 이미지 검색(SerpApi 경유)으로 상품 사진 후보를 찾고, 가장 잘 맞는 사진을 내려받는다.
// 검색 결과의 사진 주소는 바깥 누구나 넣을 수 있는 값이라, 내려받을 때 내부망(AWS 메타데이터 등) 주소는 막는다.
const DEFAULT_BASE = 'https://serpapi.com';
const MAX_BYTES = 10 * 1024 * 1024;
const MIN_EDGE = 300;
// 블로그·SNS·커뮤니티 사진은 개인이 찍은 사진이 많고 다른 상품이 섞여 있어 쓰지 않는다.
const SKIP_HOSTS = /(^|\.)(blog\.naver\.com|cafe\.naver\.com|post\.naver\.com|tistory\.com|blogspot\.com|brunch\.co\.kr|pinterest\.[a-z.]+|youtube\.com|instagram\.com|facebook\.com|x\.com|twitter\.com|tiktok\.com|namu\.wiki|dcinside\.com|fmkorea\.com|theqoo\.net|reddit\.com)$/i;

const blocked = new net.BlockList();
for (const subnet of ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4']) {
  const [address, prefix] = subnet.split('/');
  blocked.addSubnet(address, Number(prefix), 'ipv4');
}
for (const subnet of ['::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8']) {
  const [address, prefix] = subnet.split('/');
  blocked.addSubnet(address, Number(prefix), 'ipv6');
}

// 테스트 서버만 가짜 사진 서버(127.0.0.1)를 쓸 수 있다. 운영에서는 이 설정을 무시한다.
const testAllowed = () => (process.env.NODE_ENV === 'production' ? [] : String(process.env.WEB_IMAGE_ALLOW_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean));

function isBlockedAddress(address, family) {
  if (testAllowed().includes(address)) return false;
  const version = family === 6 || family === 'IPv6' ? 'ipv6' : 'ipv4';
  if (version === 'ipv6' && /^::ffff:/i.test(address)) return isBlockedAddress(address.replace(/^::ffff:/i, ''), 4);
  return blocked.check(address, version);
}

const blockedError = () => Object.assign(new Error('내부 주소로는 사진을 받지 않습니다.'), { code: 'BLOCKED_ADDRESS' });

// 연결 직전에 실제로 붙을 주소를 확인한다(DNS가 내부 주소를 돌려주는 경우까지 막는다).
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some((a) => isBlockedAddress(a.address, a.family))) return callback(blockedError());
    if (options && options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

function download(rawUrl, redirects = 3) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return reject(new Error('사진 주소가 올바르지 않습니다.'));
    }
    if (!['http:', 'https:'].includes(url.protocol)) return reject(new Error('http(s) 사진만 받습니다.'));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isBlockedAddress(host, net.isIP(host))) return reject(blockedError());
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(
      url,
      { lookup: safeLookup, timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MAYDIN-product-image/1.0)', Accept: 'image/*' } },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (!redirects) return reject(new Error('사진 주소가 너무 여러 번 옮겨졌습니다.'));
          return resolve(download(new URL(res.headers.location, url).href, redirects - 1));
        }
        if (res.statusCode !== 200 || !/^image\//i.test(String(res.headers['content-type'] || ''))) {
          res.resume();
          return reject(new Error(`사진을 받지 못했습니다(${res.statusCode}).`));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) req.destroy(new Error('사진이 너무 큽니다.'));
          else chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('사진 서버 응답이 없습니다.')));
    req.on('error', reject);
  });
}

const searchKey = () => String(process.env.SERPAPI_KEY || '').trim();
const enabled = () => Boolean(searchKey());

async function searchImages(query) {
  const url = new URL('/search.json', process.env.SERPAPI_BASE || DEFAULT_BASE);
  url.search = new URLSearchParams({ engine: 'google_images', q: query, gl: 'kr', hl: 'ko', api_key: searchKey() }).toString();
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`이미지 검색 실패: ${data.error || res.status}`);
  return (data.images_results || []).slice(0, 50).map((r) => ({
    title: String(r.title || ''),
    page: String(r.link || ''),
    source: String(r.source || ''),
    original: String(r.original || ''),
    width: Number(r.original_width) || 0,
    height: Number(r.original_height) || 0
  }));
}

const normalize = (value) => String(value || '').toLowerCase().replace(/\(주\)|주식회사|[\s·,()[\]+&/_|:'"!-]/g, '');
const tokens = (value) => String(value || '').toLowerCase().split(/[\s·,()[\]+&/_|:-]+/).filter((t) => t.length >= 2);

function hostOf(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
}

// 사진 제목에 제품명 낱말이 대부분 들어 있어야 후보가 된다. 제품명 전체·브랜드·업체명이 맞을수록, 사진이 크고 정사각형에 가까울수록 위로.
function scoreCandidate(candidate, want) {
  if (!candidate.original || SKIP_HOSTS.test(hostOf(candidate.page)) || SKIP_HOSTS.test(hostOf(candidate.original))) return -1;
  const title = normalize(candidate.title);
  const words = tokens(want.name);
  const hits = words.filter((word) => title.includes(normalize(word))).length;
  const ratio = words.length ? hits / words.length : 0;
  if (ratio < 0.6) return -1;
  let score = ratio * 10;
  if (title.includes(normalize(want.name))) score += 5;
  if (want.brand) score += title.includes(normalize(want.brand)) ? 4 : -2;
  if (want.company && (title.includes(normalize(want.company)) || normalize(candidate.source).includes(normalize(want.company)))) score += 2;
  const { width: w, height: h } = candidate;
  if (w && h) {
    if (Math.min(w, h) < MIN_EDGE || w / h < 0.5 || w / h > 2) return -1;
    if (Math.min(w, h) >= 600) score += 2;
    if (w / h > 0.8 && w / h < 1.25) score += 1;
  }
  return score;
}

function rankCandidates(candidates, want) {
  return candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, want) }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => ({ ...r.candidate, score: Math.round(r.score * 10) / 10 }));
}

// 가장 잘 맞는 사진부터 차례로 받아 본다. skipUrls: 약국이 "다른 상품"이라고 지운 사진 주소.
async function findProductPhoto(want, { skipUrls = new Set(), tries = 4 } = {}) {
  const query = want.brand && !normalize(want.name).includes(normalize(want.brand)) ? `${want.brand} ${want.name}` : want.name;
  if (String(query || '').trim().length < 2) return null;
  const ranked = rankCandidates(await searchImages(query), want).filter((c) => !skipUrls.has(c.original) && !skipUrls.has(c.page));
  for (const candidate of ranked.slice(0, tries)) {
    try {
      return { buffer: await download(candidate.original), candidate };
    } catch {
      // 받을 수 없는 사진은 건너뛰고 다음 후보를 본다.
    }
  }
  return null;
}

module.exports = { download, enabled, findProductPhoto, isBlockedAddress, rankCandidates, scoreCandidate };
