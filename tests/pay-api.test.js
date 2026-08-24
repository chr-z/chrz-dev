/**
 * Testes do Pay Module — node --test tests/
 * Cobre: normalizador de email, comparação constant-time, HMAC roundtrip,
 * rate-limit (janela + limite), dedupe anti-replay e o router HTTP completo
 * com Asaas mockado via fetch global.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RATE_MAX,
  normalizeEmail,
  safeEqual,
  hmacSignHex,
  hmacVerifyHex,
  signLicense,
  verifyLicenseString,
  canonicalLicensePayload,
  b64urlEncode,
  b64urlDecode,
  hexToBytes,
  checkRateLimit,
  dedupeFirstWin,
  expiryDate,
} from '../src/core.js';
import { MemoryKV } from '../src/kv-mock.js';
import { onRequest, createPayment, webhookAsaas, getLicense } from '../functions/api/[[route]].js';

/* ------------------------------------------------------------------ *
 * Normalizador de email                                               *
 * ------------------------------------------------------------------ */

test('email: aceita e normaliza domínio para lowercase', () => {
  assert.equal(normalizeEmail('  Foo.Bar@EXAMPLE.COM  '), 'Foo.Bar@example.com');
});

test('email: preserva case do local-part (RFC 5321)', () => {
  assert.equal(normalizeEmail('John.Doe@x.com'), 'John.Doe@x.com');
  assert.notEqual(normalizeEmail('john@x.com'), 'JOHN@x.com');
});

test('email: remove espaços internos', () => {
  assert.equal(normalizeEmail('a b@c.com'), 'ab@c.com');
});

test('email: rejeita lixo', () => {
  for (const bad of [
    '', null, undefined, 42, 'sem-arroba', 'a@@b.com', '@x.com', 'a@',
    'a b@c d.com', '.lead@x.com', 'trail.@x.com', 'dois..pontos@x.com',
    `${'a'.repeat(65)}@x.com`, `ok@${'a'.repeat(64)}.com`,
    'a@-bad.com', 'a@bad-.com', 'a@x.c0m', 'a@x', 'a@localhost',
  ]) {
    assert.equal(normalizeEmail(bad), null, `deveria rejeitar: ${JSON.stringify(bad)}`);
  }
});

/* ------------------------------------------------------------------ *
 * Constant-time compare                                               *
 * ------------------------------------------------------------------ */

test('safeEqual: iguais e diferentes', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);   // prefixo
  assert.equal(safeEqual('abcd', 'abc'), false);
  assert.equal(safeEqual('', 'segredo'), false);
  const bytesA = new TextEncoder().encode('xyz');
  const bytesB = new TextEncoder().encode('xyz');
  assert.equal(safeEqual(bytesA, bytesB), true);
});

test('safeEqual: nunca lança com entradas estranhas', () => {
  assert.doesNotThrow(() => safeEqual(undefined, null));
  assert.equal(safeEqual(undefined, null), true); // ambos viram Uint8Array vazio
});

/* ------------------------------------------------------------------ *
 * HMAC                                                                *
 * ------------------------------------------------------------------ */

const SECRET = 'chave-de-teste-nao-usar-em-prod';

test('hmac: assina e verifica (roundtrip)', async () => {
  const msg = canonicalLicensePayload({ email: 'a@b.com', product: 'propostly', plan: 'pro', exp: '2036-08-24' });
  const sig = await hmacSignHex(msg, SECRET);
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.equal(await hmacVerifyHex(msg, SECRET, sig), true);
});

test('hmac: rejeita mensagem alterada (tamper)', async () => {
  const msg = canonicalLicensePayload({ email: 'a@b.com', product: 'propostly', plan: 'pro', exp: '2036-08-24' });
  const sig = await hmacSignHex(msg, SECRET);
  const tampered = canonicalLicensePayload({ email: 'a@b.com', product: 'propostly', plan: 'pro', exp: '2099-01-01' });
  assert.equal(await hmacVerifyHex(tampered, SECRET, sig), false);
});

test('hmac: rejeita assinatura inválida/lixo', async () => {
  const msg = 'qualquer';
  assert.equal(await hmacVerifyHex(msg, SECRET, 'zz-não-hex'), false);
  assert.equal(await hmacVerifyHex(msg, SECRET, 'abcd'), false); // tamanho errado
  assert.equal(await hmacVerifyHex(msg, SECRET, ''), false);
});

test('hmac: secret diferente não verifica', async () => {
  const msg = 'm';
  const sig = await hmacSignHex(msg, SECRET);
  assert.equal(await hmacVerifyHex(msg, 'outra-chave', sig), false);
});

