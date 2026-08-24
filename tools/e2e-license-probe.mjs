/**
 * E2E license-chain probe — Pay Module (chrz-dev).
 *
 * Simula o ciclo completo SEM precisar de chave Asaas:
 *   1. POST /api/webhook/asaas com token válido + externalReference
 *      (mesmo formato que o create-payment grava na cobrança).
 *   2. Replay do mesmo evento -> deve voltar duplicate:true (anti-replay KV real).
 *   3. Token errado -> 401 (constant-time path negativo em produção).
 *   4. Email certo -> found:true + licença assinada.
 *   5. Email ERRADO -> found:false uniforme (não revela existência).
 *   6. Verificação INDEPENDENTE da assinatura: HMAC-SHA256 recalculado
 *      com node:crypto clássico (fora do código do projeto) contra LICENSE_SECRET.
 *   7. Sig adulterada -> inválida localmente.
 *   8-10. license-latest (renovação por email): mesma licença / produto
 *      divergente / email desconhecido -> found:false uniforme.
 *   11-15. CICLO DE REEMBOLSO: PAYMENT_REFUNDED sobre a licença emitida
 *      acima -> {revoked:true}; replay -> duplicate; leitura volta found:true
 *      com exp RETROATIVO re-assinado (HMAC independente confere); refund
 *      de cobrança desconhecida -> revoked:false (nada a fazer).
 *
 * Segurança: lê WEBHOOK_SECRET/LICENSE_SECRET de env vars (ou .env apontado
 * por PAY_ENV_FILE). NUNCA imprime valores — só nomes/comprimentos.
 *
 * Uso:  PAY_ENV_FILE=/path/.env node tools/e2e-license-probe.mjs [base_url]
 */
'use strict';

import { readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';

/* ---------- segredos: só de arquivo/env, jamais impressos ---------- */

function loadSecrets() {
  let webhook = process.env.WEBHOOK_SECRET || '';
  let license = process.env.LICENSE_SECRET || '';
  const file = process.env.PAY_ENV_FILE;
  if ((!webhook || !license) && file) {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (!m) continue;
      if (m[1] === 'WEBHOOK_SECRET' && !webhook) webhook = m[2].trim();
      if (m[1] === 'LICENSE_SECRET' && !license) license = m[2].trim();
    }
  }
  if (!webhook || !license) {
    console.error('ERRO: WEBHOOK_SECRET/LICENSE_SECRET ausentes (env ou PAY_ENV_FILE).');
    process.exit(2);
  }
  // Diagnóstico seguro: apenas presença + comprimento.
  console.log(`secrets: WEBHOOK_SECRET(presente,len=${webhook.length}) LICENSE_SECRET(presente,len=${license.length})`);
  return { webhook, license };
}

const { webhook: WEBHOOK_SECRET, license: LICENSE_SECRET } = loadSecrets();

const BASE = (process.argv[2] || 'https://chrz-dev.pages.dev').replace(/\/+$/, '');
const EMAIL = `e2e-probe-${randomUUID().slice(0, 8)}@example.com`;
const PAYMENT_ID = `pay_e2eprobe_${Date.now()}_${randomUUID().slice(0, 8)}`;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/**
 * Retry curto pra absorver consistência EVENTUAL do KV (leitura pode chegar
 * em outro edge antes da propagação). Não é tolerância com falha real:
 * esgota as tentativas e aí sim marca FAIL.
 */
async function withRetries(fn, attempts = 3, delayMs = 2000) {
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await fn();
    if (last.ok) return last;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}

