/**
 * pay-core — lógica pura do Pay Module, sem I/O.
 * Roda em Workers/Pages Functions E em Node 18+ (node --test), sem dependências.
 *
 * Tudo que envolve decisão de segurança mora aqui e é coberto por testes:
 * normalização de email, comparação constant-time, assinatura HMAC-SHA256,
 * rate-limit de janela fixa e dedupe anti-replay.
 */
'use strict';

/* ------------------------------------------------------------------ *
 * Constantes                                                          *
 * ------------------------------------------------------------------ */

/** Janela do rate limit (ms). Spec: 10 req/min por IP. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;

/** TTLs de KV em segundos. */
const RATE_KV_TTL_S = 120;          // cobre a janela inteira
const DEDUPE_KV_TTL_S = 90 * 86400; // janela anti-replay ~90 dias
const LICENSE_KV_TTL_S = 2 * 365 * 86400;

/** Eventos Asaas que confirmam dinheiro na conta. */
const PAID_EVENTS = ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED_IN_CASH'];

/**
 * Eventos Asaas que REVERSAM dinheiro recebido (doc: docs.asaas.com/docs/webhooks-events).
 * - PAYMENT_REFUNDED: estorno concluído (dinheiro saiu de volta pro pagador).
 * - PAYMENT_RECEIVED_IN_CASH_UNDONE: desfaz o "recebido em dinheiro" (equivalente).
 * PAYMENT_REFUND_IN_PROGRESS NÃO entra (liquidação agendada, ainda não efetivada);
 * PAYMENT_PARTIALLY_REFUNDED NÃO entra (estorno parcial não cancela a licença);
 * PAYMENT_REFUND_DENIED NÃO entra (estorno negado, dinheiro permanece).
 */
const REFUND_EVENTS = ['PAYMENT_REFUNDED', 'PAYMENT_RECEIVED_IN_CASH_UNDONE'];

/** Planos válidos por produto (espelha PAY_MODULE_SPEC.md). */
const PRODUCTS = {
  propostly:   { name: 'Propostly',   plans: { pro: { amount: 29, cycle: 'ONE_TIME',  days: 3650 } } },
  menupulse:   { name: 'MenuPulse',   plans: { pro: { amount: 19, cycle: 'MONTHLY',   days: 40 }   } },
  linkforge:   { name: 'LinkForge',   plans: { pro: { amount: 9,  cycle: 'MONTHLY',   days: 40 }   } },
  tably:       { name: 'Tably',       plans: { pro: { amount: 14, cycle: 'MONTHLY',   days: 40 }   } },
  debtfree:    { name: 'DebtFree',    plans: { pro: { amount: 15, cycle: 'ONE_TIME',  days: 3650 } } },
  resumeforge: { name: 'ResumeForge', plans: { pro: { amount: 24, cycle: 'ONE_TIME',  days: 3650 } } },
  contractkit: { name: 'ContractKit', plans: { pro: { amount: 49, cycle: 'ONE_TIME',  days: 3650 } } },
  pricecraft:  { name: 'PriceCraft',  plans: { pro: { amount: 39, cycle: 'ONE_TIME',  days: 3650 } } },
  rafflemint:  { name: 'RaffleMint',  plans: { pro: { amount: 12, cycle: 'ONE_TIME',  days: 3650 } } },
  sheetbound:  { name: 'SheetBound',  plans: { pro: { amount: 19, cycle: 'ONE_TIME',  days: 3650 } } },
};

/* ------------------------------------------------------------------ *
 * Email                                                               *
 * ------------------------------------------------------------------ */

/**
 * Normaliza + valida email. Retorna string pronta pra virar chave de
 * licença, ou null se inválido.
 *
 * Regras: trim; espaços internos removidos; domínio lowercased
 * (DNS é case-insensitive); local-part preservado (RFC 5321: case é
 * significativo). Limites RFC 5321/5322: local <=64, total <=254.
 */
