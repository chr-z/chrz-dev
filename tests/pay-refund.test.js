/**
 * Testes do ciclo de REEMBOLSO (P6) — node --test
 * Cobre: revokeLicenseByPayment (unidade), tratamento dos eventos
 * PAYMENT_REFUNDED / PAYMENT_RECEIVED_IN_CASH_UNDONE no router,
 * imunidade de eventos que NÃO revogam (parcial/in-progress/denied),
 * separação de slots de dedupe (refund vs paid) e a propagação da
 * revogação no client (boot online derruba o unlock quando a API
 * devolve a licença com exp retroativo).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REFUND_EVENTS,
  canonicalLicensePayload,
  hmacVerifyHex,
  revokeLicenseByPayment,
} from '../src/core.js';
import { MemoryKV } from '../src/kv-mock.js';
import { onRequest, webhookAsaas, getLicense } from '../functions/api/[[route]].js';

const SECRET = 'license-secret-teste';
const WEBHOOK_SECRET = 'webhook-secret-teste';

function kvAccess(kv) {
  return { get: (k) => kv.get(k), put: (k, v, ttlS) => kv.put(k, v, ttlS) };
}

function makeEnv(kv = new MemoryKV()) {
  return {
    PAY_KV: kv,
    ASAAS_API_TOKEN: 'sandbox-key-fake',
    WEBHOOK_SECRET,
    LICENSE_SECRET: SECRET,
    ASAAS_BASE_URL: 'https://api-sandbox.asaas.com',
  };
}

function hookCtx(body, env) {
  const req = new Request('https://chrz-dev.pages.dev/api/webhook/asaas', {
    method: 'POST',
    headers: { 'asaas-access-token': body.token || WEBHOOK_SECRET },
    body: JSON.stringify({ event: body.event, payment: body.payment }),
  });
  return req;
}

/** Emite uma licença REAL pelo caminho normal do webhook (setup dos testes). */
async function issuePaid(env, paymentId, email = 'comprador@exemplo.com') {
  const extRef = JSON.stringify({ p: 'propostly', pl: 'pro', e: email });
  const res = await webhookAsaas(hookCtx({
    event: 'PAYMENT_RECEIVED',
    payment: { id: paymentId, status: 'RECEIVED', externalReference: extRef },
  }, env), env);
  assert.equal(res.status, 200);
  const raw = await env.PAY_KV.get(`lic:${paymentId}`);
  assert.ok(raw, 'setup: licença deveria existir após PAYMENT_RECEIVED');
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/* ------------------------------------------------------------------ *
 * Unidade: revokeLicenseByPayment                                     *
 * ------------------------------------------------------------------ */

test('revogação: reescreve registro com exp retroativo e nova assinatura válida', async () => {
  const kv = new MemoryKV();
  const issuedAt = '2026-08-20T12:34:56.000Z';
  await kv.put('lic:pay_R1', JSON.stringify({
    email: 'r@x.com', product: 'propostly', plan: 'pro',
    exp: '2036-08-24', sig: 'f'.repeat(64), paymentId: 'pay_R1', issuedAt,
  }), 3600);

  const out = await revokeLicenseByPayment('pay_R1', SECRET, kvAccess(kv));
  assert.equal(out.revoked, true);
  assert.equal(out.wasAlreadyRevoked, false);

  const rec = JSON.parse(await kv.get('lic:pay_R1'));
  // exp retroativo = dia do issuedAt (licença nasce morta)
  assert.equal(rec.exp, '2026-08-20');
  assert.notEqual(rec.sig, 'f'.repeat(64));
  assert.ok(rec.revokedAt, 'revokedAt registrado');
  // assinatura confere para o payload NOVO (com exp retroativo)
  const payload = canonicalLicensePayload({ email: rec.email, product: rec.product, plan: rec.plan, exp: rec.exp });
  assert.equal(await hmacVerifyHex(payload, SECRET, rec.sig), true);
});

test('revogação: idempotente — re-refund mantém exp e revokedAt originais', async () => {
  const kv = new MemoryKV();
  await kv.put('lic:pay_R2', JSON.stringify({
    email: 'r2@x.com', product: 'tably', plan: 'pro',
    exp: '2036-01-01', sig: 'ab'.repeat(32), paymentId: 'pay_R2', issuedAt: '2026-05-05T00:00:00.000Z',
  }), 3600);

  const first = await revokeLicenseByPayment('pay_R2', SECRET, kvAccess(kv));
  assert.equal(first.wasAlreadyRevoked, false);
  const rec1 = JSON.parse(await kv.get('lic:pay_R2'));

  const second = await revokeLicenseByPayment('pay_R2', SECRET, kvAccess(kv));
  assert.equal(second.wasAlreadyRevoked, true);
  const rec2 = JSON.parse(await kv.get('lic:pay_R2'));

  assert.equal(rec2.exp, rec1.exp);
  assert.equal(rec2.revokedAt, rec1.revokedAt, 'primeiro revokedAt preservado');
  assert.equal(rec2.sig, rec1.sig, 'assinatura determinística estável');
});

test('revogação: sem licença local ou registro corrompido -> null (nada a fazer)', async () => {
  const kv = new MemoryKV();
  assert.equal(await revokeLicenseByPayment('pay_NADA', SECRET, kvAccess(kv)), null);

  await kv.put('lic:pay_lixo', 'isto-não-e-json', 3600);
  assert.equal(await revokeLicenseByPayment('pay_lixo', SECRET, kvAccess(kv)), null);
});

test('REFUND_EVENTS contém exatamente os eventos de estorno efetivado', () => {
  assert.deepEqual([...REFUND_EVENTS].sort(), ['PAYMENT_RECEIVED_IN_CASH_UNDONE', 'PAYMENT_REFUNDED']);
});

/* ------------------------------------------------------------------ *
 * Router: eventos de reembolso                                        *
 * ------------------------------------------------------------------ */

test('webhook: PAYMENT_REFUNDED revoga a licença da cobrança (contrato de leitura intacto)', async () => {
  const env = makeEnv();
  const rec0 = await issuePaid(env, 'pay_WF');
  assert.ok(rec0.exp > new Date().toISOString().slice(0, 10), 'setup: exp futuro');

  const res = await webhookAsaas(hookCtx({
    event: 'PAYMENT_REFUNDED',
    payment: { id: 'pay_WF', status: 'REFUNDED' },
  }, env), env);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.received, true);
  assert.equal(out.revoked, true);

  // Registro reescrito: exp retroativo re-assinado
  const rec = JSON.parse(await env.PAY_KV.get('lic:pay_WF'));
  assert.equal(rec.exp, rec0.issuedAt.slice(0, 10));
  assert.notEqual(rec.sig, rec0.sig);
  const payload = canonicalLicensePayload({ email: rec.email, product: rec.product, plan: rec.plan, exp: rec.exp });
  assert.equal(await hmacVerifyHex(payload, SECRET, rec.sig), true);

  // Contrato das rotas de leitura PRESERVADO: found:true com licença assinada
  const lic = await getLicense(new Request(`https://x/api/license?payment=pay_WF&email=${encodeURIComponent(rec.email)}`), env);
  const lj = await lic.json();
  assert.equal(lj.found, true);
  assert.equal(lj.license.exp, rec.exp);
  assert.equal(lj.license.sig, rec.sig);
});

