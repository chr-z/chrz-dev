/**
 * Testes P5 — ciclo de vida de ASSINATURAS mensais (LinkForge/MenuPulse/Tably):
 * - stackedExpiry: renovação acumula sobre validade anterior ainda válida
 * - create-payment com plano MONTHLY cria assinatura (cycle MONTHLY) e
 *   devolve mode:'subscription' + checkout da primeira cobrança
 * - idempotência: assinatura ACTIVE existente é reaproveitada
 * - webhook de cobrança futura (só subscription id) resolve dono via índice
 * - licença reemitida com exp acumulado + índice por email (license-latest)
 * - anti-replay: replay NÃO estende validade duas vezes
 *
 * Reutiliza o harness do core.test.js (mockAsaas/MemoryKV/ctx).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stackedExpiry,
  licenseIndexKey,
  checkKey,
  signLicense,
} from '../src/core.js';
import { MemoryKV } from '../src/kv-mock.js';
import {
  onRequest,
  createPayment,
  webhookAsaas,
} from '../functions/api/[[route]].js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

function makeEnv({ kv = new MemoryKV() } = {}) {
  return {
    PAY_KV: kv,
    ASAAS_API_TOKEN: 'sandbox-key-fake',
    WEBHOOK_SECRET: 'webhook-secret-teste',
    LICENSE_SECRET: 'license-secret-teste',
    ASAAS_BASE_URL: 'https://api-sandbox.asaas.com',
  };
}

/** Fetch falso com rotas do Asaas; grava chamadas pra asserções. */
function mockAsaas(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [pattern, handler] of routes) {
      const m = String(url).match(pattern);
      if (m) {
        const body = handler(m, init) || {};
        return new Response(JSON.stringify(body), {
          status: body.__status || 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ errors: [{ code: 'not_mocked' }] }), { status: 404 });
  };
  return calls;
}