function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 254) return null;

  const parts = s.split('@');
  if (parts.length !== 2) return null;
  let [rawLocal, rawDomain] = parts;
  if (!rawLocal || !rawDomain) return null;

  // Espaço no DOMÍNIO é quase sempre typo que apontaria pra outra mailbox:
  // rejeita em vez de "consertar" removendo caracteres.
  if (/\s/.test(rawDomain)) return null;
  // Espaço no LOCAL é artefato comum de colagem ("john doe@x.com"): remove.
  const local = rawLocal.replace(/\s+/g, '');
  rawLocal = local;

  // Local part: atext do RFC 5322 sem aspas/observação — superfície segura
  // pra logs e chaves. Nada de aspas, espaços ou caracteres de controle.
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/.test(rawLocal)) return null;
  // Pontuação não pode abrir/fechar o local nem aparecer dobrada
  if (/^[.!#$%&'*+/=?^_`{|}~-]/.test(rawLocal)) return null;
  if (/[.!#$%&'*+/=?^_`{|}~-]$/.test(rawLocal)) return null;
  if (/\.\./.test(rawLocal)) return null;

  // Domínio: labels alfanuméricos com hífen interno, TLD alfabético >=2
  const domain = rawDomain.toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return null;

  return `${rawLocal}@${domain}`;
}

/* ------------------------------------------------------------------ *
 * Constant-time compare                                               *
 * ------------------------------------------------------------------ */

/**
 * Compara dois segredos sem vazar conteúdo/comprimento por timing.
 * Percorre sempre max(len) bytes acumulando XOR; diferença de
 * comprimento entra no acumulador desde o início. Loop não tem early
 * exit — mesmo tempo pra qualquer par de entradas.
 */
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = typeof a === 'string' ? enc.encode(a) : new Uint8Array(a || []);
  const bb = typeof b === 'string' ? enc.encode(b) : new Uint8Array(b || []);
  const len = Math.max(ab.length, bb.length);
  let diff = (ab.length ^ bb.length) & 0xff;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] || 0) ^ (bb[i] || 0);
  }
  return diff === 0;
}

/* ------------------------------------------------------------------ *
 * HMAC-SHA256 license signature (WebCrypto / Node webcrypto)          *
 * ------------------------------------------------------------------ */

function subtle() {
  // Workers e Node >=18 expõem globalThis.crypto.subtle
  const c = typeof crypto !== 'undefined' ? crypto : globalThis.crypto;
  if (!c || !c.subtle) throw new Error('WebCrypto indisponível');
  return c.subtle;
}