test('webhook: PAYMENT_RECEIVED_IN_CASH_UNDONE também revoga', async () => {
  const env = makeEnv();
  await issuePaid(env, 'pay_UD', 'ud@x.com');
  const res = await webhookAsaas(hookCtx({
    event: 'PAYMENT_RECEIVED_IN_CASH_UNDONE',
    payment: { id: 'pay_UD' },
  }, env), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).revoked, true);
  const rec = JSON.parse(await env.PAY_KV.get('lic:pay_UD'));
  assert.match(rec.revokedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('webhook: refund sem licença local -> received:true, revoked:false', async () => {
  const env = makeEnv();
  const res = await webhookAsaas(hookCtx({
    event: 'PAYMENT_REFUNDED',
    payment: { id: 'pay_fantasma' },
  }, env), env);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.received, true);
  assert.equal(out.revoked, false);
  assert.equal(out.reason, 'no_local_license');
});

test('webhook: replay do refund -> duplicate:true e registro permanece estável', async () => {
  const env = makeEnv();
  await issuePaid(env, 'pay_RR', 'rr@x.com');
  const mk = () => hookCtx({ event: 'PAYMENT_REFUNDED', payment: { id: 'pay_RR' } }, env);

  const first = await webhookAsaas(mk(), env);
  assert.equal((await first.json()).revoked, true);
  const snap = await env.PAY_KV.get('lic:pay_RR');

  const second = await webhookAsaas(mk(), env);
  assert.equal((await second.json()).duplicate, true);
  assert.equal(await env.PAY_KV.get('lic:pay_RR'), snap, 'replay não reescreve registro');
});

test('webhook: refund ANTES do paid não bloqueia emissão posterior (slots de dedupe separados)', async () => {
  const env = makeEnv();
  // Corrida rara: REFUND chega primeiro (sem licença ainda)...
  const pre = await webhookAsaas(hookCtx({
    event: 'PAYMENT_REFUNDED', payment: { id: 'pay_ord' },
  }, env), env);
  assert.equal((await pre.json()).revoked, false);

  // ...depois o PAID emite normalmente (slot refund: ≠ slot pay:)
  const rec = await issuePaid(env, 'pay_ord', 'ord@x.com');
  assert.ok(rec.exp > new Date().toISOString().slice(0, 10));

  // Replay tardio do REFUND é absorvido pelo próprio slot e NÃO mata a licença nova
  const rep = await webhookAsaas(hookCtx({
    event: 'PAYMENT_REFUNDED', payment: { id: 'pay_ord' },
  }, env), env);
  assert.equal((await rep.json()).duplicate, true);
  const after = JSON.parse(await env.PAY_KV.get('lic:pay_ord'));
  assert.equal(after.exp, rec.exp, 'licença segue válida');
});

test('webhook: estorno PARCIAL, IN_PROGRESS e DENIED não revogam', async () => {
  for (const event of ['PAYMENT_PARTIALLY_REFUNDED', 'PAYMENT_REFUND_IN_PROGRESS', 'PAYMENT_REFUND_DENIED']) {
    const env = makeEnv();
    const rec0 = await issuePaid(env, `pay_np_${event.slice(-6)}`, 'np@x.com');
    const res = await webhookAsaas(hookCtx({ event, payment: { id: `pay_np_${event.slice(-6)}` } }, env), env);
    const out = await res.json();
    assert.equal(out.ignored, event, `${event} deve cair no filtro de não-pagos`);
    const rec = JSON.parse(await env.PAY_KV.get(`lic:pay_np_${event.slice(-6)}`));
    assert.equal(rec.sig, rec0.sig, `${event}: licença intocada`);
  }
});

test('webhook: refund com token errado -> 401 (auth vem antes de tudo)', async () => {
  const env = makeEnv();
  const res = await webhookAsaas(hookCtx({
    token: 'errado',
    event: 'PAYMENT_REFUNDED',
    payment: { id: 'pay_x' },
  }, env), env);
  assert.equal(res.status, 401);
});

/* ------------------------------------------------------------------ *
 * Client: revogação server-side derruba o unlock no boot              *
 * ------------------------------------------------------------------ */

const PAY_SRC_REFUND = (await import('node:fs')).readFileSync(
  new URL('../src/pay-client.js', import.meta.url), 'utf8');

function makeClientSandbox({ storage = {}, fetchJson } = {}) {
  const documentMock = {
    readyState: 'complete',
    documentElement: { classList: { toggle() {}, add() {}, remove() {} } },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener() {},
    dispatchEvent() { return true; },
  };
  const win = {
    PAY_CONFIG: { product: 'propostly', plan: 'pro', apiBase: 'https://api.test', verifyKey: '' },
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
    },
    location: { href: 'https://chr-z.github.io/propostaja/' },
    prompt: () => null,
    crypto: globalThis.crypto,
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
    document: documentMock,
    setTimeout: (fn) => setTimeout(fn, 1),
    clearTimeout,
    console,
    fetch: async () => ({ ok: true, json: fetchJson }),
  };
  win.window = win;
  return { win, storage };
}