async function main() {
  console.log(`base=${BASE}`);
  console.log(`probe: payment=${PAYMENT_ID} email=${EMAIL}`);

  // health
  const h = await fetch(`${BASE}/api/health`);
  check('GET /api/health = 200 {ok:true}', h.status === 200 && (await h.json()).ok === true);

  const extRef = JSON.stringify({ p: 'propostly', pl: 'pro', e: EMAIL });
  const body = JSON.stringify({
    event: 'PAYMENT_RECEIVED',
    dateCreated: new Date().toISOString(),
    payment: { id: PAYMENT_ID, value: 29, status: 'RECEIVED', externalReference: extRef },
  });

  // 3) token errado -> 401
  const bad = await fetch(`${BASE}/api/webhook/asaas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'asaas-access-token': 'token-errado-de-proposito' },
    body,
  });
  check('webhook token errado -> 401', bad.status === 401, `status=${bad.status}`);

  // 1) evento pago válido -> received:true
  const paidSentAt = new Date().toISOString(); // ~issuedAt da licença (alvo do exp pós-refund)
  const ok1 = await fetch(`${BASE}/api/webhook/asaas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'asaas-access-token': WEBHOOK_SECRET },
    body,
  });
  const j1 = await ok1.json().catch(() => null);
  check(
    'webhook válido -> 200 {received:true}',
    ok1.status === 200 && j1 && j1.received === true && !j1.skipped,
    `status=${ok1.status} body=${JSON.stringify(j1)}`,
  );

  // 2) replay -> duplicate:true (retry absorve propagação do marcador no KV)
  const rep = await withRetries(async () => {
    const r = await fetch(`${BASE}/api/webhook/asaas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'asaas-access-token': WEBHOOK_SECRET },
      body,
    });
    const j = await r.json().catch(() => null);
    return { ok: !!(j && j.duplicate === true), status: r.status, body: JSON.stringify(j) };
  });
  check('replay do mesmo payment -> {duplicate:true}', rep.ok, `status=${rep.status} body=${rep.body}`);

  // 5) par errado -> found:false uniforme (retry absorve leitura do KV)
  const wrong = await withRetries(async () => {
    const r = await fetch(`${BASE}/api/license?payment=${encodeURIComponent(PAYMENT_ID)}&email=outro@example.com`);
    const j = await r.json().catch(() => null);
    return { ok: !!(j && j.found === false), body: JSON.stringify(j) };
  });
  check('license com email errado -> {found:false}', wrong.ok, `body=${wrong.body}`);

  // 4) par correto -> licença
  const res = await withRetries(async () => {
    const r = await fetch(`${BASE}/api/license?payment=${encodeURIComponent(PAYMENT_ID)}&email=${encodeURIComponent(EMAIL)}`);
    const j = await r.json().catch(() => null);
    return { ok: !!(j && j.found === true && j.license), status: r.status, json: j };
  });
  const j = res.json;
  check(
    'license par correto -> {found:true, license}',
    res.ok,
    `status=${res.status}${j ? '' : ' body=parse-fail'}`,
  );
  if (!(j && j.found)) {
    finish();
    return;
  }
  const { email, product, plan, exp, sig } = j.license;
  check('licença: produto/plano batem com externalReference', product === 'propostly' && plan === 'pro', `product=${product} plan=${plan}`);
  check('licença: email normalizado bate', email === EMAIL);
  check('licença: exp YYYY-MM-DD futuro', /^\d{4}-\d{2}-\d{2}$/.test(exp || '') && exp > new Date().toISOString().slice(0, 10), `exp=${exp}`);

  // 6) verificação INDEPENDENTE (node:crypto clássico, fora do código do projeto)
  const payload = JSON.stringify({ email, product, plan, exp });
  const expected = createHmac('sha256', LICENSE_SECRET).update(payload, 'utf8').digest('hex');
  check('HMAC recalculado confere com sig da API', expected === sig, `sig.len=${sig.length}`);

  // 7) sig adulterada não passa no mesmo verificador
  const tampered = (sig[0] === '0' ? '1' : '0') + sig.slice(1);
  check('sig adulterada -> HMAC divergente', createHmac('sha256', LICENSE_SECRET).update(payload, 'utf8').digest('hex') !== tampered);

  // 8) license-latest: índice por email aponta pra esta licença (caminho de
  //    renovação de assinaturas). Produto errado e email errado -> found:false.
  const latest = await withRetries(async () => {
    const r = await fetch(`${BASE}/api/license-latest?key=${encodeURIComponent(EMAIL)}&product=propostly`);
    const j = await r.json().catch(() => null);
    return { ok: !!(j && j.found === true && j.license && j.license.sig === sig), body: JSON.stringify(j) };
  });
  check('license-latest (key=email, product) -> mesma licença', latest.ok, `body=${latest.body.slice(0, 120)}`);

  const latestWrong = await fetch(`${BASE}/api/license-latest?key=${encodeURIComponent(EMAIL)}&product=tably`);
  check('license-latest produto divergente -> {found:false}', (await latestWrong.json().catch(() => null))?.found === false);

  const latestNone = await fetch(`${BASE}/api/license-latest?key=nobody-${randomUUID().slice(0, 6)}%40example.com&product=propostly`);
  check('license-latest email desconhecido -> {found:false} uniforme', (await latestNone.json().catch(() => null))?.found === false);

  // ------------------------------------------------------------------
  // Ciclo de REEMBOLSO (P6) contra produção
  // ------------------------------------------------------------------

  // 11) refund da cobrança emitida acima -> revogada (exp retroativo)
  const refundBody = JSON.stringify({
    event: 'PAYMENT_REFUNDED',
    dateCreated: new Date().toISOString(),
    payment: { id: PAYMENT_ID, status: 'REFUNDED' },
  });
  const refOk = await withRetries(async () => {
    const r = await fetch(`${BASE}/api/webhook/asaas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'asaas-access-token': WEBHOOK_SECRET },
      body: refundBody,
    });
    const jr = await r.json().catch(() => null);
    return { ok: !!(jr && jr.revoked === true), status: r.status, body: JSON.stringify(jr) };
  });
  check('PAYMENT_REFUNDED -> {received:true, revoked:true}', refOk.ok, `status=${refOk.status} body=${refOk.body}`);

  // 12) replay do refund -> duplicate:true
  const refRep = await withRetries(async () => {
    const r = await fetch(`${BASE}/api/webhook/asaas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'asaas-access-token': WEBHOOK_SECRET },
      body: refundBody,
    });
    const jr = await r.json().catch(() => null);
    return { ok: !!(jr && jr.duplicate === true), body: JSON.stringify(jr) };
  });
  check('replay do refund -> {duplicate:true}', refRep.ok, `body=${refRep.body}`);

  // 13) leitura pós-refund: found:true com exp retroativo (= dia da emissão)
  //     e assinatura VÁLIDA pro payload novo — contrato de leitura intacto.
  const expectedRevokedExp = paidSentAt.slice(0, 10);
  const afterRefund = await withRetries(async () => {
    const r = await fetch(`${BASE}/api/license?payment=${encodeURIComponent(PAYMENT_ID)}&email=${encodeURIComponent(EMAIL)}`);
    const jr = await r.json().catch(() => null);
    return {
      ok: !!(jr && jr.found === true && jr.license && jr.license.exp === expectedRevokedExp),
      json: jr,
      body: JSON.stringify(jr),
    };
  }, 3, 2000);
  const licAfter = afterRefund.json && afterRefund.json.found ? afterRefund.json.license : null;
  check(
    'pós-refund: found:true com exp retroativo re-assinado',
    afterRefund.ok,
    `exp=${licAfter ? licAfter.exp : '?'} esperado=${expectedRevokedExp}`,
  );
  if (!licAfter) {
    finish();
    return;
  }

  // 14) HMAC independente confere para o payload revogado
  const revokedPayload = JSON.stringify({ email: licAfter.email, product: licAfter.product, plan: licAfter.plan, exp: licAfter.exp });
  const revokedExpected = createHmac('sha256', LICENSE_SECRET).update(revokedPayload, 'utf8').digest('hex');
  check('HMAC independente confere com a licença revogada', revokedExpected === licAfter.sig);
  check('exp revogado é passado (client cai pro free)', licAfter.exp <= new Date().toISOString().slice(0, 10), `exp=${licAfter.exp}`);

  // 15) refund de cobrança sem licença local -> revoked:false
  const ghostId = `pay_e2eghost_${randomUUID().slice(0, 8)}`;
  const ghost = await fetch(`${BASE}/api/webhook/asaas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'asaas-access-token': WEBHOOK_SECRET },
    body: JSON.stringify({ event: 'PAYMENT_REFUNDED', payment: { id: ghostId } }),
  });
  const gj = await ghost.json().catch(() => null);
  check('refund de cobrança desconhecida -> {revoked:false, reason:no_local_license}',
    !!(gj && gj.revoked === false && gj.reason === 'no_local_license'), `body=${JSON.stringify(gj)}`);

  finish();
}

function finish() {
  console.log(failures === 0 ? '\nE2E license-chain: TODOS OS CHECKS VERDES' : `\nE2E license-chain: ${failures} FALHA(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('erro inesperado:', e && e.message);
  process.exit(1);
});
