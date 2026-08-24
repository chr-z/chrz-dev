/**
 * pay.js — client do Pay Module (vanilla, zero dependências).
 *
 * Fluxo: botão Pro -> email -> POST /api/create-payment -> redirect checkout
 * Asaas -> volta pro app -> polling /api/license (até 60s) -> licença HMAC
 * verificada via WebCrypto -> salva em localStorage -> desbloqueia [data-pro].
 *
 * Uso:
 *   <script src="js/pay.js"></script>
 *   <script>window.PAY_CONFIG = { product:'propostly', plan:'pro',
 *     apiBase:'https://chrz-dev.pages.dev', verifyKey:'<chave-do-produto>' };</script>
 *   <button data-pay-button>Assinar Pro</button>
 *   <input data-pay-email type="email">   (opcional; senão usa prompt)
 *   <div data-pro hidden>Só Pro</div>     (revelado com licença válida)
 *   <div data-watermark>Free</div>        (oculto com licença válida)
 *
 * Segurança: nenhum dado de cartão passa por aqui (checkout hospedado no
 * gateway); a chave embedada só valida exibição — o gating client-side é
 * dissuasão, a fonte da verdade é a licença assinada no servidor.
 */
(function () {
  'use strict';

  var CFG = Object.assign({
    product: null,
    plan: 'pro',
    apiBase: 'https://chrz-dev.pages.dev',
    verifyKey: '',
    storagePrefix: 'paym_',
    pollIntervalMs: 4000,
    pollMaxMs: 60000,
  }, window.PAY_CONFIG || {});

  // ------------------------------------------------------------------
  // storage helpers (localStorage pode lançar em modo privado)
  // ------------------------------------------------------------------
  function lsGet(k) { try { return localStorage.getItem(CFG.storagePrefix + k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(CFG.storagePrefix + k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(CFG.storagePrefix + k); } catch (e) {} }

  function getPending() {
    try { return JSON.parse(lsGet('pending') || 'null'); } catch (e) { return null; }
  }
  function setPending(p) { lsSet('pending', JSON.stringify(p)); }
  function clearPending() { lsDel('pending'); }

  function getLicense() {
    try { return JSON.parse(lsGet('license_' + CFG.product) || 'null'); } catch (e) { return null; }
  }
  function saveLicense(lic) { lsSet('license_' + CFG.product, JSON.stringify(lic)); }

  // ------------------------------------------------------------------
  // cripto: mesma canonicalização do servidor (src/core.js)
  // ------------------------------------------------------------------
  function canonicalPayload(lic) {
    return JSON.stringify({ email: lic.email, product: lic.product, plan: lic.plan, exp: lic.exp });
  }

  function bytesToHex(buf) {
    var b = new Uint8Array(buf), out = '';
    for (var i = 0; i < b.length; i++) out += ('0' + b[i].toString(16)).slice(-2);
    return out;
  }

  function hexToBytes(hex) {
    if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2) return null;
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function hmacVerify(message, sigHex) {
    if (!CFG.verifyKey || !(window.crypto && crypto.subtle)) {
      // sem chave configurada ou sem WebCrypto: não trava o app, mas não confirma
      return Promise.resolve(false);
    }
    var expected = hexToBytes(String(sigHex || '').toLowerCase());
    if (!expected) return Promise.resolve(false);
    return crypto.subtle.importKey(
      'raw', new TextEncoder().encode(CFG.verifyKey),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    ).then(function (key) {
      return crypto.subtle.verify('HMAC', key, expected, new TextEncoder().encode(message));
    }).catch(function () { return false; });
  }

  function todayISO() { return new Date().toISOString().slice(0, 10); }

  /** Licença local é válida? (assinatura + produto + expiração) */
  function verifyLocal(lic) {
    if (!lic || !lic.sig) return Promise.resolve(false);
    if (CFG.product && lic.product !== CFG.product) return Promise.resolve(false);
    if (lic.exp && todayISO() > lic.exp) return Promise.resolve(false);
    return hmacVerify(canonicalPayload(lic), lic.sig);
  }

  // ------------------------------------------------------------------
  // UI unlock
  // ------------------------------------------------------------------
  function applyState(unlocked, lic) {
    var pros = document.querySelectorAll('[data-pro]');
    for (var i = 0; i < pros.length; i++) {
      if (unlocked) {
        pros[i].removeAttribute('hidden');
        pros[i].classList.remove('is-locked');
      } else {
        pros[i].setAttribute('hidden', '');
        pros[i].classList.add('is-locked');
      }
    }
    var marks = document.querySelectorAll('[data-watermark]');
    for (var j = 0; j < marks.length; j++) {
      marks[j].style.display = unlocked ? 'none' : '';
    }
    document.documentElement.classList.toggle('is-pro', !!unlocked);
    try {
      document.dispatchEvent(new CustomEvent('pay:state', {
        detail: { unlocked: !!unlocked, license: unlocked ? lic : null },
      }));
    } catch (e) {}
  }

  function setStatus(msg, isError) {
    var el = document.querySelector('[data-pay-status]');
    if (el) {
      el.textContent = msg || '';
      el.classList.toggle('pay-error', !!isError);
    }
  }

  // ------------------------------------------------------------------
  // checkout
  // ------------------------------------------------------------------
  function readEmail() {
    var input = document.querySelector('[data-pay-email]');
    var val = input && input.value ? input.value : (window.prompt ? window.prompt('Seu email para a licença:') : '');
    if (!val) return null;
    var s = String(val).trim();
    // espelha a validação do servidor (suficiente no client; servidor revalida)
    return /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s : null;
  }

  function startCheckout(email) {
    var clean = email ? String(email).trim() : readEmail();
    if (!clean || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      setStatus('Email inválido — confere aí?', true);
      return Promise.resolve(false);
    }
    setStatus('Criando seu checkout…');
    return fetch(CFG.apiBase + '/api/create-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product: CFG.product, plan: CFG.plan, email: clean }),
    }).then(function (r) {
      return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; });
    }).then(function (res) {
      if (!res.ok || !res.data.checkoutUrl) {
        var map = {
          rate_limited: 'Muitas tentativas — espera um minutinho.',
          invalid_email: 'Email inválido.',
          unknown_product: 'Produto indisponível.',
          server_misconfigured: 'Pagamentos ainda não habilitados neste app.',
          gateway_error: 'Erro no gateway de pagamento — tenta de novo.',
          gateway_unreachable: 'Gateway fora do ar — tenta em instantes.',
        };
        setStatus(map[res.data.error] || 'Não foi possível iniciar o pagamento.', true);
        return false;
      }
      setPending({
        paymentId: res.data.paymentId,
        email: clean,
        startedAt: Date.now(),
        checkoutUrl: res.data.checkoutUrl,
      });
      window.location.href = res.data.checkoutUrl; // checkout hospedado do Asaas
      return true;
    }).catch(function () {
      setStatus('Sem conexão com o servidor de pagamentos.', true);
      return false;
    });
  }

  // ------------------------------------------------------------------
  // polling /api/license
  // ------------------------------------------------------------------
  function fetchLicenseOnce(paymentId, email) {
    var url = CFG.apiBase + '/api/license?payment=' + encodeURIComponent(paymentId) +
      '&email=' + encodeURIComponent(email);
    return fetch(url).then(function (r) { return r.ok ? r.json() : { found: false }; })
      .catch(function () { return { found: false }; });
  }

  function pollUntilLicensed(onDone) {
    var pending = getPending();
    if (!pending) return onDone(false);
    var deadline = (pending.startedAt || Date.now()) + CFG.pollMaxMs;

    function tick() {
      // usuário pode ter concluído num outro load: checa pendência atual
      var p = getPending();
      if (!p) return onDone(false);
      fetchLicenseOnce(p.paymentId, p.email).then(function (out) {
        if (out.found && out.license) {
          verifyLocal(out.license).then(function (ok) {
            if (ok) {
              saveLicense(out.license);
              clearPending();
              applyState(true, out.license);
              onDone(true);
            } else {
              retryOrGiveUp();
            }
          });
        } else {
          retryOrGiveUp();
        }
      });
    }
    function retryOrGiveUp() {
      if (Date.now() > deadline) { onDone(false); return; }
      setTimeout(tick, CFG.pollIntervalMs);
    }
    tick();
  }

  // ------------------------------------------------------------------
  // boot
  // ------------------------------------------------------------------
  function resumeFromStorage() {
    var lic = getLicense();
    if (!lic) return Promise.resolve(false);
    return verifyLocal(lic).then(function (ok) {
      if (ok) {
        applyState(true, lic);
        clearPending(); // já licenciado: pendência velha morre
        return true;
      }
      lsDel('license_' + CFG.product); // inválida/expirada/adulterada
      return false;
    });
  }

  function bindButtons() {
    var btns = document.querySelectorAll('[data-pay-button]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function (ev) {
        ev.preventDefault();
        startCheckout();
      });
    }
  }

  function init() {
    bindButtons();
    var wasUnlocked = false;
    resumeFromStorage().then(function (unlocked) {
      wasUnlocked = unlocked;
      if (!wasUnlocked && getPending()) pollUntilLicensed(function () {});
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // API pública mínima
  window.PayModule = {
    init: init,
    buy: startCheckout,
    state: function () { return { product: CFG.product, licensed: !!getLicense() }; },
    signOut: function () { lsDel('license_' + CFG.product); clearPending(); applyState(false, null); },
  };
})();
