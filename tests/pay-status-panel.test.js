/**
 * Testes do painel de status do pay.js v4 (node:test, sem deps):
 * licenseStatus: derivacao pura de estado (none/active/expiring/expired)  *
 * - formatacao da validade pt-BR
 * - painel de UI [data-pay-exp]/[data-pay-days]/[data-pay-plan] via sandbox
 * - is-pro-expiring em <html>
 * - state() enriquecido (backward-compatible com v3)
 *
 * Reaproveita o mesmo harness de client.test.js: pay.js carregado como texto
 * num sandbox minimo com window/localStorage/document mockados.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAY_SRC = readFileSync(join(HERE, '../src/pay-client.js'), 'utf8');

/* ------------------------------------------------------------------ *
 * Sandbox (mesma forma de client.test.js)                            *
 * ------------------------------------------------------------------ */

function makeSandbox({ storage = {}, fetchImpl = null } = {}) {
  const listeners = {};
  // elementos "encontrados" por querySelectorAll — cada teste registra aqui
  const elements = [];
  const classLists = new Set();
  const documentMock = {
    readyState: 'complete',
    documentElement: {
      classList: {
        toggle(name, force) { if (force) classLists.add(name); else classLists.delete(name); },
        add() {}, remove() {},
        has(name) { return classLists.has(name); },
        _set: classLists,
      },
    },
    querySelectorAll(sel) {
      if (/data-pay-(exp|days|plan)/.test(sel)) return elements.slice();
      return [];
    },
    querySelector() { return null; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    dispatchEvent() { return true; },
    createElement() { return { style: {}, classList: { add() {}, remove() {}, toggle() {} } }; },
  };
  function makeEl(attrs) {
    const el = {
      attrs: Object.assign({}, attrs),
      textContent: '',
      style: {},
      removedHidden: false,
      setAttribute(k) { if (k === 'hidden') el.hiddenAttr = true; },
      removeAttribute(k) { if (k === 'hidden') el.removedHidden = true; },
      hasAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attrs, k) || (k === 'hidden' && !!el.hiddenAttr); },
    };
    return el;
  }
  const win = {
    PAY_CONFIG: {
      product: 'propostly',
      plan: 'pro',
      apiBase: 'https://api.test',
      verifyKey: '',
    },
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
    },
    location: { href: 'https://chr-z.github.io/propostaja/' },
    prompt: () => null,
    crypto: globalThis.crypto,
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; } },
    document: documentMock,
    setTimeout: (fn) => setTimeout(fn, 1),
    clearTimeout,
    console,
    fetch: fetchImpl || (() => Promise.resolve({ ok: false, json: async () => ({}) })),
    __elements: elements,
    __makeEl: makeEl,
    __htmlClasses: classLists,
  };
  win.window = win;
  return { window: win, storage, elements, classLists };
}

function loadPay(sandbox) {
  const win = sandbox.window;
  const fn = new Function(
    'window', 'document', 'localStorage', 'fetch', 'crypto', 'CustomEvent',
    'location', 'prompt', 'setTimeout', 'clearTimeout', 'console',
    PAY_SRC + '\nreturn window;',
  );
  return fn(
    win,
    win.document,
    win.localStorage,
    win.fetch,
    win.crypto,
    win.CustomEvent,
    win.location,
    win.prompt,
    win.setTimeout,
    globalThis.clearTimeout,
    console,
  );
}

const LIC_FAR = { email: 'a@b.com', product: 'propostly', plan: 'pro', exp: '2099-01-01', sig: 'ab'.repeat(32) };

/* ------------------------------------------------------------------ *
 * licenseStatus: licença vence HOJE -> expired (exp é INCLUSIVE)     *
 * ------------------------------------------------------------------ */

test('status: licença que vence HOJE ainda é válida (regra inclusive, espelha structurallyValid)', () => {
  const today = new Date().toISOString().slice(0, 10);
  const sb = makeSandbox({});
  sb.storage['paym_license_propostly'] = JSON.stringify({ ...LIC_FAR, exp: today });
  const win = loadPay(sb);
  await0(); // boot async dispara; estado consultado direto
  const st = win.PayModule.state();
  assert.equal(st.licensed, true);
  assert.equal(st.status, 'expiring');
  assert.equal(st.daysLeft, 0);
});

function await0() {} // boot assíncrono roda em background; state() é síncrono

test('status: expirou ONTEM -> expired e não desbloqueia', () => {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const sb = makeSandbox({});
  sb.storage['paym_license_propostly'] = JSON.stringify({ ...LIC_FAR, exp: yesterday });
  const win = loadPay(sb);
  await0();
  const st = win.PayModule.state();
  assert.equal(st.licensed, false);
  assert.equal(st.status, 'expired');
});

test('state() sem licença: status none e campos estáveis (contrato v3 mantido)', () => {
  const sb = makeSandbox({});
  const win = loadPay(sb);
  const st = win.PayModule.state();
  assert.equal(st.product, 'propostly');
  assert.equal(st.licensed, false);
  assert.equal(st.status, 'none');
  assert.equal(st.exp, null);
  assert.equal(st.plan, null);
});

