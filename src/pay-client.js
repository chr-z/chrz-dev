/**
 * pay.js v4 — client do Pay Module (vanilla, zero dependências).
 *
 * Fluxo: botão Pro -> email -> POST /api/create-payment -> redirect checkout
 * Asaas -> volta pro app -> polling /api/license (até 60s) -> licença salva
 * em localStorage -> desbloqueia [data-pro] / esconde [data-watermark].
 *
 * v3 (assinaturas): planos mensais viram ASSINATURA Asaas (cycle MONTHLY) —
 * cada cobrança paga re-emite a licença com validade acumulada. O boot busca
 * /api/license-latest por email+produto e recupera renovações feitas em
 * outro dispositivo; PayModule.renew() força a checagem sob demanda.
 *
 * v4 (painel de status): a UI pode mostrar o estado real da licença sem
 * conhecer os detalhes — [data-pay-exp] recebe a validade legível
 * (ex.: "válida até 05/10/2026"), [data-pay-days] os dias restantes e
 * [data-pay-plan] o plano; <html> ganha is-pro-expiring quando faltam <= 7
 * dias. PayModule.state() passa a expor { licensed, exp, daysLeft, plan,
 * status } (status: 'none'|'active'|'expiring'|'expired'). Tudo aditivo:
 * integração v3 continua funcionando sem mudança nenhuma.
 *
 * Uso:
 *   <script src="js/pay.js"></script>
 *   <script>window.PAY_CONFIG = { product:'propostly', plan:'pro',
 *     apiBase:'https://chrz-dev.pages.dev', verifyKey:'' };</script>
 *   <button data-pay-button>Assinar Pro</button>
 *   <input data-pay-email type="email">   (opcional; senão usa prompt)
 *   <div data-pro hidden>Só Pro</div>     (revelado com licença válida)
 *   <div data-watermark>Free</div>        (oculto com licença válida)
 *
 * Segurança:
 *   - Nenhum dado de cartão passa por aqui (checkout hospedado no gateway).
 *   - Segredo HMAC NUNCA vai pro repo público (HMAC é simétrico). Com
 *     verifyKey vazia (padrão em repos públicos), a validação é feita contra
 *     a nossa API por HTTPS, que é a fonte autoritativa; a resposta
 *     { found:true } dela equivale a uma assinatura verificada.
 *   - Storage namespaced POR PRODUTO: todos os apps vivem no mesmo origin
 *     (chr-z.github.io), então pendência/entitlement/licença nunca colidem
 *     entre produtos.
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
  // Chaves namespaced por produto p/ isolamento entre apps do mesmo origin.
  // ------------------------------------------------------------------
  function lsGet(k) { try { return localStorage.getItem(CFG.storagePrefix + k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(CFG.storagePrefix + k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(CFG.storagePrefix + k); } catch (e) {} }

  function nsKey(name) {
    // pending_<produto>, entitlement_<produto>, license_<produto>
    return name + '_' + (CFG.product || 'default');
  }

  /** Migração one-shot das chaves globais legadas (pré-v2, só Propostly). */
  function migrateLegacy() {
    if (!CFG.product) return;
    ['pending', 'entitlement'].forEach(function (name) {
      var legacy = CFG.storagePrefix + name;
      var target = CFG.storagePrefix + nsKey(name);
      var hasTarget = lsGet(nsKey(name)) !== null;
      var raw = null;
      try { raw = localStorage.getItem(legacy); } catch (e) {}
      if (!hasTarget && raw) {
        try {
          var obj = JSON.parse(raw);
          if (obj && obj.email) lsSet(nsKey(name), JSON.stringify(obj));
        } catch (e) {}
      }
      try { localStorage.removeItem(legacy); } catch (e) {}
    });
  }

  function getPending() {
    try { return JSON.parse(lsGet(nsKey('pending')) || 'null'); } catch (e) { return null; }
  }
  function setPending(p) { lsSet(nsKey('pending'), JSON.stringify(p)); }
  function clearPending() { lsDel(nsKey('pending')); }

  /**
   * Entitlement = par (paymentId, email) persistente, separado da pendência
   * de polling. Serve pra revalidar a licença online no boot mesmo depois
   * de dias.
   */
  function getEntitlement() {
    try { return JSON.parse(lsGet(nsKey('entitlement')) || 'null'); } catch (e) { return null; }
  }
  function setEntitlement(e) { lsSet(nsKey('entitlement'), JSON.stringify(e)); }

  function getLicense() {
    try { return JSON.parse(lsGet(nsKey('license')) || 'null'); } catch (e) { return null; }
  }
  function saveLicense(lic) { lsSet(nsKey('license'), JSON.stringify(lic)); }
  function clearLicense() { lsDel(nsKey('license')); }

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

  /**
   * Verificação HMAC local (só com verifyKey de build).
   * Retorna Promise<true|false>.
   */
  function hmacVerify(message, sigHex) {
    if (!CFG.verifyKey || !(window.crypto && crypto.subtle)) {
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

  // ------------------------------------------------------------------
  // v4: cálculo de status da licença (puro, testável) + painel de UI
  // ------------------------------------------------------------------
  /**
   * Estado derivado do par (licença, data ISO de hoje).
   *  - sem licença ................ { licensed:false, status:'none' }
   *  - exp no passado ............ { licensed:false, status:'expired' }
   *    (espelha structurallyValid: exp é INCLUSIVE — hoje == exp AINDA é
   *    válido/desbloqueado; expired só a partir do dia seguinte)
   *  - faltam <= EXPIRY_WARN_DAYS . status:'expiring'
   *  - resto ..................... { licensed:true, status:'active' }
   * daysLeft = dias CHEIOS restantes (hoje < exp): exp amanhã -> 1;
   * nunca negativo quando expired.
   */
  var EXPIRY_WARN_DAYS = 7;

  function licenseStatus(lic, todayIso) {
    if (!lic || !lic.email) {
      return { licensed: false, exp: null, daysLeft: null, plan: null, status: 'none' };
    }
    var exp = typeof lic.exp === 'string' ? lic.exp : null;
    var daysLeft = null;
    if (exp && /^\d{4}-\d{2}-\d{2}$/.test(exp)) {
      daysLeft = Math.max(0, Math.floor((Date.parse(exp + 'T00:00:00Z') -
        Date.parse(todayIso + 'T00:00:00Z')) / 86400000));
    }
    var expired = !(lic.sig && (!exp || todayIso <= exp)); // espelha structurallyValid
    if (expired) {
      return { licensed: false, exp: exp, daysLeft: daysLeft, plan: lic.plan || null, status: 'expired' };
    }
    var expiring = exp && daysLeft !== null ? daysLeft <= EXPIRY_WARN_DAYS : false;
    return {
      licensed: true,
      exp: exp,
      daysLeft: daysLeft,
      plan: lic.plan || null,
      status: expiring ? 'expiring' : 'active',
    };
  }

  /** "2036-01-05" -> "05/01/2036" (pt-BR; fallback devolve o ISO cru). */
  function formatExp(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? m[3] + '/' + m[2] + '/' + m[1] : String(iso || '');
  }

  /**
   * Painel de status (v4): preenche [data-pay-exp] / [data-pay-days] /
   * [data-pay-plan] e a classe is-pro-expiring em <html>. Chamado de
   * applyState() — apps antigos SEM esses atributos simplesmente não têm
   * o que atualizar (zero custo, zero quebra).
   */
  function renderStatusPanel(st) {
    var nodes = document.querySelectorAll('[data-pay-exp], [data-pay-days], [data-pay-plan]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (st.licensed) {
        if (el.hasAttribute('data-pay-exp')) el.textContent = st.exp ? 'válida até ' + formatExp(st.exp) : '';
        else if (el.hasAttribute('data-pay-days')) {
          el.textContent = st.daysLeft !== null
            ? (st.daysLeft === 1 ? 'resta 1 dia' : 'restam ' + st.daysLeft + ' dias')
            : '';
        } else el.textContent = st.plan || '';
        el.removeAttribute('hidden');
      } else {
        el.textContent = '';
        el.setAttribute('hidden', '');
      }
    }
    try {
      document.documentElement.classList.toggle('is-pro-expiring', st.status === 'expiring');
    } catch (e) {}
  }


  function structurallyValid(lic) {
    return !!(lic && typeof lic === 'object' && lic.sig &&
      lic.product === CFG.product && lic.email &&
      (!lic.exp || todayISO() <= lic.exp));
  }

  /**
   * Validação de licença.
   *  - com verifyKey: HMAC-SHA256 offline via WebCrypto (true/false).
   *  - sem verifyKey (repos públicos): retorna true se estruturalmente
   *    válida — quem garante a assinatura é a revalidação online na nossa
   *    API (fonte autoritativa), feita pelo boot/polling via HTTPS.
   */
  function verifyLocal(lic) {
    if (!structurallyValid(lic)) return Promise.resolve(false);
    if (!CFG.verifyKey) return Promise.resolve(true); // autoridade = revalidação online
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
    // v4: painel de status sempre reflete o estado derivado da licença
    renderStatusPanel(unlocked ? licenseStatus(lic, todayISO()) : licenseStatus(null, todayISO()));
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
    return /^[^\s@]{1,64}@[^@\s]+\.[^@\s]{2,}$/.test(s) ? s : null;
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
        paymentId: res.data.paymentId || null,
        email: clean,
        startedAt: Date.now(),
        checkoutUrl: res.data.checkoutUrl,
        mode: res.data.mode === 'subscription' ? 'subscription' : 'single',
      });
      setEntitlement({ paymentId: res.data.paymentId || null, email: clean });
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
  /**
   * Busca a licença na API. Erro de rede PROPAGA (caller decide:
   * polling -> tenta de novo; revalidação no boot -> confia no cache,
   * comportamento offline-first do PWA). Resposta HTTP != 200 ou
   * {found:false} significam "servidor acessível e ainda não há licença".
   */
  function fetchLicenseOnce(paymentId, email) {
    var url = CFG.apiBase + '/api/license?payment=' + encodeURIComponent(paymentId) +
      '&email=' + encodeURIComponent(email);
    return fetch(url).then(function (r) { return r.ok ? r.json() : { found: false }; });
  }

  /**
   * Licença mais recente do EMAIL (assinaturas mensais): cada renovação gera
   * um NOVO payment id que esta máquina nunca viu — a busca é por email+produto.
   */
  function fetchLatestOnce(email) {
    var url = CFG.apiBase + '/api/license-latest?key=' + encodeURIComponent(email) +
      '&product=' + encodeURIComponent(CFG.product || '');
    return fetch(url).then(function (r) { return r.ok ? r.json() : { found: false }; });
  }

  function acceptLicense(lic, onDone) {
    saveLicense(lic);
    clearPending();
    applyState(true, lic);
    onDone(true);
  }

  function pollUntilLicensed(onDone) {
    var pending = getPending();
    if (!pending) return onDone(false);
    var deadline = (pending.startedAt || Date.now()) + CFG.pollMaxMs;

    function tick() {
      // usuário pode ter concluído num outro load: checa pendência atual
      var p = getPending();
      if (!p) return onDone(false);
      var byPayment = p.paymentId
        ? fetchLicenseOnce(p.paymentId, p.email)
        : Promise.resolve({ found: false });
      byPayment.then(function (out) {
        // Assinatura: se a cobrança ainda não resolve por id (geração é
        // assíncrona), a renovação pode já aparecer como licença mais
        // recente do email.
        if (p.mode === 'subscription' && !(out.found && out.license)) {
          return fetchLatestOnce(p.email).then(function (latest) {
            return (latest.found && latest.license) ? latest : out;
          });
        }
        return out;
      }).then(function (out) {
        if (out.found && out.license && structurallyValid(out.license)) {
          if (CFG.verifyKey) {
            hmacVerify(canonicalPayload(out.license), out.license.sig).then(function (ok) {
              if (ok) acceptLicense(out.license, onDone);
              else retryOrGiveUp();
            });
          } else {
            // Resposta HTTPS da NOSSA API = fonte autoritativa (o par
            // payment+email é a prova posse; a assinatura vive no servidor).
            acceptLicense(out.license, onDone);
          }
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
  function revalidateOnline(lic, onFail) {
    var ent = getEntitlement();
    if (!(ent && ent.paymentId && lic && lic.email)) {
      clearLicense(); // não há como provar: estado local inválido
      return Promise.resolve(false);
    }
    return fetchLicenseOnce(ent.paymentId, lic.email).then(function (out) {
      if (out.found && out.license && structurallyValid(out.license)) {
        if (!CFG.verifyKey || out.license.sig === lic.sig) {
          applyState(true, out.license);
          clearPending();
          if (out.license.sig !== lic.sig) saveLicense(out.license);
          return true;
        }
        // servidor difere e temos verifyKey: local tá velha/adulterada
        clearLicense();
        return false;
      }
      if (out.found) clearLicense(); // servidor tem outro estado: local inválida
      return false; // offline ou ainda não pago: mantém como está
    }).catch(function () {
      // OFFLINE: licença foi obtida da API por HTTPS quando do pagamento;
      // confiar na cópia cacheada enquanto offline é o comportamento
      // offline-first esperado (gating client é dissuasão).
      applyState(true, lic);
      return true;
    });
  }

  function resumeFromStorage() {
    migrateLegacy();
    var lic = getLicense();
    if (!lic) return Promise.resolve(false);
    return verifyLocal(lic).then(function (ok) {
      if (!ok) { clearLicense(); return false; }
      if (CFG.verifyKey) {
        applyState(true, lic);
        clearPending();
        return true;
      }
      var ent = getEntitlement();
      if (ent && ent.paymentId) {
        // sem verifyKey: confirma online (com fallback offline p/ cache)
        return revalidateOnline(lic);
      }
      // Entitlement ausente (localStorage limpo pela metade / migração):
      // tenta recuperar por email ANTES de desligar o unlock. Erro de rede
      // mantém o cache E o unlock (offline-first); found:false trava a UI
      // nesta sessão mas NÃO apaga o cache (mesma leniência do caminho
      // payment+email no v2 — retry amanhã custa nada).
      return renewByEmail(lic.email).then(function (outcome) {
        if (outcome === 'accepted') return true;
        if (outcome === 'error') { applyState(true, lic); return true; }
        return false; // 'notfound': sem prova online nesta sessão
      });
    });
  }

  /**
   * Resultado da busca por email: 'accepted' (licença mais nova aplicada),
   * 'notfound' (servidor acessível e nada mais novo) ou 'error' (rede caiu —
   * NÃO é prova de ausência).
   */
  function renewByEmail(email) {
    var clean = String(email || '').trim();
    if (!clean || !CFG.product) return Promise.resolve('notfound');
    var current = getLicense();
    return fetchLatestOnce(clean).then(function (out) {
      if (!(out.found && out.license)) return 'notfound';
      var fresh = out.license;
      if (!structurallyValid(fresh)) return 'notfound';
      // só sobrescreve quando é de fato uma RENOVAÇÃO (exp mais recente)
      if (current && String(current.exp || '') >= String(fresh.exp || '') && current.sig === fresh.sig) {
        return 'notfound';
      }
      if (CFG.verifyKey) {
        return hmacVerify(canonicalPayload(fresh), fresh.sig).then(function (ok) {
          if (!ok) return 'notfound';
          acceptLicense(fresh, function () {});
          return 'accepted';
        });
      }
      // sem verifyKey: HTTPS da nossa API é autoritativo (mesma regra do polling)
      acceptLicense(fresh, function () {});
      setEntitlement({ paymentId: out.paymentId || null, email: fresh.email });
      return 'accepted';
    }).catch(function () {
      return 'error';
    });
  }

  /**
   * Renovação/recuperação por EMAIL (assinaturas): busca a licença mais
   * recente deste email+produto. Cobre dois casos:
   *  - automático no boot com o email já conhecido da máquina (renovou em
   *    outro dispositivo e volta neste);
   *  - explícito via PayModule.renew(email) — máquina NOVA, onde nenhum
   *    estado local existe (fluxo "já paguei: recuperar licença").
   */
  function renewFromLatest(explicitEmail) {
    var ent = getEntitlement();
    var lic = getLicense();
    var email = explicitEmail || (ent && ent.email) || (lic && lic.email);
    return renewByEmail(email).then(function (outcome) {
      if (outcome === 'accepted') return true;
      return resumeFromStorage();
    }).catch(function () {
      return resumeFromStorage(); // rede caiu -> comportamento offline normal
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
    // v4: painel reflete o estado JÁ PERSISTIDO antes de qualquer fluxo
    // async (sem licença = painel escondido; com licença em cache = mostra
    // na hora, mesmo que a revalidação online demore ou diga notfound)
    renderStatusPanel(licenseStatus(getLicense(), todayISO()));
    bindButtons();
    var pending = getPending();
    if (pending && !getLicense()) {
      // pós-checkout: polling pela licença desta cobrança
      pollUntilLicensed(function () {});
      return;
    }
    resumeFromStorage().then(function (unlocked) {
      if (!unlocked && getPending()) pollUntilLicensed(function () {});
    });
    // assinaturas: busca renovação mais recente do email em paralelo
    renewFromLatest().then(function () {});
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
    renew: function (email) { return renewFromLatest(email); },
    state: function () {
      var lic = getLicense();
      // v4: estado derivado completo (painel e apps consomem daqui)
      return Object.assign(
        { product: CFG.product },
        licenseStatus(lic, todayISO())
      );
    },
    signOut: function () { clearLicense(); clearPending(); applyState(false, null); },
  };
})();
