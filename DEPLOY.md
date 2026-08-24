# chr-z.dev

Personal site & portfolio of **Christian Eliel** — software engineer.
100% static (HTML/CSS/vanilla JS), zero runtime dependencies, zero trackers.
Hospeda também a **API central de pagamentos** da fábrica (`/api/*` via
Cloudflare Pages Functions — ver `functions/api/[[route]].js` e README do
pay-module em saas_factory).

## Pages

| Route            | Purpose                                            |
| ---------------- | -------------------------------------------------- |
| `/`              | Hero, about, selected work, Solaris strip, CTA     |
| `portfolio.html` | All products (14 SaaS + Solaris) with live links   |
| `solaris.html`   | Dedicated case study (~6.5× throughput, v2 rebuild)|
| `contact.html`   | Direct email + GitHub (no third-party forms)       |

## Local validation

```bash
python -m http.server 8899
# then check each route returns 200:
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8899/
```

CI runs on every push: HTML structure checks, internal link validation,
i18n EN/PT-BR key parity, secret-scan and JS syntax check.

## Deploy (Cloudflare Pages)

**Status: pipeline ACTIVE.** Every push to `main` publishes automatically to
Cloudflare Pages via `.github/workflows/deploy.yml` → live at
**https://chrz-dev.pages.dev** (secrets `CLOUDFLARE_API_TOKEN` +
`CLOUDFLARE_ACCOUNT_ID` and repo variable `CLOUDFLARE_ENABLED=true` are
already configured).

## Custom domains: ACTIVE

`chr-z.dev` and `www.chr-z.dev` are attached to the Pages project with
status **active** — https://chr-z.dev serves this site (verified 2026-08-24:
all routes HTTP 200, security headers present, CI+Deploy green).
Email Routing (MX route{1,2,3}.mx.cloudflare.net) is untouched.

### Manual deploy from a machine with wrangler

```bash
export CLOUDFLARE_API_TOKEN=<token>
export CLOUDFLARE_ACCOUNT_ID=<account id>
npx wrangler pages deploy . --project-name=chrz-dev --branch=main
```

## Security posture

- CSP `default-src 'self'`, no inline scripts, no third-party origins (`_headers`)
- HSTS, nosniff, strict referrer policy, minimal Permissions-Policy
- No analytics, no cookies beyond a local-only language preference
