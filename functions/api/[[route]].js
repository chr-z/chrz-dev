/**
 * Pay Module API — Cloudflare Pages Functions (single catch-all router).
 *
 * Rotas:
 *   POST /api/create-payment   { product, plan?, email }        -> { paymentId, checkoutUrl }
 *   POST /api/webhook/asaas    (header asaas-access-token)      -> valida, dedupe, gera licença assinada
 *   GET  /api/license          ?payment=<id>&email=<email>      -> { found, license }
 *   GET  /api/health                                            -> { ok: true }
 *
 * Bindings esperados no projeto Pages (dashboard -> Settings -> Variables):
 *   PAY_KV              KV namespace (rate limit + dedupe + licenças)
 *   ASAAS_API_TOKEN     chave de API Asaas (sandbox ou produção) — NUNCA no repo
 *   ASAAS_BASE_URL      opcional; padrão https://api-sandbox.asaas.com
 *   WEBHOOK_SECRET      token configurado no webhook do Asaas (header asaas-access-token)
 *   LICENSE_SECRET      segredo HMAC das licenças (rotacionável); cai para WEBHOOK_SECRET se ausente
 *   APP_RETURN_URL      opcional; URL de retorno pós-pagamento (callback.successUrl do checkout)
 *
 * Segurança (PAY_MODULE_SPEC.md):
 *   - Secrets só em env vars; nada hardcoded.
 *   - Webhook autenticado em constant-time (src/core.js safeEqual).
 *   - Anti-replay: dedupe por payment id em KV.
 *   - Rate limit 10/min por IP em KV.
 *   - PII mínimo: só email. Logs mascarados (jamais email inteiro/token).
 */
'use strict';

import {
  PAID_EVENTS,
  PRODUCTS,
  normalizeEmail,
  safeEqual,
  checkRateLimit,
  dedupeFirstWin,
  expiryDate,
  signLicense,
} from '../../src/core.js';

/* ------------------------------------------------------------------ *
 * Helpers HTTP                                                        *
 * ------------------------------------------------------------------ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extraHeaders },
  });
}

function preflight() {
  return new Response(null, { status: 204, headers: CORS });
}

/** Mascara email pra logs: ma***@domínio. Nunca loga o valor cheio. */
function maskEmail(email) {
  const at = String(email || '').indexOf('@');
  if (at <= 0) return '(inválido)';
  return `${String(email).slice(0, Math.min(2, at))}***${String(email).slice(at)}`;
}

function todayPlus(days) {
  return new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
}

