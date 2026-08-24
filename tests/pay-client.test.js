/**
 * Testes do client pay.js v2 em Node (sem DOM real):
 * - canonicalização do payload idêntica ao servidor
 * - verificação HMAC via WebCrypto (global crypto do Node 22)
 * - namespacing de storage por produto (mesmo origin, 10 apps)
 * - migração das chaves globais legadas
 * - fluxo de polling/revalidação com fetch mockado
 *
 * pay.js é IIFE que usa window/localStorage/document — aqui a gente
 * carrega o arquivo como texto e avalia num sandbox mínimo controlado.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAY_SRC = readFileSync(join(HERE, '../src/pay-client.js'), 'utf8');

/* ------------------------------------------------------------------ *
 * Sandbox DOM/storage/fetch mínimo                                    *
 * ------------------------------------------------------------------ */

function makeSandbox({ storage = {}, fetchImpl = null } = {}) {
  const listeners = {};
  const documentMock = {
    readyState: 'complete',
    documentElement: { classList: { toggle() {}, add() {}, remove() {} } },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    dispatchEvent() { return true; },
    createElement() { return { style: {}, classList: { add() {}, remove() {}, toggle() {} } }; },
  };
  const sandbox = {
    window: null,
    localStorageData: storage,
  };
  const win = {
    PAY_CONFIG: {
      product: 'propostly',
      plan: 'pro',
      apiBase: 'https://api.test',
      verifyKey: '', // padrão produção: validação é a revalidação online
    },
    localStorage: {
      getItem: (k) => (k in sandbox.localStorageData ? sandbox.localStorageData[k] : null),
      setItem: (k, v) => { sandbox.localStorageData[k] = String(v); },
      removeItem: (k) => { delete sandbox.localStorageData[k]; },
    },
    location: { href: 'https://chr-z.github.io/propostaja/' },
    prompt: () => null,
    crypto: globalThis.crypto,
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; } },
    document: documentMock,
    setTimeout: (fn) => setTimeout(fn, 1), // acelera polling nos testes
    clearTimeout,
    console,
    fetch: fetchImpl || (() => Promise.resolve({ ok: false, json: async () => ({}) })),
  };
  win.window = win;
  sandbox.window = win;
  return sandbox;
}

function loadPay(sandbox) {
  const fn = new Function(
    'window', 'document', 'localStorage', 'fetch', 'crypto', 'CustomEvent',
    'location', 'prompt', 'setTimeout', 'clearTimeout', 'console',
    PAY_SRC + '\nreturn window;',
  );
  return fn(
    sandbox.window,
    sandbox.window.document,
    sandbox.window.localStorage,
    sandbox.window.fetch,
    sandbox.window.crypto,
    sandbox.window.CustomEvent,
    sandbox.window.location,
    sandbox.window.prompt,
    sandbox.window.setTimeout,
    globalThis.clearTimeout,
    console,
  );
}

/* ------------------------------------------------------------------ *
 * Helpers HMAC                                                        *
 * ------------------------------------------------------------------ */

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sigBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const SERVER_CANONICAL = '{"email":"a@b.com","product":"propostly","plan":"pro","exp":"2036-01-01"}';

test('client e servidor canonicam o payload igual', () => {
  function canonicalPayload(lic) {
    return JSON.stringify({ email: lic.email, product: lic.product, plan: lic.plan, exp: lic.exp });
  }
  assert.equal(
    canonicalPayload({ email: 'a@b.com', product: 'propostly', plan: 'pro', exp: '2036-01-01' }),
    SERVER_CANONICAL,
  );
});

test('pay.js carrega no sandbox e expõe API pública', () => {
  const sb = makeSandbox();
  const win = loadPay(sb);
  assert.ok(win.PayModule, 'PayModule deveria existir');
  assert.equal(typeof win.PayModule.buy, 'function');
  assert.equal(typeof win.PayModule.state, 'function');
  const st = win.PayModule.state();
  assert.equal(st.product, 'propostly');
  assert.equal(st.licensed, false);
});

test('buy(): email inválido não chama a API', async () => {
  let called = false;
  const sb = makeSandbox({
    fetchImpl: async () => { called = true; return { ok: true, json: async () => ({ checkoutUrl: 'https://x' }) }; },
  });
  sb.window.prompt = () => 'email-ruim';
  const win = loadPay(sb);
  await win.PayModule.buy();
  assert.equal(called, false);
});