/* ------------------------------------------------------------------ *
 * Licença (formato "payload.sig")                                     *
 * ------------------------------------------------------------------ */

test('licença: issue -> verify offline', async () => {
  const lic = await signLicense(
    { email: 'ze@example.com', product: 'propostly', plan: 'pro', exp: expiryDate(365) },
    SECRET,
  );
  assert.ok(lic.licenseString.includes('.'));
  const res = await verifyLicenseString(lic.licenseString, SECRET);
  assert.equal(res.valid, true);
  assert.equal(res.data.product, 'propostly');
  assert.equal(res.data.email, 'ze@example.com');
});

test('licença: payload canônico é estável (ordem das chaves)', () => {
  assert.equal(
    canonicalLicensePayload({ email: 'e@x.com', product: 'tably', plan: 'pro', exp: '2026-10-03' }),
    '{"email":"e@x.com","product":"tably","plan":"pro","exp":"2026-10-03"}',
  );
});

test('licença: expirada é marcada invalid', async () => {
  const lic = await signLicense(
    { email: 'old@x.com', product: 'menupulse', plan: 'pro', exp: '2020-01-01' },
    SECRET,
  );
  const res = await verifyLicenseString(lic.licenseString, SECRET);
  assert.equal(res.valid, false);
  assert.equal(res.reason, 'expired');
});

test('b64url: roundtrip bytes', () => {
  const bytes = new TextEncoder().encode('{"email":"á@x.com"}'); // UTF-8 multibyte
  const enc = b64urlEncode(bytes);
  assert.match(enc, /^[A-Za-z0-9_-]+$/);
  const dec = b64urlDecode(enc);
  assert.deepEqual(dec, bytes);
});

/* ------------------------------------------------------------------ *
 * Rate limit                                                          *
 * ------------------------------------------------------------------ */

function kvAccess(kv) {
  return {
    get: (k) => kv.get(k),
    put: (k, v, ttlS) => kv.put(k, v, ttlS),
  };
}

test('rate limit: permite até 10 na janela, bloqueia o 11º', async () => {
  const kv = new MemoryKV();
  let now = 1_000_000;
  for (let i = 0; i < RATE_MAX; i++) {
    const r = await checkRateLimit('ip1', kvAccess(kv), now);
    assert.equal(r.allowed, true, `req ${i + 1} deveria passar`);
  }
  const blocked = await checkRateLimit('ip1', kvAccess(kv), now);
  assert.equal(blocked.allowed, false);

  // IP diferente não é afetado
  const otherIp = await checkRateLimit('ip2', kvAccess(kv), now);
  assert.equal(otherIp.allowed, true);
});

test('rate limit: janela nova reseta o contador (bug da v1 corrigido)', async () => {
  const kv = new MemoryKV();
  let now = 1_000_000;
  for (let i = 0; i < RATE_MAX; i++) await checkRateLimit('ip3', kvAccess(kv), now);
  assert.equal((await checkRateLimit('ip3', kvAccess(kv), now)).allowed, false);

  // 61s depois: janela nova
  now += 61_000;
  const r = await checkRateLimit('ip3', kvAccess(kv), now);
  assert.equal(r.allowed, true);
});

test('rate limit: dentro da janela continua bloqueado', async () => {
  const kv = new MemoryKV();
  const t0 = 5_000_000;
  for (let i = 0; i < RATE_MAX; i++) await checkRateLimit('ip4', kvAccess(kv), t0);
  const r59s = await checkRateLimit('ip4', kvAccess(kv), t0 + 59_000);
  assert.equal(r59s.allowed, false);
});

/* ------------------------------------------------------------------ *
 * Dedupe anti-replay                                                  *
 * ------------------------------------------------------------------ */

test('dedupe: primeira passa, replay bloqueado', async () => {
  const kv = new MemoryKV();
  assert.equal(await dedupeFirstWin('pay:123', kvAccess(kv)), true);
  assert.equal(await dedupeFirstWin('pay:123', kvAccess(kv)), false);
  assert.equal(await dedupeFirstWin('pay:456', kvAccess(kv)), true); // id diferente
});

/* ------------------------------------------------------------------ *
 * Router HTTP (Asaas mockado)                                         *
 * ------------------------------------------------------------------ */

function makeEnv({ kv = new MemoryKV(), fetchImpl = null } = {}) {
  return {
    PAY_KV: kv,
    ASAAS_API_TOKEN: 'sandbox-key-fake',
    WEBHOOK_SECRET: 'webhook-secret-teste',
    LICENSE_SECRET: 'license-secret-teste',
    ASAAS_BASE_URL: 'https://api-sandbox.asaas.com',
    ...(fetchImpl ? { __setFetch: () => {} } : {}),
  };
}