function loadPay(sb) {
  const fn = new Function(
    'window', 'document', 'localStorage', 'fetch', 'crypto', 'CustomEvent',
    'location', 'prompt', 'setTimeout', 'clearTimeout', 'console',
    PAY_SRC_REFUND + '\nreturn window;',
  );
  return fn(
    sb.win, sb.win.document, sb.win.localStorage, sb.win.fetch, sb.win.crypto,
    sb.win.CustomEvent, sb.win.location, sb.win.prompt, sb.win.setTimeout,
    clearTimeout, console,
  );
}

test('client: licença local válida + servidor REVOGADO (found:true exp passado) -> cai pro free', async () => {
  const revokedFromServer = {
    email: 'rc@x.com', product: 'propostly', plan: 'pro',
    exp: '2020-01-01', // exp retroativo gravado pelo webhook de refund
    sig: 'ff'.repeat(32),
  };
  const localStillLooksValid = { ...revokedFromServer, exp: '2099-01-01' };

  const sb = makeClientSandbox({
    fetchJson: async (url) => {
      if (String(url).includes('/api/license-latest')) return { found: false }; // renovação: nada novo
      return { found: true, license: revokedFromServer }; // /api/license devolve a versão revogada
    },
  });
  sb.storage['paym_license_propostly'] = JSON.stringify(localStillLooksValid);
  sb.storage['paym_entitlement_propostly'] = JSON.stringify({ paymentId: 'pay_rc', email: 'rc@x.com' });

  const win = loadPay(sb);
  await new Promise((r) => setTimeout(r, 60)); // boot: resumeFromStorage + renewFromLatest

  assert.equal(win.PayModule.state().licensed, false, 'unlock deve cair com a revogação server-side');
  assert.equal(
    sb.storage['paym_license_propostly'], undefined,
    'licença revogada removida do cache',
  );
});
