# chr-z.dev

Personal site & portfolio of **Christian Eliel** — software engineer.
100% static (HTML/CSS/vanilla JS), zero runtime dependencies, zero trackers.

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

### Remaining manual step: point chr-z.dev at the project

Custom domains `chr-z.dev` and `www.chr-z.dev` are attached to the Pages
project but stuck in `pending`: the apex DNS record still points to a
Hostinger parking IP (`84.32.84.32`). The automation token has Pages Edit
but not DNS Edit, so this one-time fix needs the dashboard:

**Easiest:** dash.cloudflare.com → Workers & Pages → `chrz-dev` →
Custom domains → click **Activate / Retry validation** on both
`chr-z.dev` and `www.chr-z.dev` (Cloudflare fixes the records itself).

**Or manually in DNS → Records:**

1. Delete the `A` record `chr-z.dev → 84.32.84.32`.
2. Create `CNAME chr-z.dev → chrz-dev.pages.dev` (Proxied).
3. Edit `CNAME www.chr-z.dev → chrz-dev.pages.dev` (Proxied).

Email Routing (MX route{1,2,3}.mx.cloudflare.net) is untouched by all of
the above. Validation is HTTP-based and completes within minutes after the
records change; https://chr-z.dev then serves this site.

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