test('state() ativa longe do vencimento: active + daysLeft coerente', () => {
  const today = new Date().toISOString().slice(0, 10);
  const far = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
  const sb = makeSandbox({});
  sb.storage['paym_license_propostly'] = JSON.stringify({ ...LIC_FAR, exp: far });
  const win = loadPay(sb);
  const st = win.PayModule.state();
  assert.equal(st.licensed, true);
  assert.equal(st.status, 'active');
  assert.ok(st.daysLeft >= 39 && st.daysLeft <= 41, 'daysLeft ~40, veio ' + st.daysLeft);
  assert.equal(st.plan, 'pro');
});

test('state() expirando: dentro de 7 dias -> expiring', () => {
  const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const sb = makeSandbox({});
  sb.storage['paym_license_propostly'] = JSON.stringify({ ...LIC_FAR, exp: soon });
  const win = loadPay(sb);
  const st = win.PayModule.state();
  assert.equal(st.licensed, true);
  assert.equal(st.status, 'expiring');
  assert.ok(st.daysLeft >= 4 && st.daysLeft <= 6);
});

test('licença vitalícia (sem exp): active para sempre, daysLeft null', () => {
  const sb = makeSandbox({});
  sb.storage['paym_license_propostly'] = JSON.stringify({ email: 'a@b.com', product: 'propostly', plan: 'pro', sig: 'ab'.repeat(32) });
  const win = loadPay(sb);
  const st = win.PayModule.state();
  assert.equal(st.licensed, true);
  assert.equal(st.status, 'active');
  assert.equal(st.daysLeft, null);
});

test('formato pt-BR da validade aparece no painel [data-pay-exp]', async () => {
  const sb = makeSandbox({});
  const el = sb.window.__makeEl({ 'data-pay-exp': '' });
  sb.elements.push(el);
  sb.storage['paym_license_propostly'] = JSON.stringify({ ...LIC_FAR, exp: '2036-01-05' });
  loadPay(sb);
  await new Promise((r) => setTimeout(r, 20)); // boot aplica estado
  assert.match(el.textContent, /válida até 05\/01\/2036/);
});

test('[data-pay-days]: plural correto (restam N dias / resta 1 dia)', async () => {
  const sb = makeSandbox({});
  const el = sb.window.__makeEl({ 'data-pay-days': '' });
  sb.elements.push(el);
  const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  sb.storage['paym_license_propostly'] = JSON.stringify({ ...LIC_FAR, exp: soon });
  loadPay(sb);
  await new Promise((r) => setTimeout(r, 20));
  assert.match(el.textContent, /^restam \d+ dias$/);

  const sb2 = makeSandbox({});
  const el2 = sb2.window.__makeEl({ 'data-pay-days': '' });
  sb2.elements.push(el2);
  const d1 = new Date(Date.now() + 25 * 3600000).toISOString().slice(0, 10); // amanhã ou depois
  sb2.storage['paym_license_propostly'] = JSON.stringify({ ...LIC_FAR, exp: d1 });
  loadPay(sb2);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(/^(resta 1 dia|restam \d+ dias)$/.test(el2.textContent), 'veio: ' + el2.textContent);
});

test('sem licença: painel esvazia texto e marca hidden', async () => {
  const sb = makeSandbox({});
  const el = sb.window.__makeEl({ 'data-pay-exp': '' });
  sb.elements.push(el);
  loadPay(sb);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(el.textContent, '');
  assert.equal(el.hasAttribute('hidden'), true);
});

test('is-pro-expiring entra em <html> só quando expiring', async () => {
  const soon = new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10);
  const lic = { ...LIC_FAR, exp: soon };
  const sb = makeSandbox({
    // boot precisa desbloquear via revalidação online (sem verifyKey):
    // entitlement + API confirmando a mesma licença
    fetchImpl: async () => ({ ok: true, json: async () => ({ found: true, license: lic }) }),
  });
  sb.storage['paym_license_propostly'] = JSON.stringify(lic);
  sb.storage['paym_entitlement_propostly'] = JSON.stringify({ paymentId: 'pay_x', email: 'a@b.com' });
  loadPay(sb);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sb.classLists.has('is-pro-expiring'), true);
  assert.equal(sb.classLists.has('is-pro'), true);

  const far = { ...LIC_FAR, exp: '2099-01-01' };
  const sb2 = makeSandbox({
    fetchImpl: async () => ({ ok: true, json: async () => ({ found: true, license: far }) }),
  });
  sb2.storage['paym_license_propostly'] = JSON.stringify(far);
  sb2.storage['paym_entitlement_propostly'] = JSON.stringify({ paymentId: 'pay_x', email: 'a@b.com' });
  loadPay(sb2);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sb2.classLists.has('is-pro-expiring'), false);
  assert.equal(sb2.classLists.has('is-pro'), true);
});

test('signOut limpa painel e classes pro', async () => {
  const sb = makeSandbox({
    fetchImpl: async () => ({ ok: true, json: async () => ({ found: true, license: LIC_FAR }) }),
  });
  const el = sb.window.__makeEl({ 'data-pay-exp': '' });
  sb.elements.push(el);
  sb.storage['paym_license_propostly'] = JSON.stringify(LIC_FAR);
  sb.storage['paym_entitlement_propostly'] = JSON.stringify({ paymentId: 'pay_x', email: 'a@b.com' });
  const win = loadPay(sb);
  await new Promise((r) => setTimeout(r, 20));
  assert.match(el.textContent, /válida até/);
  win.PayModule.signOut();
  assert.equal(el.textContent, '');
  assert.equal(el.hasAttribute('hidden'), true);
  assert.equal(sb.classLists.has('is-pro'), false);
});
