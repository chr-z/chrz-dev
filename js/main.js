/* chr-z.dev — vanilla JS only. i18n EN/PT-BR, reveal-on-scroll, year.
   No analytics, no external calls. CSP: script-src 'self'. */
(function () {
  'use strict';

  document.documentElement.classList.add('js-enabled');

  /* ---------- i18n dictionaries (key parity enforced by CI) ---------- */
  var I18N = {
    en: {
      'a11y.skip': 'Skip to content',
      'nav.home': 'Home', 'nav.portfolio': 'Work', 'nav.solaris': 'Solaris', 'nav.contact': 'Contact',
      'hero.badge': 'Available for full-time & contract — remote',
      'hero.h1a': 'I build software that', 'hero.h1b': 'ships.',
      'hero.sub': 'Mobile and full stack developer. Product from zero to production: a magazine app live on the App Store and Google Play, an audio-visual QC engine running in production, and automation and integrations over WordPress, Google Cloud and Cloudflare.',
      'hero.cta.work': 'See the work', 'hero.cta.contact': 'Get in touch',
      'about.kicker': 'About',
      'about.title': 'Engineer mindset, product delivery',
      'about.p1': 'I\'m Christian Eliel — mobile and full stack developer, with a postgraduate degree in Data Science. I treat every project as a product: real users, real constraints, measurable results. I like owning the whole path — architecture, code, integration, deploy, and the part nobody wants (store review, monitoring, maintenance).',
      'about.p2': 'Everything I put in production — including this site — runs on free-tier infrastructure with a strict Content-Security-Policy, no trackers and automated validation on every push. Cost and security discipline aren\'t features to me; they\'re defaults.',
      'about.skills.title': 'Toolbox',
      'work.kicker': 'Also in production',
      'work.title': 'Systems that are running right now',
      'work.viewall': 'See everything →',
      'app.kicker': 'Live in both stores',
      'app.title': 'ZIMNY — mobile app, iOS + Android',
      'app.sub': 'A magazine app taken end to end: architecture, implementation, publishing and maintenance in both stores.',
      'app.b1': 'React Native / Expo SDK 57 · React 19 · TypeScript',
      'app.b2': 'Push in production: FCM v1 (Android) and APNs (iOS), segmented by language',
      'app.b3': 'Trilingual PT/EN/ES, content reader with infinite scroll and offline reading',
      'app.b4': 'Custom WordPress REST backend and an automated release pipeline',
      'app.code': 'Code sample →',
      'work.noite.p': 'Contest platform for a magazine: landing page, lead capture, dedupe and scoring, transactional email.',
      'work.snap.p': 'Media ingest as a service: yt-dlp + ffmpeg engine, worker queue, live progress, signed delivery links.',
      'work.admin.p': 'WordPress plugin suite that drives the magazine app: custom types, REST endpoints, push, ads, PT/EN/ES translation.',
      'home.solaris.kicker': 'Flagship case study',
      'home.solaris.title': 'Solaris A/V Engine — ≈6.5× throughput',
      'home.solaris.text': 'Automated audio-visual quality control for long-form content, deployed in an EdTech pipeline that delivers thousands of hours a month. Real-time scopes in the browser, byte-range streaming proxy, optimistic locking for multi-analyst queues, 129 tests.',
      'home.solaris.cta': 'Read the case study',
      'cta.title': 'Need someone who ships?',
      'cta.sub': 'Contracts and full-time roles. Fast replies, working software, no drama.',
      'cta.button': 'Start a conversation',
      'footer.tag': 'built by hand, zero trackers, zero budget.',
      'footer.rights': 'All rights reserved.',
      'pf.kicker': 'Work',
      'pf.title': 'What I built and where it runs',
      'pf.sub': 'Products and systems in production, plus a lab of experiments. Every card links to something you can open and check for yourself — a store listing, a live deployment or the source code.',
      'pf.solaris.desc': 'Audio-visual QC in the browser, deployed in an EdTech pipeline that delivers thousands of hours of content per month: real-time RGB Parade, Waveform and Vectorscope on Canvas, byte-range streaming proxy, optimistic locking for multi-analyst queues, 129 tests in CI.',
      'pf.solaris.link': 'Case study →',
      'pf.group.app': 'Live in both stores',
      'pf.app.title': 'mobile app, iOS + Android',
      'pf.app.desc': 'Magazine app: content reader with infinite scroll, clock-synced linear stream, offline reading, push notifications (FCM v1 + APNs) and trilingual PT/EN/ES on a custom WordPress REST backend. Taken end to end, including Apple and Google review.',
      'pf.app.code': 'code sample ↗',
      'pf.group.prod': 'In production',
      'pf.noite.desc': 'Contest platform for a magazine: landing page, lead capture with dedupe and scoring, transactional email and deploy pipeline.',
      'pf.admin.desc': 'WordPress plugin suite that drives the magazine app: custom post types, REST endpoints, push notifications, advertising and PT/EN/ES translation.',
      'pf.snap.desc': 'Media ingest as a service: yt-dlp + ffmpeg engine, FastAPI API, Celery workers, progress over SSE, signed delivery links, quotas and abuse controls.',
      'pf.forge.desc': 'Serverless Telegram bots on Cloudflare Workers with a shared TypeScript core — transcription, media tooling and credit handling.',
      'pf.code': 'source ↗',
      'pf.group.lab': 'Lab — experiments',
      'pf.lab.note': 'Small offline-first tools, each one wrapping a real engine written in another language (OCaml, Prolog, COBOL, Fortran, Zig, Lua, Nim…) and compiled to WASM or JS. These are learning experiments, not products — the repositories report JavaScript because that is the compiled output.',
      'pf.lab.open': 'Open the list (~20 tools)',
      'pf.lab.repos': 'All repositories on GitHub →',
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
      'sol.opt.cloud.d': 'Runs in the browser at solaris.chr-z.dev. Nothing to install; updates are automatic.',
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
      'nav.home': 'Início', 'nav.portfolio': 'Trabalho', 'nav.solaris': 'Solaris', 'nav.contact': 'Contato',
      'hero.badge': 'Disponível para CLT e contrato — remoto',
      'hero.h1a': 'Eu construo software que', 'hero.h1b': 'entrega.',
      'hero.sub': 'Desenvolvedor mobile e full stack. Produto do zero à produção: um app de revista no ar na App Store e no Google Play, um motor de controle de qualidade audiovisual em produção, e automação e integrações sobre WordPress, Google Cloud e Cloudflare.',
      'hero.cta.work': 'Ver os projetos', 'hero.cta.contact': 'Falar comigo',
      'about.kicker': 'Sobre',
      'about.title': 'Mentalidade de engenharia, entrega de produto',
      'about.p1': 'Sou Christian Eliel — desenvolvedor mobile e full stack, com pós-graduação em Ciência de Dados. Trato cada projeto como produto: usuários reais, restrições reais, resultado mensurável. Gosto de assumir o caminho inteiro — arquitetura, código, integração, deploy, e a parte que ninguém quer (review de loja, monitoramento, manutenção).',
      'about.p2': 'Tudo que coloco em produção — incluindo este site — roda em infraestrutura de plano gratuito, com Content-Security-Policy estrita, sem rastreadores e validação automatizada em cada push. Disciplina de custo e de segurança não é recurso pra mim; é padrão.',
      'about.skills.title': 'Caixa de ferramentas',
      'work.kicker': 'Também em produção',
      'work.title': 'Sistemas que estão rodando agora',
      'work.viewall': 'Ver tudo →',
      'app.kicker': 'No ar nas duas lojas',
      'app.title': 'ZIMNY — app mobile, iOS + Android',
      'app.sub': 'App de revista conduzido de ponta a ponta: arquitetura, implementação, publicação e manutenção nas duas lojas.',
      'app.b1': 'React Native / Expo SDK 57 · React 19 · TypeScript',
      'app.b2': 'Push em produção: FCM v1 (Android) e APNs (iOS), segmentado por idioma',
      'app.b3': 'Trilíngue PT/EN/ES, leitor de conteúdo com scroll infinito e leitura offline',
      'app.b4': 'Backend WordPress REST próprio e pipeline de release automatizado',
      'app.code': 'Ver o código →',
      'work.noite.p': 'Plataforma de concurso para uma revista: landing page, captura de leads, dedupe e score, e-mail transacional.',
      'work.snap.p': 'Ingestão de mídia como serviço: motor yt-dlp + ffmpeg, fila de workers, progresso ao vivo e links de entrega assinados.',
      'work.admin.p': 'Suíte de plugins WordPress que move o app da revista: tipos personalizados, endpoints REST, push, publicidade e tradução PT/EN/ES.',
      'home.solaris.kicker': 'Estudo de caso principal',
      'home.solaris.title': 'Solaris A/V Engine — ≈6,5× mais throughput',
      'home.solaris.text': 'Controle de qualidade audiovisual automatizado para conteúdo longo, implantado no pipeline de uma EdTech que entrega milhares de horas por mês. Escopos em tempo real no navegador, proxy de streaming com byte-range, lock otimista para filas multi-analista, 129 testes.',
      'home.solaris.cta': 'Ler o estudo de caso',
      'cta.title': 'Precisa de alguém que entrega?',
      'cta.sub': 'Projetos freelance, contratos e vagas efetivas. Resposta rápida, software funcionando, sem drama.',
      'cta.button': 'Começar uma conversa',
      'footer.tag': 'feito à mão, sem trackers, sem orçamento.',
      'footer.rights': 'Todos os direitos reservados.',
      'pf.kicker': 'Trabalho',
      'pf.title': 'O que construí e onde roda',
      'pf.sub': 'Produtos e sistemas em produção, mais um laboratório de experimentos. Cada card leva a algo que você pode abrir e conferir — a ficha na loja, o deploy ao vivo ou o código.',
      'pf.solaris.desc': 'Controle de qualidade audiovisual no navegador, implantado no pipeline de uma EdTech que entrega milhares de horas de conteúdo por mês: RGB Parade, Waveform e Vectorscope em tempo real no Canvas, proxy de streaming com byte-range, lock otimista para filas multi-analista e 129 testes no CI.',
      'pf.solaris.link': 'Estudo de caso →',
      'pf.group.app': 'No ar nas duas lojas',
      'pf.app.title': 'app mobile, iOS + Android',
      'pf.app.desc': 'App de revista: leitor de conteúdo com scroll infinito, transmissão linear sincronizada pelo relógio do servidor, leitura offline, push (FCM v1 + APNs) e trilíngue PT/EN/ES sobre backend WordPress REST próprio. Conduzido de ponta a ponta, incluindo o review da Apple e do Google.',
      'pf.app.code': 'amostra do código ↗',
      'pf.group.prod': 'Em produção',
      'pf.noite.desc': 'Plataforma de concurso para uma revista: landing page, captura de leads com dedupe e score, e-mail transacional e pipeline de deploy.',
      'pf.admin.desc': 'Suíte de plugins WordPress que move o app da revista: tipos personalizados, endpoints REST, push, publicidade e tradução PT/EN/ES.',
      'pf.snap.desc': 'Ingestão de mídia como serviço: motor yt-dlp + ffmpeg, API FastAPI, workers Celery, progresso por SSE, links de entrega assinados, quotas e controle de abuso.',
      'pf.forge.desc': 'Bots de Telegram serverless em Cloudflare Workers com núcleo TypeScript compartilhado — transcrição, ferramentas de mídia e gestão de créditos.',
      'pf.code': 'código ↗',
      'pf.group.lab': 'Laboratório — experimentos',
      'pf.lab.note': 'Ferramentas pequenas e offline-first, cada uma embrulhando um motor real escrito em outra linguagem (OCaml, Prolog, COBOL, Fortran, Zig, Lua, Nim…) compilado para WASM ou JS. São experimentos de aprendizado, não produtos — os repositórios aparecem como JavaScript porque é o output compilado.',
      'pf.lab.open': 'Abrir a lista (~20 ferramentas)',
      'pf.lab.repos': 'Todos os repositórios no GitHub →',
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
      'sol.opt.cloud.d': 'Roda no navegador em solaris.chr-z.dev. Nada pra instalar; atualizações automáticas.',
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