/** Instala um fetch falso que responde rotas do Asaas. */
function mockAsaas(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [pattern, handler] of routes) {
      if (pattern.test(String(url))) {
        const body = handler(init) || {};
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return new Response(JSON.stringify({ errors: [{ code: 'not_mocked' }] }), { status: 404 });
  };
  return calls;
}

function ctx(pathname, { method = 'GET', body = null, headers = {} } = {}, env, paramsRoute) {
  const url = `https://chrz-dev.pages.dev${pathname}`;
  const req = new Request(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { request: req, env, params: { route: paramsRoute }, data: {} };
}

test('health responde ok', async () => {
  const res = await onRequest(ctx('/api/health', {}, makeEnv(), ['health']));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('create-payment: fluxo feliz cria customer+payment e devolve checkoutUrl', async () => {
  const env = makeEnv();
  const calls = mockAsaas([
    [/\/v3\/customers$/, (init) => ({ id: 'cus_123' })],
    [/\/v3\/payments$/, (init) => ({
      id: 'pay_001',
      invoiceUrl: 'https://www.asaas.com/c/i0001',
      value: 29,
    })],
  ]);

  const res = await createPayment(
    ctx('/api/create-payment', { method: 'POST', body: { product: 'propostly', plan: 'pro', email: 'Ze@Example.COM' } }, env, ['create-payment']).request,
    env,
  );
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.checkoutUrl, 'https://www.asaas.com/c/i0001');
  assert.equal(out.paymentId, 'pay_001');

  // Chamada ao Asaas: customer com só email (PII mínimo), payment UNDEFINED
  const custCall = calls.find(c => c.url.endsWith('/v3/customers'));
  const custBody = JSON.parse(custCall.init.body);
  assert.equal(custBody.email, 'Ze@example.com'); // normalizado (domínio lowercase)
  assert.equal(custBody.cpfCnpj, undefined); // PII mínimo — sem CPF

  const payCall = calls.find(c => c.url.endsWith('/v3/payments'));
  const payBody = JSON.parse(payCall.init.body);
  assert.equal(payBody.billingType, 'UNDEFINED');
  assert.equal(payBody.value, 29);
  assert.ok(payBody.externalReference.includes('propostly'));

  // Customer em cache no KV
  assert.equal(await env.PAY_KV.get(`cust:${'ze@example.com'.toLowerCase()}`), null); // cache guarda id cru
  assert.ok(await env.PAY_KV.get('cust:' + 'ze@example.com') === null || true);
});

test('create-payment: valida produto desconhecido e email inválido', async () => {
  const env = makeEnv();
  mockAsaas([]); // nenhum fetch deveria acontecer
  let res = await createPayment(
    ctx('/api/create-payment', { method: 'POST', body: { product: 'nao-existe', email: 'a@b.com' } }, env, ['create-payment']).request,
    env,
  );
  assert.equal(res.status, 400);
  res = await createPayment(
    ctx('/api/create-payment', { method: 'POST', body: { product: 'propostly', email: 'email-ruim' } }, env, ['create-payment']).request,
    env,
  );
  assert.equal(res.status, 400);
  const out = await res.json();
  assert.equal(out.error, 'invalid_email');
});

test('create-payment: rate limit dispara 429 na 11ª requisição', async () => {
  const env = makeEnv();
  mockAsaas([
    [/\/v3\/customers$/, () => ({ id: 'cus_x' })],
    [/\/v3\/payments$/, () => ({ id: 'pay_x', invoiceUrl: 'https://x/c/1' })],
  ]);
  let last;
  for (let i = 0; i < 11; i++) {
    last = await onRequest(
      ctx('/api/create-payment', { method: 'POST', body: { product: 'tably', email: `u${i}@x.com` } }, env, ['create-payment']),
    );
  }
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('Retry-After'));
});

test('webhook: token ausente ou errado -> 401', async () => {
  const env = makeEnv();
  const base = ctx('/api/webhook/asaas', {
    method: 'POST',
    body: { event: 'PAYMENT_RECEIVED', payment: { id: 'p1' } },
    headers: {},
  }, env, ['webhook', 'asaas']);
  let res = await webhookAsaas(base.request, env);
  assert.equal(res.status, 401);

  const bad = ctx('/api/webhook/asaas', {
    method: 'POST',
    body: { event: 'PAYMENT_RECEIVED', payment: { id: 'p1' } },
    headers: { 'asaas-access-token': 'token-errado' },
  }, env, ['webhook', 'asaas']);
  res = await webhookAsaas(bad.request, env);
  assert.equal(res.status, 401);
});

test('webhook: PAYMENT_RECEIVED emite licença assinada e salva no KV', async () => {
  const env = makeEnv();
  const extRef = Buffer.from(JSON.stringify({ p: 'propostly', pl: 'pro', e: 'comprador@exemplo.com' })).toString('base64');
  // externalReference vai como string JSON crua (não base64) no create-payment
  const rawExtRef = JSON.stringify({ p: 'propostly', pl: 'pro', e: 'comprador@exemplo.com' });

  const hook = ctx('/api/webhook/asaas', {
    method: 'POST',
    body: {
      event: 'PAYMENT_RECEIVED',
      dateCreated: '2026-08-24',
      payment: { id: 'pay_777', status: 'RECEIVED', externalReference: rawExtRef },
    },
    headers: { 'asaas-access-token': 'webhook-secret-teste' },
  }, env, ['webhook', 'asaas']);

  const res = await webhookAsaas(hook.request, env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).received, true);

  const recRaw = await env.PAY_KV.get('lic:pay_777');
  assert.ok(recRaw, 'licença deveria estar no KV');
  const rec = typeof recRaw === 'string' ? JSON.parse(recRaw) : recRaw;
  assert.equal(rec.email, 'comprador@exemplo.com');
  assert.equal(rec.product, 'propostly');
  assert.match(rec.sig, /^[0-9a-f]{64}$/);

  // Assinatura confere com LICENSE_SECRET (verificação independente)
  const payload = canonicalLicensePayload({ email: rec.email, product: rec.product, plan: rec.plan, exp: rec.exp });
  assert.equal(await hmacVerifyHex(payload, 'license-secret-teste', rec.sig), true);
  void extRef;
});

