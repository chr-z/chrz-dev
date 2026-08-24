/* chr-z.dev — vanilla JS only. i18n EN/PT-BR, reveal-on-scroll, year.
   No analytics, no external calls. CSP: script-src 'self'. */
(function () {
  'use strict';

  document.documentElement.classList.add('js-enabled');

  /* ---------- i18n dictionaries (key parity enforced by CI) ---------- */
  var I18N = {
    en: {
      'a11y.skip': 'Skip to content',
      'nav.home': 'Home', 'nav.portfolio': 'Portfolio', 'nav.solaris': 'Solaris', 'nav.contact': 'Contact',
      'hero.badge': 'Available for freelance & full-time',
      'hero.h1a': 'I build software that', 'hero.h1b': 'ships.',
      'hero.sub': "Software engineer (fullstack & data science). I designed, built and deployed 14 production web apps solo — offline-capable, bilingual, tested, deployed by CI, on hardened zero-cost infrastructure.",
      'hero.cta.work': 'See the work', 'hero.cta.contact': 'Get in touch',
      'stats.apps.label': 'apps in production', 'stats.deps.label': 'runtime dependencies', 'stats.langs.label': 'languages, out of the box',
      'about.kicker': 'About',
      'about.title': 'Engineer mindset, product delivery',
      'about.p1': "I'm Christian Eliel — fullstack developer with a data science background. I treat every project as a product: real users, real constraints, measurable results. My stack is deliberately boring where it matters (vanilla, standards-first) and modern where it pays (PWA, CI/CD, edge hosting).",
      'about.p2': "Everything on this site — including this site — runs on a free tier with strict Content-Security-Policy, no trackers, no third-party scripts, and automated validation on every push. Security and cost discipline aren't features; they're defaults.",
      'about.skills.title': 'Toolbox',
      'featured.kicker': 'Selected work',
      'featured.title': 'Products people can use today',
      'featured.viewall': 'View full portfolio →',
      'home.solaris.kicker': 'Flagship case study',
      'home.solaris.title': 'Solaris A/V Engine — ≈6.5× throughput',
      'home.solaris.text': 'Automated audio-visual quality control for long-form content. The v2 rebuild cut analysis time dramatically, added offline PWA support, exportable QC reports and local-first Pro licensing — with an on-premise desktop option.',
      'home.solaris.cta': 'Read the case study',
      'cta.title': 'Need someone who ships?',
      'cta.sub': 'Freelance projects, contracts and full-time roles. Fast replies, working software, no drama.',
      'cta.button': 'Start a conversation',
      'footer.tag': 'built by hand, zero trackers, zero budget.',
      'footer.rights': 'All rights reserved.',
      'pf.kicker': 'Portfolio',
      'pf.title': 'Shipped, live & maintained',
      'pf.sub': 'Every app below was designed, built, tested and deployed end-to-end by one engineer. Shared DNA: installable PWA, offline-first, English + Portuguese, automated tests, green CI on every push, MIT licensed.',
      'pf.group.saas': 'Micro-SaaS suite',
      'pf.group.flagship': 'Flagship',
      'pf.note': 'All products run on free-tier infrastructure (GitHub Pages) — proof of the cost discipline I bring to client projects.',
      'pf.solaris.desc': 'Automated audio-visual QC platform. v2 rebuild: ≈6.5× throughput, offline PWA, exportable QC reports, local-first Pro licensing, on-premise desktop option.',
      'pf.solaris.link': 'Read the case study →',
      'sol.kicker': 'Case study',
      'sol.title1': 'Solaris', 'sol.title2': 'A/V Engine',
      'sol.sub': "Automated quality control for long-form audio-visual content: it watches the video so humans don't have to — flagging dead air, broken audio, missing segments and inconsistencies, then exporting a review-ready QC report.",
      'sol.cta.try': 'Open live app →', 'sol.cta.ask': 'Ask about deployment',
      'sol.stat.throughput': 'analysis throughput vs. the previous build',
      'sol.stat.tests': 'automated tests (Vitest) green in CI',
      'sol.stat.offline': 'offline-capable after first load (PWA)',
      'sol.problem.kicker': 'The problem',
      'sol.problem.title': 'QC of long videos eats hours of skilled work',
      'sol.problem.p1': 'Reviewing hours-long recordings for technical defects is slow, repetitive and error-prone. Teams either skip it (and ship embarrassing glitches) or burn analyst time watching footage at real speed.',
      'sol.solution.kicker': 'The solution — v2 rebuild',
      'sol.solution.title': 'What changed from v1 to v2',
      'sol.f1.t': '≈6.5× faster analysis.', 'sol.f1.d': 'Restructured pipeline with code-splitting and smarter row filtering cut wall-clock time per file dramatically.',
      'sol.f2.t': 'Offline PWA.', 'sol.f2.d': 'Installable, works without a connection after first load — field-proof for studio and travel use.',
      'sol.f3.t': 'Exportable QC reports.', 'sol.f3.d': 'One click produces a structured report reviewers can archive or share.',
      'sol.f4.t': 'Presets & shortcuts.', 'sol.f4.d': 'Repeatable configurations and keyboard shortcuts for power users.',
      'sol.f5.t': 'A/B comparison.', 'sol.f5.d': 'Side-by-side runs to validate settings before committing to a full batch.',
      'sol.f6.t': 'Local-first Pro licensing.', 'sol.f6.d': 'License validation runs locally — no phone-home, no vendor lock-in, privacy-friendly.',
      'sol.f7.t': 'i18n EN/PT-BR + accessibility pass.', 'sol.f7.d': 'Bilingual UI with focus-visible navigation, reduced-motion support and screen-reader semantics.',
      'sol.deploy.kicker': 'Deployment options',
      'sol.deploy.title': 'Cloud today, on-premise tomorrow',
      'sol.opt.cloud.t': 'Hosted web app',
      'sol.opt.cloud.d': 'Runs in the browser at solaris-av-engine.vercel.app. Nothing to install; updates are automatic.',
      'sol.opt.onprem.t': 'On-premise desktop (Tauri)',
      'sol.opt.onprem.d': 'For studios that need footage to never leave the machine: a native desktop wrapper keeps processing fully local. Available as a custom engagement.',
      'sol.cta.sub': 'Want Solaris deployed for your team, or something like it built? Talk to me directly.',
      'ct.kicker': 'Contact',
      'ct.title': 'Talk to me directly',
      'ct.sub': 'No contact forms, no third-party processors, no tracking pixels. Your message goes straight to my inbox — replies usually within one business day.',
      'ct.email.t': 'Email', 'ct.email.d': 'Best for project briefs, quotes and job offers.', 'ct.email.btn': 'christian@chr-z.dev',
      'ct.github.d': 'Code, issues and open-source work. See everything I ship.', 'ct.github.btn': 'github.com/chr-z →',
      'ct.goodfit.kicker': 'Good fit',
      'ct.goodfit.title': 'What I take on',
      'ct.fit1': 'Freelance web apps & internal tools — scoped, shipped, documented.',
      'ct.fit2': 'Client-side SaaS builds: fast, offline-capable, zero server cost.',
      'ct.fit3': 'Automation & data pipelines in Python.',
      'ct.fit4': 'Full-time / long-term engineering roles where shipping matters.'
    },
    pt: {
      'a11y.skip': 'Pular para o conteúdo',
      'nav.home': 'Início', 'nav.portfolio': 'Portfólio', 'nav.solaris': 'Solaris', 'nav.contact': 'Contato',
      'hero.badge': 'Disponível para freelance e CLT/PJ',
      'hero.h1a': 'Eu construo software que', 'hero.h1b': 'entrega.',
      'hero.sub': 'Engenheiro de software (fullstack & ciência de dados). Projetei, construí e publiquei 14 apps web em produção sozinho — offline, bilíngues, testados, publicados por CI, em infraestrutura gratuita e endurecida.',
      'hero.cta.work': 'Ver os projetos', 'hero.cta.contact': 'Falar comigo',
      'stats.apps.label': 'apps em produção', 'stats.deps.label': 'dependências de runtime', 'stats.langs.label': 'idiomas de fábrica',
      'about.kicker': 'Sobre',
      'about.title': 'Mentalidade de engenharia, entrega de produto',
      'about.p1': 'Sou Christian Eliel — desenvolvedor fullstack com base em ciência de dados. Trato cada projeto como produto: usuários reais, restrições reais, resultados mensuráveis. Minha stack é propositalmente simples onde importa (vanilla, padrões web) e moderna onde compensa (PWA, CI/CD, hospedagem de borda).',
      'about.p2': 'Tudo neste site — incluindo o próprio site — roda em free tier com Content-Security-Policy restritiva, sem trackers, sem scripts de terceiros, e validação automatizada a cada push. Segurança e disciplina de custo não são recursos; são o padrão.',
      'about.skills.title': 'Caixa de ferramentas',
      'featured.kicker': 'Trabalhos selecionados',
      'featured.title': 'Produtos que dá pra usar hoje',
      'featured.viewall': 'Ver portfólio completo →',
      'home.solaris.kicker': 'Estudo de caso principal',
      'home.solaris.title': 'Solaris A/V Engine — ≈6,5× mais throughput',
      'home.solaris.text': 'Controle de qualidade audiovisual automatizado pra conteúdo longo. A reconstrução v2 cortou drasticamente o tempo de análise, adicionou PWA offline, relatórios QC exportáveis e licenciamento Pro local-first — com opção desktop on-premise.',
      'home.solaris.cta': 'Ler o estudo de caso',
      'cta.title': 'Precisa de alguém que entrega?',
      'cta.sub': 'Projetos freelance, contratos e vagas efetivas. Resposta rápida, software funcionando, sem drama.',
      'cta.button': 'Começar uma conversa',
      'footer.tag': 'feito à mão, sem trackers, sem orçamento.',
      'footer.rights': 'Todos os direitos reservados.',
      'pf.kicker': 'Portfólio',
      'pf.title': 'Entregues, no ar e mantidos',
      'pf.sub': 'Cada app abaixo foi projetado, construído, testado e publicado de ponta a ponta por um único engenheiro. DNA comum: PWA instalável, offline-first, inglês + português, testes automatizados, CI verde a cada push, licença MIT.',
      'pf.group.saas': 'Suíte micro-SaaS',
      'pf.group.flagship': 'Principal',
      'pf.note': 'Todos os produtos rodam em infraestrutura gratuita (GitHub Pages) — prova da disciplina de custo que eu levo pra projetos de clientes.',
      'pf.solaris.desc': 'Plataforma de QC audiovisual automatizado. Reconstrução v2: ≈6,5× throughput, PWA offline, relatórios QC exportáveis, licenciamento Pro local-first, opção desktop on-premise.',
      'pf.solaris.link': 'Ler o estudo de caso →',
      'sol.kicker': 'Estudo de caso',
      'sol.title1': 'Solaris', 'sol.title2': 'A/V Engine',
      'sol.sub': 'Controle de qualidade automatizado pra conteúdo audiovisual longo: assiste ao vídeo pra você não precisar — sinalizando silêncio morto, áudio quebrado, trechos faltantes e inconsistências, e exportando um relatório QC pronto pra revisão.',
      'sol.cta.try': 'Abrir o app →', 'sol.cta.ask': 'Perguntar sobre deploy',
      'sol.stat.throughput': 'de throughput de análise vs. a build anterior',
      'sol.stat.tests': 'testes automatizados (Vitest) verdes no CI',
      'sol.stat.offline': 'funciona offline após o primeiro load (PWA)',
      'sol.problem.kicker': 'O problema',
      'sol.problem.title': 'QC de vídeo longo consome horas de trabalho especializado',
      'sol.problem.p1': 'Rever gravações de horas atrás de defeitos técnicos é lento, repetitivo e sujeito a erro. Ou o time pula a etapa (e publica defeitos vergonhosos) ou queima horas de analista assistindo na velocidade real.',
      'sol.solution.kicker': 'A solução — reconstrução v2',
      'sol.solution.title': 'O que mudou da v1 pra v2',
      'sol.f1.t': 'Análise ≈6,5× mais rápida.', 'sol.f1.d': 'Pipeline reestruturado com code-splitting e filtragem de linhas mais esperta derrubou o tempo por arquivo.',
      'sol.f2.t': 'PWA offline.', 'sol.f2.d': 'Instalável, funciona sem conexão após o primeiro load — à prova de estúdio e viagem.',
      'sol.f3.t': 'Relatórios QC exportáveis.', 'sol.f3.d': 'Um clique gera relatório estruturado que revisores podem arquivar ou compartilhar.',
      'sol.f4.t': 'Presets e atalhos.', 'sol.f4.d': 'Configurações repetíveis e atalhos de teclado pra usuários avançados.',
      'sol.f5.t': 'Comparação A/B.', 'sol.f5.d': 'Rodadas lado a lado pra validar configurações antes do batch completo.',
      'sol.f6.t': 'Licenciamento Pro local-first.', 'sol.f6.d': 'Validação da licença roda local — sem telefone pra casa, sem lock-in, friendly à privacidade.',
      'sol.f7.t': 'i18n EN/PT-BR + acessibilidade.', 'sol.f7.d': 'Interface bilíngue com navegação por foco visível, suporte a reduced-motion e semântica pra leitores de tela.',
      'sol.deploy.kicker': 'Opções de implantação',
      'sol.deploy.title': 'Nuvem hoje, on-premise amanhã',
      'sol.opt.cloud.t': 'App web hospedado',
      'sol.opt.cloud.d': 'Roda no navegador em solaris-av-engine.vercel.app. Nada pra instalar; atualizações automáticas.',
      'sol.opt.onprem.t': 'Desktop on-premise (Tauri)',
      'sol.opt.onprem.d': 'Pra estúdios que precisam que a mídia nunca saia da máquina: um wrapper desktop nativo mantém o processamento 100% local. Disponível como projeto sob medida.',
      'sol.cta.sub': 'Quer o Solaris implantado pro seu time, ou algo parecido construído? Fala direto comigo.',
      'ct.kicker': 'Contato',
      'ct.title': 'Fale direto comigo',
      'ct.sub': 'Sem formulários, sem processadores de terceiros, sem pixels de rastreio. Sua mensagem vai direto pra minha caixa de entrada — respondo geralmente em até um dia útil.',
      'ct.email.t': 'E-mail', 'ct.email.d': 'Melhor pra briefings, orçamentos e propostas de emprego.', 'ct.email.btn': 'christian@chr-z.dev',
      'ct.github.d': 'Código, issues e open source. Veja tudo que eu entrego.', 'ct.github.btn': 'github.com/chr-z →',
      'ct.goodfit.kicker': 'Fit',
      'ct.goodfit.title': 'O que eu aceito fazer',
      'ct.fit1': 'Apps web freelance e ferramentas internas — escopo fechado, entregue e documentado.',
      'ct.fit2': 'SaaS client-side: rápido, offline-capable, custo zero de servidor.',
      'ct.fit3': 'Automação e pipelines de dados em Python.',
      'ct.fit4': 'Vagas efetivas / longo prazo onde entrega importa.'
    }
  };

  var LANG_KEY = 'chrz-lang';

  function detectLang() {
    try {
      var saved = localStorage.getItem(LANG_KEY);
      if (saved === 'en' || saved === 'pt') return saved;
    } catch (e) { /* storage blocked */ }
    return (navigator.language || 'en').toLowerCase().indexOf('pt') === 0 ? 'pt' : 'en';
  }

  function applyLang(lang) {
    var dict = I18N[lang] || I18N.en;
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute('data-i18n');
      if (Object.prototype.hasOwnProperty.call(dict, key)) nodes[i].textContent = dict[key];
    }
    document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en';
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* ignore */ }
    var buttons = document.querySelectorAll('.lang-btn');
    for (var j = 0; j < buttons.length; j++) {
      buttons[j].setAttribute('aria-pressed', buttons[j].getAttribute('data-lang') === lang ? 'true' : 'false');
    }
  }

  var initialLang = detectLang();
  applyLang(initialLang);

  document.addEventListener('click', function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('.lang-btn') : null;
    if (btn) applyLang(btn.getAttribute('data-lang'));
  });

  /* ---------- Active nav link ---------- */
  var path = location.pathname.split('/').pop() || 'index.html';
  var links = document.querySelectorAll('.nav-links a[data-nav]');
  var map = { 'index.html': 'home', 'portfolio.html': 'portfolio', 'solaris.html': 'solaris', 'contact.html': 'contact' };
  var current = map[path];
  for (var k = 0; k < links.length; k++) {
    if (links[k].getAttribute('data-nav') === current) links[k].setAttribute('aria-current', 'page');
  }

  /* ---------- Reveal on scroll (respects reduced motion via CSS) ---------- */
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('reveal-in');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    document.querySelectorAll('.reveal').forEach(function (el) { io.observe(el); });
  } else {
    document.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('reveal-in'); });
  }

  /* ---------- Footer year ---------- */
  var yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());
})();