test('buy(): fluxo feliz grava pendência/entitlement NAMESPACED e redireciona', async () => {
  const sb = makeSandbox({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ paymentId: 'pay_9', checkoutUrl: 'https://www.asaas.com/c/x' }),
    }),
  });
  sb.window.prompt = () => 'ze@example.com';
  const win = loadPay(sb);
  const out = await win.PayModule.buy();
  assert.equal(out, true);
  assert.equal(sb.window.location.href, 'https://www.asaas.com/c/x');
  // v2: chaves por produto — dois apps no mesmo origin não colidem
  const pending = JSON.parse(sb.localStorageData['paym_pending_propostly']);
  assert.equal(pending.paymentId, 'pay_9');
  assert.equal(pending.email, 'ze@example.com');
  const ent = JSON.parse(sb.localStorageData['paym_entitlement_propostly']);
  assert.equal(ent.paymentId, 'pay_9');
  assert.equal(sb.localStorageData['paym_pending'], undefined, 'chave global legada não deve ser criada');
});

test('namespacing: licença do Propostly NÃO desbloqueia o PriceCraft', async () => {
  const payload = SERVER_CANONICAL;
  const sig = await hmacHex('k', payload);
  const sb = makeSandbox({});
  sb.window.PAY_CONFIG.product = 'pricecraft'; // outro app, mesmo origin
  sb.localStorageData['paym_license_propostly'] = JSON.stringify(
    { email: 'a@b.com', product: 'propostly', plan: 'pro', exp: '2036-01-01', sig });
  const win = loadPay(sb);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(win.PayModule.state().licensed, false, 'produto diferente não pode desbloquear');
});

test('polling SEM verifyKey: resposta HTTPS da nossa API é aceita como autoritativa', async () => {
  // Regressão do bug v1: verifyLocal com verifyKey:'' sempre dava false ->
  // licença nunca era salva no polling. Agora found:true da API basta.
  const license = { email: 'z@x.com', product: 'propostly', plan: 'pro', exp: '2099-01-01', sig: 'ab'.repeat(32) };
  let pollCount = 0;
  const sb = makeSandbox({
    fetchImpl: async (url) => {
      if (String(url).includes('/api/create-payment')) {
        return { ok: true, json: async () => ({ paymentId: 'pay_p', checkoutUrl: 'about:blank' }) };
      }
      pollCount++;
      return { ok: true, json: async () => ({ found: pollCount >= 2, license: pollCount >= 2 ? license : null }) };
    },
  });
  Object.defineProperty(sb.window.location, 'href', { value: '', writable: true });
  // pendência pré-existente (como se o usuário tivesse acabado de pagar e voltado)
  sb.localStorageData['paym_pending_propostly'] = JSON.stringify(
    { paymentId: 'pay_p', email: 'z@x.com', startedAt: Date.now() });
  const win = loadPay(sb);

  const detail = await Promise.race([
    new Promise((resolve) => {
      const origDispatch = sb.window.document.dispatchEvent;
      sb.window.document.dispatchEvent = function (ev) {
        if (ev && ev.type === 'pay:state') resolve(ev.detail);
        return origDispatch.call(this, ev);
      };
      win.PayModule.init();
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('polling não desbloqueou em 5s')), 5000)),
  ]);
  assert.equal(detail.unlocked, true);
  assert.equal(detail.license.product, 'propostly');
  const saved = JSON.parse(sb.localStorageData['paym_license_propostly']);
  assert.equal(saved.sig, license.sig);
});

test('migração: chaves globais legadas viram namespaced na primeira execução', async () => {
  const sb = makeSandbox({});
  sb.localStorageData['paym_pending'] = JSON.stringify(
    { paymentId: 'pay_old', email: 'old@x.com', startedAt: Date.now() });
  sb.localStorageData['paym_entitlement'] = JSON.stringify({ paymentId: 'pay_old', email: 'old@x.com' });
  const win = loadPay(sb);
  const pending = JSON.parse(sb.localStorageData['paym_pending_propostly']);
  assert.equal(pending.paymentId, 'pay_old');
  const ent = JSON.parse(sb.localStorageData['paym_entitlement_propostly']);
  assert.equal(ent.email, 'old@x.com');
  assert.equal(sb.localStorageData['paym_pending'], undefined, 'legada removida após migrar');
  assert.equal(win.PayModule.state().licensed, false);
});