/** Acesso RAW ao KV (strings). Serialização é responsabilidade de quem grava. */
function rawKv(env) {
  return {
    get: (k) => env.PAY_KV.get(k),
    put: (k, v, ttlS) => env.PAY_KV.put(k, v, { expirationTtl: ttlS }),
  };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function asaasBase(env) {
  return (env.ASAAS_BASE_URL || 'https://api-sandbox.asaas.com').replace(/\/+$/, '');
}

function asaasHeaders(token) {
  return {
    'Content-Type': 'application/json',
    access_token: token,
    'User-Agent': 'chrz-pay-module/1.0',
  };
}

/* ------------------------------------------------------------------ *
 * POST /api/create-payment                                            *
 * ------------------------------------------------------------------ */

export async function createPayment(request, env) {
  if (!env.PAY_KV || !env.ASAAS_API_TOKEN) {
    return json({ error: 'server_misconfigured' }, 500);
  }

  // 1) Rate limit por IP ANTES de qualquer processamento.
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const rl = await checkRateLimit(ip, rawKv(env));
  if (!rl.allowed) {
    return json(
      { error: 'rate_limited', retryAfterSec: Math.ceil(rl.resetInMs / 1000) },
      429,
      { 'Retry-After': String(Math.ceil(rl.resetInMs / 1000)) },
    );
  }

  // 2) Validação de entrada.
  const body = await readJson(request);
  if (!body || typeof body !== 'object') {
    return json({ error: 'invalid_json' }, 400);
  }

  const productKey = String(body.product || '').toLowerCase();
  const planKey = String(body.plan || 'pro').toLowerCase();
  const product = PRODUCTS[productKey];
  const plan = product && product.plans[planKey];
  if (!product || !plan) {
    return json({ error: 'unknown_product' }, 400);
  }

  const email = normalizeEmail(body.email);
  if (!email) {
    return json({ error: 'invalid_email' }, 400);
  }

  // 3) Customer no Asaas — reutiliza por email (cache 30d no KV).
  //    PII enviado ao gateway: APENAS o email (nome genérico do produto).
  let customerId = null;
  try {
    const cached = await env.PAY_KV.get(`cust:${email}`);
    customerId = cached ? JSON.parse(cached) : null;
  } catch { customerId = null; }

  if (!customerId) {
    let resp;
    try {
      resp = await fetch(`${asaasBase(env)}/v3/customers`, {
        method: 'POST',
        headers: asaasHeaders(env.ASAAS_API_TOKEN),
        body: JSON.stringify({
          name: `Assinante ${product.name}`,
          email,
          externalReference: productKey,
        }),
      });
    } catch {
      return json({ error: 'gateway_unreachable' }, 502);
    }
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || !data.id) {
      console.error('[create-payment] customers erro:', resp.status, (data && data.errors && data.errors[0] && data.errors[0].code) || '?');
      return json({ error: 'gateway_error' }, 502);
    }
    customerId = data.id;
    try {
      await env.PAY_KV.put(`cust:${email}`, JSON.stringify(customerId), { expirationTtl: 30 * 86400 });
    } catch { /* best-effort */ }
  }

  // 4) Cobrança UNDEFINED (pagador escolhe PIX/cartão/boleto no checkout hospedado).
  const externalReference = JSON.stringify({ p: productKey, pl: planKey, e: email });
  let resp;
  try {
    resp = await fetch(`${asaasBase(env)}/v3/payments`, {
      method: 'POST',
      headers: asaasHeaders(env.ASAAS_API_TOKEN),
      body: JSON.stringify({
        customer: customerId,
        billingType: 'UNDEFINED',
        value: plan.amount,
        dueDate: todayPlus(7),
        description: `${product.name} ${planKey.toUpperCase()}`,
        externalReference,
        callback: env.APP_RETURN_URL
          ? { successUrl: env.APP_RETURN_URL, autoRedirect: true }
          : undefined,
      }),
    });
  } catch {
    return json({ error: 'gateway_unreachable' }, 502);
  }

  const pay = await resp.json().catch(() => null);
  if (!resp.ok || !pay || !pay.id) {
    console.error('[create-payment] payments erro:', resp.status, (pay && pay.errors && pay.errors[0] && pay.errors[0].code) || '?');
    return json({ error: 'gateway_error' }, 502);
  }

  // Checkout hospedado do Asaas = invoiceUrl (UNDEFINED permite escolher forma lá).
  const checkoutUrl = pay.invoiceUrl || pay.bankSlipUrl || null;
  if (!checkoutUrl) {
    console.error('[create-payment] sem checkoutUrl no retorno');
    return json({ error: 'gateway_error' }, 502);
  }

  console.log(`[create-payment] ok produto=${productKey} pagamento=${pay.id} email=${maskEmail(email)}`);
  return json({ paymentId: pay.id, checkoutUrl, value: plan.amount, currency: 'BRL' });
}

/* ------------------------------------------------------------------ *
 * POST /api/webhook/asaas                                             *
 * ------------------------------------------------------------------ */