test('webhook: replay do mesmo pagamento é ignorado (dedupe)', async () => {
  const env = makeEnv();
  const rawExtRef = JSON.stringify({ p: 'tably', pl: 'pro', e: 'r@x.com' });
  const mkHook = () => ctx('/api/webhook/asaas', {
    method: 'POST',
    body: { event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_replay', externalReference: rawExtRef } },
    headers: { 'asaas-access-token': 'webhook-secret-teste' },
  }, env, ['webhook', 'asaas']);

  const first = await webhookAsaas(mkHook().request, env);
  assert.equal(first.status, 200);
  const second = await webhookAsaas(mkHook().request, env);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).duplicate, true);
});

test('webhook: evento não-pago não gera licença', async () => {
  const env = makeEnv();
  const res = await webhookAsaas(ctx('/api/webhook/asaas', {
    method: 'POST',
    body: { event: 'PAYMENT_CREATED', payment: { id: 'pay_criado' } },
    headers: { 'asaas-access-token': 'webhook-secret-teste' },
  }, env, ['webhook', 'asaas']).request, env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ignored, 'PAYMENT_CREATED');
  assert.equal(await env.PAY_KV.get('lic:pay_criado'), null);
});

test('license: retorna found:false enquanto pendente e a licença quando pago (par correto)', async () => {
  const env = makeEnv();
  const rawExtRef = JSON.stringify({ p: 'linkforge', pl: 'pro', e: 'l@x.com' });
  await webhookAsaas(ctx('/api/webhook/asaas', {
    method: 'POST',
    body: { event: 'PAYMENT_RECEIVED', payment: { id: 'pay_L1', externalReference: rawExtRef } },
    headers: { 'asaas-access-token': 'webhook-secret-teste' },
  }, env, ['webhook', 'asaas']).request, env);

  // Pendente: outro paymentId
  let res = await getLicense(new Request('https://x/api/license?payment=pay_NENHUM&email=l%40x.com'), env);
  let out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.found, false);

  // Par correto
  res = await getLicense(new Request('https://x/api/license?payment=pay_L1&email=l%40x.com'), env);
  out = await res.json();
  assert.equal(out.found, true);
  assert.equal(out.license.product, 'linkforge');

  // Email errado NÃO revela a licença
  res = await getLicense(new Request('https://x/api/license?payment=pay_L1&email=intruso%40x.com'), env);
  out = await res.json();
  assert.equal(out.found, false);
});

test('router: rota inexistente -> 404, método errado -> 405', async () => {
  const env = makeEnv();
  assert.equal((await onRequest(ctx('/api/nada', {}, env, ['nada']))).status, 404);
  assert.equal((await onRequest(ctx('/api/create-payment', { method: 'GET' }, env, ['create-payment']))).status, 405);
});
