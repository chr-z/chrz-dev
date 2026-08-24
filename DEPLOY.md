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

The project is published to Cloudflare Pages (`chrz-dev.chrz-dev.pages.dev`
style subdomain) with the custom domain **https://chr-z.dev** attached.

### Option A — GitHub Actions (automatic)

Requires two repository secrets (Settings → Secrets and variables → Actions):

- `CLOUDFLARE_API_TOKEN` — API token with **Cloudflare Pages Edit** permission
  (create at dash.cloudflare.com/profile/api-tokens).
- `CLOUDFLARE_ACCOUNT_ID` — visible on any account page in the dashboard.

With those present, every push to `main` deploys automatically via
`.github/workflows/deploy.yml`.

### Option B — Connect to Git (dashboard)

1. dash.cloudflare.com → Workers & Pages → Create → **Connect to Git**
2. Select this repo, framework preset **None**, output dir `/` (root),
   production branch `main`.

Either way, first-time setup also needs the custom domain:

1. Pages project → **Custom domains** → add `chr-z.dev`
2. Cloudflare creates the DNS records automatically (zone already hosted here).

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