function bytesToHex(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex) {
  const clean = String(hex).trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Payload canônico da licença. SEMPRE a mesma ordem de chaves e
 * separadores no servidor (assinatura) e no client (verificação).
 * Campos: email normalizado, product, plan, exp (YYYY-MM-DD UTC).
 */
function canonicalLicensePayload({ email, product, plan, exp }) {
  return JSON.stringify({ email, product, plan, exp });
}

async function hmacSignHex(message, secret) {
  const key = await subtle().importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await subtle().sign('HMAC', key, new TextEncoder().encode(message));
  return bytesToHex(sig);
}

async function hmacVerifyHex(message, secret, sigHex) {
  const expected = hexToBytes(sigHex);
  if (!expected) return false;
  const key = await subtle().importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  try {
    return await subtle().verify(
      'HMAC',
      key,
      expected,
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}

/**
 * Assina uma licença. SECRET vem de env var (nunca hardcoded).
 * Retorna { payload, payloadB64url, sig, licenseKey } onde licenseKey
 * é a string "payload.sig" que o app guarda.
 */
async function signLicense({ email, product, plan, exp }, secret) {
  const payload = canonicalLicensePayload({ email, product, plan, exp });
  const sig = await hmacSignHex(payload, secret);
  const payloadB64url = b64urlEncode(new TextEncoder().encode(payload));
  return { payload, payloadB64url, sig, licenseString: `${payloadB64url}.${sig}` };
}

/** Verifica licença no formato "payloadB64url.sig" (usado nos testes e no boot do app). */
async function verifyLicenseString(licenseString, secret) {
  const dot = String(licenseString || '').lastIndexOf('.');
  if (dot <= 0) return { valid: false, reason: 'format' };
  const payloadB64url = licenseString.slice(0, dot);
  const sig = licenseString.slice(dot + 1);
  let payload;
  try {
    payload = new TextDecoder().decode(b64urlDecode(payloadB64url));
  } catch {
    return { valid: false, reason: 'payload' };
  }
  const ok = await hmacVerifyHex(payload, secret, sig);
  if (!ok) return { valid: false, reason: 'signature' };
  let data;
  try {
    data = JSON.parse(payload);
  } catch {
    return { valid: false, reason: 'json' };
  }
  if (data.exp && /^\d{4}-\d{2}-\d{2}$/.test(data.exp)) {
    const today = new Date().toISOString().slice(0, 10);
    if (today > data.exp) return { valid: false, reason: 'expired', data };
  }
  return { valid: true, data };
}

function b64urlEncode(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // eslint-disable-next-line no-restricted-globals
  const b64 = typeof btoa !== 'undefined'
    ? btoa(bin)
    : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  const bin = typeof atob !== 'undefined'
    ? atob(t)
    : Buffer.from(t, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ------------------------------------------------------------------ *
 * Rate limit — janela fixa por IP (KV-backed)                         *
 * ------------------------------------------------------------------ */

function rateKeyFor(ip) {
  // IP nunca vai pro log; só vira parte da chave opaca no KV.
  return `rl:${ip}`;
}

/**
 * Avalia e consome 1 slot do rate limit.
 * Acessores KV são RAW: get(key) -> string|null, put(key, STRING, ttl).
 * A serialização fica aqui dentro pra nunca depender da convenção do caller.
 * @param {{get:Function, put:Function}} kv
 * @param {number} now ms epoch (injetável pros testes)
 * @returns {{ allowed: boolean, remaining: number, resetInMs: number }}
 */
async function checkRateLimit(ip, kv, now = Date.now()) {
  const key = rateKeyFor(ip);
  let entry = null;
  try {
    const raw = await kv.get(key);
    entry = raw ? JSON.parse(raw) : null;
  } catch {
    entry = null; // KV down ou corrompido: fail-open (disponibilidade > limite exato)
  }

  let windowStart = now;
  let count = 0;
  if (entry && typeof entry === 'object' && Number.isFinite(entry.w)) {
    if (now - entry.w < RATE_WINDOW_MS) {
      windowStart = entry.w;
      count = Math.max(0, entry.c | 0);
    }
    // fora da janela -> recomeça (corrige o bug da versão anterior)
  }

  count += 1;
  const allowed = count <= RATE_MAX;
  try {
    await kv.put(key, JSON.stringify({ w: windowStart, c: count }), RATE_KV_TTL_S);
  } catch {
    /* fail-open */
  }

  return {
    allowed,
    remaining: Math.max(0, RATE_MAX - count),
    resetInMs: Math.max(0, windowStart + RATE_WINDOW_MS - now),
  };
}

/* ------------------------------------------------------------------ *
 * Dedupe anti-replay                                                  *
 * ------------------------------------------------------------------ */

/**
 * Marca evento como processado. Retorna false se já tinha sido marcado.
 * PUT condicional com checagem prévia; em corrida extrema dois requests
 * podem passar juntos, mas ambos geram a MESMA licença determinística.
 */
async function dedupeFirstWin(eventId, kv) {
  const key = `dedupe:${eventId}`;
  try {
    const seen = await kv.get(key);
    if (seen) return false;
  } catch {
    /* segue pra marcar */
  }
  try {
    await kv.put(key, JSON.stringify({ t: Date.now() }), DEDUPE_KV_TTL_S);
  } catch {
    /* se falhar, pior caso: processa 2x idempotente */
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Licença                                                             *
 * ------------------------------------------------------------------ */

/** exp YYYY-MM-DD (UTC) = hoje + days. */
function expiryDate(days, now = new Date()) {
  const d = new Date(now.getTime() + days * 86400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * Validade COM acúmulo pra assinaturas: cada pagamento confirmado estende
 * a licença a partir da validade anterior AINDA VÁLIDA (dias não usados
 * não se perdem). Se a licença anterior já venceu (ou não existe), conta
 * de hoje. Datas malformadas são ignoradas com segurança.
 */
function stackedExpiry(prevExpIso, days, now = new Date()) {
  let base = now;
  if (typeof prevExpIso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(prevExpIso)) {
    const d = new Date(`${prevExpIso}T12:00:00Z`); // meio-dia evita borda de fuso
    if (!Number.isNaN(d.getTime()) && d.getTime() > now.getTime()) base = d;
  }
  return expiryDate(days, base);
}

/**
 * Chave de acesso ao índice de licenças por email ("minha licença").
 * O email É a prova de posse aqui: quem pagou recebe a chave junto com a
 * licença; sem ela, /api/license-latest só responde found:false uniforme.
 */
function licenseIndexKey(email) {
  return `licidx:${String(email || '').toLowerCase()}`;
}

/**
 * Valida a key do endpoint /api/license-latest.
 * É um email normalizado — nada mais. Retorna o email ou null.
 * (Nunca aceita payment id: o par payment+email fica no /api/license.)
 */
function checkKey(key) {
  return normalizeEmail(typeof key === 'string' ? key.trim() : '');
}

/**
 * Lê o ponteiro "licença mais recente deste email" do KV.
 * Retorna { paymentId, product, plan, exp } | null.
 */
async function readLicenseIndex(kv, email) {
  try {
    const raw = await kv.get(licenseIndexKey(email));
    const obj = raw ? JSON.parse(raw) : null;
    if (obj && typeof obj === 'object' && obj.paymentId) return obj;
  } catch { /* corrompido/KV down -> trata como ausente */ }
  return null;
}

/**
 * Publica o ponteiro após emitir uma licença (chamar SÓ depois de gravar
 * lic:<paymentId> com sucesso — best-effort, falha não derruba o webhook).
 * TTL acompanha LICENSE_KV_TTL_S.
 */
async function indexLicense(kv, email, pointer) {
  try {
    await kv.put(licenseIndexKey(email), JSON.stringify(pointer), LICENSE_KV_TTL_S);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Reembolso / revogação de licença                                    *
 * ------------------------------------------------------------------ */

/**
 * Revoga a licença emitida por um pagamento estornado (PAYMENT_REFUNDED).
 *
 * Estratégia: reescrever o MESMO registro lic:<paymentId> com exp retroativo
 * (= issuedAt, a data em que a licença nasceu) e uma nova assinatura HMAC.
 * A assinatura continua VÁLIDA — o client verifica HMAC e depois compara
 * exp >= hoje. Com exp no passado, verifyLicenseString responde
 * { valid: false, reason: 'expired' } e o app cai pro modo free.
 *
 * Por quê assim:
 * - /api/license e /api/license-latest continuam devolvendo found:true com
 *   licença assinada (mesmo contrato; nenhum client quebra);
 * - dedupe por cobrança permanece correto (1 processamento por evento);
 * - revogação é IDEMPOTENTE: refund repetido reescreve o mesmo exp retroativo.
 *
 * Retorna { record, revoked: true, wasAlreadyRevoked } | null se não há
 * licença pra esse pagamento (ex.: webhook REFUND chegou antes do PAID,
 * corrida rara — nesse caso o PAID posterior emite normalmente).
 */
async function revokeLicenseByPayment(paymentId, secret, kv, now = new Date()) {
  let raw = null;
  try {
    raw = await kv.get(`lic:${paymentId}`);
  } catch {
    return null;
  }
  if (!raw) return null;

  let record;
  try {
    record = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!record || !record.email || !record.product || !record.plan) return null;

  const revokedAt = typeof record.revokedAt === 'string' ? record.revokedAt : null;
  // Data-alvo do exp retroativo: issuedAt da emissão original (não muda em re-refund).
  let targetExp = null;
  if (typeof record.issuedAt === 'string') {
    const d = new Date(record.issuedAt);
    if (!Number.isNaN(d.getTime())) {
      targetExp = d.toISOString().slice(0, 10);
    }
  }
  // Fallback defensivo: sem issuedAt utilizável, usa hoje mesmo.
  if (!targetExp) targetExp = now.toISOString().slice(0, 10);

  const already = Boolean(revokedAt);
  const license = { email: record.email, product: record.product, plan: record.plan, exp: targetExp };
  const signed = await signLicense(license, secret);

  const updated = {
    ...record,
    ...license,
    sig: signed.sig,
    revokedAt: revokedAt || now.toISOString(),
  };
  try {
    await kv.put(`lic:${paymentId}`, JSON.stringify(updated), LICENSE_KV_TTL_S);
  } catch {
    return null;
  }
  return { record: updated, revoked: true, wasAlreadyRevoked: already };
}

export {
  RATE_WINDOW_MS,
  RATE_MAX,
  RATE_KV_TTL_S,
  DEDUPE_KV_TTL_S,
  LICENSE_KV_TTL_S,
  PAID_EVENTS,
  REFUND_EVENTS,
  PRODUCTS,
  normalizeEmail,
  safeEqual,
  canonicalLicensePayload,
  hmacSignHex,
  hmacVerifyHex,
  signLicense,
  verifyLicenseString,
  b64urlEncode,
  b64urlDecode,
  bytesToHex,
  hexToBytes,
  checkRateLimit,
  dedupeFirstWin,
  expiryDate,
  stackedExpiry,
  licenseIndexKey,
  checkKey,
  readLicenseIndex,
  indexLicense,
  revokeLicenseByPayment,
  rateKeyFor,
};