function ctx(pathname, { method = 'GET', body = null, headers = {} } = {}, env, paramsRoute) {
  const req = new Request(`https://chrz-dev.pages.dev${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { request: req, env, params: { route: paramsRoute }, data: {} };
}

/* ------------------------------------------------------------------ *
 * core: stackedExpiry e chave do índice                                *
 * ------------------------------------------------------------------ */

test('stackedExpiry: acumula sobre exp anterior ainda válido', () => {
  const now = new Date('2026-08-24T12:00:00Z');
  // anterior vence 2026-09-15 -> renovação empurra pra além disso
  assert.equal(stackedExpiry('2026-09-15', 40, now), '2026-10-25');
});

test('stackedExpiry: anterior já vencido ou inválido conta de hoje', () => {
  const now = new Date('2026-08-24T12:00:00Z');
  assert.equal(stackedExpiry('2026-08-01', 40, now), '2026-10-03'); // vencido
  assert.equal(stackedExpiry('não-é-data', 40, now), '2026-10-03'); // lixo
  assert.equal(stackedExpiry(null, 40, now), '2026-10-03');         // primeira compra
});

test('checkKey só aceita email normalizado; licenseIndexKey é estável', () => {
  assert.equal(checkKey('  Ze@Example.COM '), 'Ze@example.com');
  assert.equal(checkKey('nao-email'), null);
  assert.equal(checkKey(null), null);
  assert.equal(licenseIndexKey('A@B.com'), 'licidx:a@b.com');
});

/* ------------------------------------------------------------------ *
 * create-payment MONTHLY -> assinatura                                 *
 * ------------------------------------------------------------------ */

const SUB_REF = JSON.stringify({ p: 'tably', pl: 'pro', e: 'ze@x.com' });

test('create-payment mensal cria ASSINATURA cycle=MONTHLY e devolve checkout da 1ª cobrança', async () => {
  const env = makeEnv();
  const calls = mockAsaas([
    [/\/v3\/customers$/, () => ({ id: 'cus_1' })],
    [/\/v3\/subscriptions$/, (m, init) => {
      const b = JSON.parse(init.body);
      assert.equal(b.cycle, 'MONTHLY');
      assert.equal(b.billingType, 'UNDEFINED');
      assert.equal(b.value, 14);
      return { id: 'sub_9', status: 'ACTIVE', externalReference: SUB_REF };
    }],
    [/\/v3\/subscriptions\/sub_9\/payments/, () => ({
      data: [{ id: 'pay_first', invoiceUrl: 'https://www.asaas.com/c/pf1' }],
    })],
  ]);

  const res = await onRequest(ctx('/api/create-payment', {
    method: 'POST',
    body: { product: 'tably', plan: 'pro', email: 'ze@x.com' },
  }, env, ['create-payment']));
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.mode, 'subscription');
  assert.equal(out.subscriptionId, 'sub_9');
  assert.equal(out.paymentId, 'pay_first');
  assert.equal(out.checkoutUrl, 'https://www.asaas.com/c/pf1');

  // índice assinatura->email gravado no KV (fallback do webhook)
  const idx = JSON.parse(await env.PAY_KV.get('sub:sub_9'));
  assert.equal(idx.e, 'ze@x.com');
  assert.ok(calls.some(c => c.url.includes('/v3/subscriptions/sub_9/payments')));
});

test('create-payment mensal REAPROVEITA assinatura ACTIVE existente (idempotente)', async () => {
  const env = makeEnv();
  let subCreates = 0;
  // mock explícito: GET (?customer=) lista; POST cria — só o GET deve ocorrer
  globalThis.fetch = async (url, init = {}) => {
    const isList = /\/v3\/subscriptions\?/.test(String(url));
    const isCreate = /\/v3\/subscriptions$/.test(String(url)) && init.method === 'POST';
    if (isCreate) subCreates += 1;
    if (isList) {
      return new Response(JSON.stringify({
        data: [{ id: 'sub_EXIST', status: 'ACTIVE', deleted: false, externalReference: SUB_REF }],
      }), { status: 200 });
    }
    if (/\/v3\/subscriptions\/sub_EXIST\/payments/.test(String(url))) {
      return new Response(JSON.stringify({
        data: [{ id: 'pay_first2', invoiceUrl: 'https://www.asaas.com/c/pf2' }],
      }), { status: 200 });
    }
    if (/\/v3\/customers$/.test(String(url))) {
      return new Response(JSON.stringify({ id: 'cus_cached' }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };

  const res = await createPayment(
    ctx('/api/create-payment', { method: 'POST', body: { product: 'tably', email: 'ze@x.com' } }, env, ['create-payment']).request,
    env,
  );
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.subscriptionId, 'sub_EXIST'); // reaproveitada
  assert.equal(subCreates, 0);                   // nenhuma nova criada
});

/* ------------------------------------------------------------------ *
 * webhook: renovação acumula + índice por email                        *
 * ------------------------------------------------------------------ */

async function payWebhook(env, body) {
  return webhookAsaas(
    ctx('/api/webhook/asaas', {
      method: 'POST',
      body,
      headers: { 'asaas-access-token': 'webhook-secret-teste' },
    }, env, ['webhook', 'asaas']).request,
    env,
  );
}

test('webhook: 1ª cobrança da assinatura emite licença; cobrança futura (só subscription id) RENOVA com exp acumulado', async () => {
  const env = makeEnv();

  // checkout aconteceu antes (create-payment grava o índice assinatura->email)
  await env.PAY_KV.put('sub:sub_77', JSON.stringify({ e: 'ze@x.com', p: 'tably', pl: 'pro' }), 999);

  // 1ª cobrança: externalReference completo
  let res = await payWebhook(env, {
    event: 'PAYMENT_RECEIVED',
    payment: { id: 'pay_m1', subscription: 'sub_77', externalReference: SUB_REF },
  });
  assert.equal(res.status, 200);
  let lic = JSON.parse(await env.PAY_KV.get('lic:pay_m1'));
  const exp1 = lic.exp;
  assert.equal(lic.product, 'tably');
  // ~40 dias de hoje (primeira emissão)
  assert.ok(exp1 > new Date(Date.now() + 39 * 86400e3).toISOString().slice(0, 10));

  // índice por email aponta pra esta licença
  let idx = JSON.parse(await env.PAY_KV.get(licenseIndexKey('ze@x.com')));
  assert.equal(idx.paymentId, 'pay_m1');

  // 2ª cobrança (mês seguinte): SEM externalReference, só subscription id
  res = await payWebhook(env, {
    event: 'PAYMENT_CONFIRMED',
    payment: { id: 'pay_m2', subscription: 'sub_77' },
  });
  assert.equal(res.status, 200);
  const lic2 = JSON.parse(await env.PAY_KV.get('lic:pay_m2'));
  assert.equal(lic2.exp, stackedFrom(exp1)); // acumulou sobre a anterior válida

  idx = JSON.parse(await env.PAY_KV.get(licenseIndexKey('ze@x.com')));
  assert.equal(idx.paymentId, 'pay_m2');     // ponteiro andou pra frente

  function stackedFrom(prev) {
    const base = new Date(`${prev}T12:00:00Z`);
    return new Date(base.getTime() + 40 * 86400e3).toISOString().slice(0, 10);
  }
});

test('webhook: replay da mesma cobrança NÃO estende validade duas vezes', async () => {
  const env = makeEnv();
  await payWebhook(env, {
    event: 'PAYMENT_RECEIVED',
    payment: { id: 'pay_r1', externalReference: SUB_REF },
  });
  const first = JSON.parse(await env.PAY_KV.get('lic:pay_r1')).exp;

  // replay do MESMO payment id -> dedupe barra, índice não muda
  const res = await payWebhook(env, {
    event: 'PAYMENT_RECEIVED',
    payment: { id: 'pay_r1', externalReference: SUB_REF },
  });
  assert.equal((await res.json()).duplicate, true);
  const idx = JSON.parse(await env.PAY_KV.get(licenseIndexKey('ze@x.com')));
  assert.equal(JSON.parse(await env.PAY_KV.get(`lic:${idx.paymentId}`)).exp, first);
});

/* ------------------------------------------------------------------ *
 * GET /api/license-latest                                              *
 * ------------------------------------------------------------------ */

test('license-latest: devolve a licença mais recente do email; sem key ou key errada -> found:false uniforme', async () => {
  const env = makeEnv();
  await payWebhook(env, {
    event: 'PAYMENT_RECEIVED',
    payment: { id: 'pay_l1', externalReference: SUB_REF },
  });

  // par correto
  const reqOk = new Request('https://chrz-dev.pages.dev/api/license-latest?key=ze%40x.com&product=tably');
  let res = await onRequest({ request: reqOk, env, params: { route: ['license-latest'] }, data: {} });
  assert.equal(res.status, 200);
  const ok = await res.json();
  assert.equal(ok.found, true);
  assert.equal(ok.license.email, 'ze@x.com');
  assert.equal(ok.license.product, 'tably');
  assert.ok(ok.license.sig);

  // outro produto não vê a licença deste
  const reqOutro = new Request('https://chrz-dev.pages.dev/api/license-latest?key=ze%40x.com&product=menupulse');
  res = await onRequest({ request: reqOutro, env, params: { route: ['license-latest'] }, data: {} });
  assert.equal((await res.json()).found, false);

  // key inválida -> 400; email desconhecido -> found:false (sem enumeração)
  const reqBad = new Request('https://chrz-dev.pages.dev/api/license-latest?key=lixo&product=tably');
  res = await onRequest({ request: reqBad, env, params: { route: ['license-latest'] }, data: {} });
  assert.equal(res.status, 400);
  const reqNone = new Request('https://chrz-dev.pages.dev/api/license-latest?key=outro%40x.com&product=tably');
  res = await onRequest({ request: reqNone, env, params: { route: ['license-latest'] }, data: {} });
  assert.equal((await res.json()).found, false);
});

/* ------------------------------------------------------------------ *
 * client pay.js v3: renovação no boot                                  *
 * ------------------------------------------------------------------ */

const PAY_SRC = readFileSync(join(HERE, '../src/pay-client.js'), 'utf8');

function makeClientSandbox(storage, fetchImpl) {
  const documentMock = {
    readyState: 'complete',
    documentElement: { classList: { toggle() {}, add() {}, remove() {} } },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener() {},
    dispatchEvent() { return true; },
    createElement() { return { style: {}, classList: { add() {}, remove() {}, toggle() {} } }; },
  };
  const win = {
    PAY_CONFIG: {
      product: 'tably',
      plan: 'pro',
      apiBase: 'https://api.test',
      verifyKey: '',
    },
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
    },
    location: { href: 'https://chr-z.github.io/tably/' },
    prompt: () => null,
    crypto: globalThis.crypto,
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; } },
    document: documentMock,
    setTimeout: (fn) => setTimeout(fn, 1),
    clearTimeout,
    console,
    fetch: fetchImpl,
  };
  win.window = win;
  return win;
}

function loadPay(win) {
  const fn = new Function(
    'window', 'document', 'localStorage', 'fetch', 'crypto', 'CustomEvent',
    'location', 'prompt', 'setTimeout', 'clearTimeout', 'console',
    PAY_SRC + '\nreturn window;',
  );
  return fn(
    win, win.document, win.localStorage, win.fetch, win.crypto,
    win.CustomEvent, win.location, win.prompt, win.setTimeout,
    globalThis.clearTimeout, console,
  );
}

test('client: boot com licença EXPIRADA + entitlement recupera RENOVAÇÃO (license-latest por email)', async () => {
  const storage = {
    // máquina onde o usuário assinou no mês passado; a cobrança renovou e
    // esta licença local venceu
    paym_entitlement_tably: JSON.stringify({ paymentId: 'pay_1', email: 'ze@x.com' }),
    paym_license_tably: JSON.stringify({
      email: 'ze@x.com', product: 'tably', plan: 'pro', exp: '2026-08-01', sig: 'aa'.repeat(32),
    }),
  };
  const freshLicense = {
    email: 'ze@x.com', product: 'tably', plan: 'pro', exp: '2026-10-25', sig: 'ab'.repeat(32),
  };
  let askedLatest = false;
  const win = makeClientSandbox(storage, async (url) => ({
    ok: true,
    json: async () => {
      if (String(url).includes('/api/license-latest')) {
        askedLatest = true;
        return { found: true, license: freshLicense };
      }
      return { found: false };
    },
  }));
  loadPay(win);
  await new Promise((r) => setTimeout(r, 30));

  assert.ok(askedLatest, 'deveria consultar /api/license-latest');
  assert.deepEqual(JSON.parse(storage['paym_license_tably']), freshLicense);
  assert.equal(win.PayModule.state().licensed, true);
  assert.equal(win.PayModule.state().exp, '2026-10-25');
});

test('client: renew(email) em máquina NOVA recupera licença; found:false não inventa estado', async () => {
  const storage = {};
  const freshLicense = {
    email: 'ze@x.com', product: 'tably', plan: 'pro', exp: '2026-10-25', sig: 'ab'.repeat(32),
  };
  let latestCalls = 0;
  let answer = { found: true, license: freshLicense };
  const win = makeClientSandbox(storage, async (url) => ({
    ok: true,
    json: async () => {
      if (String(url).includes('/api/license-latest')) {
        latestCalls += 1;
        return answer;
      }
      return { found: false };
    },
  }));
  loadPay(win);
  await new Promise((r) => setTimeout(r, 20));

  const got = await win.PayModule.renew('Ze@X.com'); // email explícito (normalizado no servidor)
  assert.equal(got, true);
  assert.deepEqual(JSON.parse(storage['paym_license_tably']), freshLicense);

  // agora found:false em máquina sem licença => segue sem unlock, sem erro
  answer = { found: false };
  const got2 = await win.PayModule.renew('outro@x.com');
  assert.equal(got2, false);
  assert.equal(JSON.parse(storage['paym_license_tably']).sig, freshLicense.sig); // 1ª permanece
});