export async function webhookAsaas(request, env) {
  if (!env.PAY_KV || !env.WEBHOOK_SECRET) {
    return json({ error: 'server_misconfigured' }, 500);
  }

  // 1) Auth em constant-time contra env var.
  const incoming = request.headers.get('asaas-access-token') || '';
  const expected = String(env.WEBHOOK_SECRET);
  if (!incoming || !safeEqual(incoming, expected)) {
    console.error('[webhook] token inválido/ausente');
    return json({ error: 'unauthorized' }, 401);
  }

  const rawBody = await request.text();
  const hook = await (async () => {
    try { return JSON.parse(rawBody); } catch { return null; }
  })();
  if (!hook || typeof hook !== 'object') {
    return json({ error: 'invalid_json' }, 400);
  }

  const event = String(hook.event || '');
  // v3 embute a cobrança em .payment; v2 mandava plano. Aceitamos os dois.
  const payment = (hook.payment && typeof hook.payment === 'object') ? hook.payment : hook;
  const paymentId = String(payment.id || hook.id || '');

  if (!/^PAYMENT_/.test(event)) {
    return json({ received: true, ignored: event || 'sem_evento' });
  }
  if (!paymentId) {
    return json({ error: 'missing_payment_id' }, 400);
  }

  // 2) Só eventos pagos geram licença.
  if (!PAID_EVENTS.includes(event)) {
    console.log(`[webhook] evento não-pago ignorado: ${event}`);
    return json({ received: true, ignored: event });
  }

  // 3) Dedupe por payment id (anti-replay). Processa 1x apenas.
  const firstWin = await dedupeFirstWin(`pay:${paymentId}`, rawKv(env));
  if (!firstWin) {
    return json({ received: true, duplicate: true });
  }

  // 4) Metadados: externalReference gravado no create-payment é a fonte da
  //    verdade ({p, pl, e}). Fallback: busca a cobrança na API do Asaas.
  let meta = null;
  if (typeof payment.externalReference === 'string' && payment.externalReference.startsWith('{')) {
    try { meta = JSON.parse(payment.externalReference); } catch { meta = null; }
  }
  if (!meta || !meta.e) {
    try {
      const r = await fetch(`${asaasBase(env)}/v3/payments/${encodeURIComponent(paymentId)}`, {
        headers: asaasHeaders(env.ASAAS_API_TOKEN),
      });
      const full = await r.json().catch(() => null);
      if (r.ok && full && typeof full.externalReference === 'string') {
        meta = JSON.parse(full.externalReference);
      }
    } catch { /* segue null */ }
  }

  const email = meta ? normalizeEmail(meta.e) : null;
  const productKey = meta && PRODUCTS[meta.p] ? meta.p : null;
  const planKey = meta && productKey && PRODUCTS[productKey].plans[meta.pl || 'pro'] ? (meta.pl || 'pro') : null;

  if (!email || !productKey || !planKey) {
    // Sem metadados confiáveis: NÃO emite licença. Log sem PII.
    console.error(`[webhook] pagamento=${paymentId} sem externalReference utilizável`);
    return json({ received: true, skipped: 'no_metadata' }, 200);
  }

  // 5) Licença determinística assinada com HMAC-SHA256 (LICENSE_SECRET).
  const plan = PRODUCTS[productKey].plans[planKey];
  const license = {
    email,
    product: productKey,
    plan: planKey,
    exp: expiryDate(plan.days),
  };
  const signed = await signLicense(license, env.LICENSE_SECRET || env.WEBHOOK_SECRET);

  const record = {
    ...license,
    sig: signed.sig,
    paymentId,
    issuedAt: new Date().toISOString(),
  };
  try {
    await env.PAY_KV.put(`lic:${paymentId}`, JSON.stringify(record), { expirationTtl: 2 * 365 * 86400 });
  } catch (e) {
    console.error('[webhook] falha ao salvar licença no KV');
    return json({ error: 'kv_write_failed' }, 500);
  }

  console.log(`[webhook] licença emitida pagamento=${paymentId} produto=${productKey} email=${maskEmail(email)}`);
  return json({ received: true });
}

/* ------------------------------------------------------------------ *
 * GET /api/license                                                    *
 * ------------------------------------------------------------------ */

export async function getLicense(request, env) {
  if (!env.PAY_KV) return json({ error: 'server_misconfigured' }, 500);

  const url = new URL(request.url);
  const paymentId = (url.searchParams.get('payment') || '').trim();
  const emailRaw = url.searchParams.get('email') || '';

  if (!paymentId || paymentId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(paymentId)) {
    return json({ error: 'invalid_payment_id' }, 400);
  }
  const email = normalizeEmail(emailRaw);
  if (!email) return json({ error: 'invalid_email' }, 400);

  let record = null;
  try {
    record = await env.PAY_KV.get(`lic:${paymentId}`, { type: 'json' });
  } catch { record = null; }

  // Sem registro ainda => pagamento ainda não confirmado. Client continua polling.
  if (!record) return json({ found: false });

  // Par (payment, email) precisa bater. Email é dado público da própria
  // cobrança; comparação simples basta (não é segredo, nada vaza por timing).
  if (record.email !== email) {
    console.log('[license] par pagamento/email não confere');
    return json({ found: false }); // resposta idêntica ao "ainda pendente": não revela existência
  }

  return json({
    found: true,
    license: { email: record.email, product: record.product, plan: record.plan, exp: record.exp, sig: record.sig },
  });
}

/* ------------------------------------------------------------------ *
 * Router Pages Functions                                              *
 * ------------------------------------------------------------------ */

export async function onRequest(context) {
  const { request, env, params } = context;
  const route = Array.isArray(params.route) ? params.route : [];
  const method = request.method;

  if (method === 'OPTIONS') return preflight();

  try {
    if (route.length === 1 && route[0] === 'health' && method === 'GET') {
      return json({ ok: true });
    }
    if (route.length === 1 && route[0] === 'create-payment') {
      if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return await createPayment(request, env);
    }
    if (route.length === 2 && route[0] === 'webhook' && route[1] === 'asaas') {
      if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return await webhookAsaas(request, env);
    }
    if (route.length === 1 && route[0] === 'license' && method === 'GET') {
      return await getLicense(request, env);
    }
    return json({ error: 'not_found' }, 404);
  } catch (err) {
    console.error('[api] erro interno:', err && err.message);
    return json({ error: 'internal_error' }, 500);
  }
}
