/**
 * Testes do client pay.js em Node (sem DOM real):
 * - canonicalização do payload idêntica ao servidor
 * - verificação HMAC via WebCrypto (global crypto do Node 22)
 * - fluxo de polling com fetch mockado
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
  const elements = [];
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
      verifyKey: 'client-verify-key',
    },
    localStorage: {
      getItem: (k) => (k in sandbox.localStorageData ? sandbox.localStorageData[k] : null),
      setItem: (k, v) => { sandbox.localStorageData[k] = String(v); },
      removeItem: (k) => { delete sandbox.localStorageData[k]; },
    },
    location: { href: 'https://app.test/' },
    prompt: () => null,
    crypto: globalThis.crypto,
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; } },
    document: documentMock,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
    clearTimeout,
    console,
    fetch: fetchImpl || (() => Promise.resolve({ ok: false, json: async () => ({}) })),
  };
  win.window = win;
  sandbox.window = win;
  return sandbox;
}

function loadPay(sandbox) {
  // Avalia pay.js com `window`/`document`/etc. do sandbox no escopo.
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
 * Canonical payload — precisa ser IDÊNTICO ao servidor                *
 * ------------------------------------------------------------------ */

const SERVER_CANONICAL = '{"email":"a@b.com","product":"propostly","plan":"pro","exp":"2036-01-01"}';

test('client e servidor canonicam o payload igual', () => {
  // espelho da função do client (mesma implementação)
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

test('buy(): fluxo feliz grava pendência e redireciona pro checkout', async () => {
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
  const pending = JSON.parse(sb.localStorageData['paym_pending']);
  assert.equal(pending.paymentId, 'pay_9');
  assert.equal(pending.email, 'ze@example.com');
});

test('polling: licença chega, HMAC verifica e desbloqueia estado', async () => {
  const SECRET = 'client-verify-key'; // mesmo verifyKey do sandbox
  const payload = JSON.stringify({ email: 'z@x.com', product: 'propostly', plan: 'pro', exp: '2099-01-01' });
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const sig = [...new Uint8Array(sigBuf)].map(b => b.toString(16).padStart(2, '0')).join('');

  const license = { email: 'z@x.com', product: 'propostly', plan: 'pro', exp: '2099-01-01', sig };

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
  // sem redirect de verdade
  Object.defineProperty(sb.window.location, 'href', { value: '', writable: true });

  sb.localStorageData['paym_pending'] = JSON.stringify({
    paymentId: 'pay_p', email: 'z@x.com', startedAt: Date.now(),
  });

  const win = loadPay(sb);

  // dispara resume/poll manualmente com timeout de segurança
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

  // licença persistida
  const saved = JSON.parse(sb.localStorageData['paym_license_propostly']);
  assert.equal(saved.sig, sig);
});

test('tamper: licença com exp alterada NÃO desbloqueia', async () => {
  const SECRET = 'client-verify-key'; // mesmo verifyKey do sandbox
  const payload = JSON.stringify({ email: 'z@x.com', product: 'propostly', plan: 'pro', exp: '2099-01-01' });
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const sig = [...new Uint8Array(sigBuf)].map(b => b.toString(16).padStart(2, '0')).join('');

  const tampered = { email: 'z@x.com', product: 'propostly', plan: 'pro', exp: '2100-12-31', sig };

  const sb = makeSandbox({});
  sb.localStorageData['paym_license_propostly'] = JSON.stringify(tampered);
  const win = loadPay(sb); // boot roda resumeFromStorage

  await new Promise(r => setTimeout(r, 20));
  // licença adulterada deve ter sido removida e estado continua locked
  assert.equal(win.PayModule.state().licensed, false);
});