test('revalidação online: licença local + entitlement -> API confirma -> unlocked', async () => {
  const license = { email: 'v@x.com', product: 'propostly', plan: 'pro', exp: '2099-01-01', sig: 'cd'.repeat(32) };
  const sb = makeSandbox({
    fetchImpl: async () => ({ ok: true, json: async () => ({ found: true, license }) }),
  });
  sb.localStorageData['paym_license_propostly'] = JSON.stringify(license);
  sb.localStorageData['paym_entitlement_propostly'] = JSON.stringify({ paymentId: 'pay_r', email: 'v@x.com' });
  const win = loadPay(sb);
  const detail = await Promise.race([
    new Promise((resolve) => {
      const origDispatch = sb.window.document.dispatchEvent;
      sb.window.document.dispatchEvent = function (ev) {
        if (ev && ev.type === 'pay:state') resolve(ev.detail);
        return origDispatch.call(this, ev);
      };
      win.PayModule.init();
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout revalidação')), 5000)),
  ]);
  assert.equal(detail.unlocked, true);
});

test('revalidação OFFLINE: erro de rede mantém licença cacheada (offline-first)', async () => {
  const license = { email: 'o@x.com', product: 'propostly', plan: 'pro', exp: '2099-01-01', sig: 'ee'.repeat(32) };
  const sb = makeSandbox({
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
  });
  sb.localStorageData['license_placeholder'] = '';
  sb.localStorageData['paym_license_propostly'] = JSON.stringify(license);
  sb.localStorageData['paym_entitlement_propostly'] = JSON.stringify({ paymentId: 'pay_o', email: 'o@x.com' });
  const win = loadPay(sb);
  const detail = await Promise.race([
    new Promise((resolve) => {
      const origDispatch = sb.window.document.dispatchEvent;
      sb.window.document.dispatchEvent = function (ev) {
        if (ev && ev.type === 'pay:state') resolve(ev.detail);
        return origDispatch.call(this, ev);
      };
      win.PayModule.init();
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout offline')), 5000)),
  ]);
  assert.equal(detail.unlocked, true, 'offline: cache obtido por HTTPS antes vale');
});

test('tamper com verifyKey: licença com exp alterada NÃO desbloqueia', async () => {
  const SECRET = 'build-injected-key';
  const payload = JSON.stringify({ email: 'z@x.com', product: 'propostly', plan: 'pro', exp: '2099-01-01' });
  const goodSig = await hmacHex(SECRET, payload);
  const tampered = { email: 'z@x.com', product: 'propostly', plan: 'pro', exp: '2100-12-31', sig: goodSig };

  const sb = makeSandbox({});
  sb.window.PAY_CONFIG.verifyKey = SECRET;
  sb.localStorageData['paym_license_propostly'] = JSON.stringify(tampered);
  const win = loadPay(sb); // boot roda resumeFromStorage
  await new Promise(r => setTimeout(r, 30));
  assert.equal(win.PayModule.state().licensed, false);
});

test('servidor divergente com verifyKey: local adulterada é removida', async () => {
  const SECRET = 'build-injected-key';
  // Duas licenças VÁLIDAS (assinadas) com conteúdo diferente: a local
  // adulterada (exp maior, assinatura da original) e a do servidor.
  const payloadLocal = JSON.stringify({ email: 'd@x.com', product: 'propostly', plan: 'pro', exp: '2099-01-01' });
  const payloadServer = JSON.stringify({ email: 'd@x.com', product: 'propostly', plan: 'pro', exp: '2030-06-30' });
  const localRec = { email: 'd@x.com', product: 'propostly', plan: 'pro', exp: '2099-01-01', sig: await hmacHex(SECRET, payloadLocal) };
  const serverLicense = { email: 'd@x.com', product: 'propostly', plan: 'pro', exp: '2030-06-30', sig: await hmacHex(SECRET, payloadServer) };
  // "adulterada" = exp esticada mantendo a sig da original -> HMAC não bate
  const tamperedLocal = { ...localRec, exp: '2100-12-31' };

  const sb = makeSandbox({});
  sb.window.PAY_CONFIG.verifyKey = SECRET;
  sb.localStorageData['paym_license_propostly'] = JSON.stringify(tamperedLocal);
  sb.localStorageData['paym_entitlement_propostly'] = JSON.stringify({ paymentId: 'pay_d', email: 'd@x.com' });

  // Com verifyKey, HMAC local já reprova o tamper -> descarta SEM consultar API
  const win = loadPay(sb);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(win.PayModule.state().licensed, false, 'local divergente descartada');
  assert.equal(sb.localStorageData['paym_license_propostly'], undefined, 'licença adulterada removida');
});
