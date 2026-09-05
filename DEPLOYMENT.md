# PFE Hunter - Deployment Guide

Complete guide to deploy PFE Hunter using 100% free tools.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Cloudflare     │────▶│  Node.js API     │────▶│  Supabase       │
│  Pages          │     │  (Render/Koyeb)  │     │  Postgres       │
│  (Frontend)     │     │  (Backend)       │     │  (Database)     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                        ▲
                                                        │
                        ┌──────────────────┐            │
                        │  GitHub Actions  │────────────┘
                        │  (Scraper/Cron)  │
                        └──────────────────┘
```

## Step 1: Supabase Setup (Database)

1. Go to [supabase.com](https://supabase.com) and create a free account
2. Create a new project
3. Go to **Connect**
4. Select **Transaction pooler** as the Connection Method
5. Copy the **Connection string** (URI format)
6. Add `?sslmode=require` to the end:
   ```
   postgres://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres?sslmode=require
   ```

### Save as GitHub Secret:
- Go to your repo → **Settings → Secrets and variables → Actions**
- Add secret: `DATABASE_URL` = your connection string

## Step 2: GitHub Repository Setup

### 2.1 Clone the project

Clone the repository into a local folder. The cloned project already contains
its Git history, so you do not need to run `git init`.

```bash
git clone https://github.com/KanounDev/pfe_hunter.git
cd pfe_hunter
```

### 2.2 Create your own GitHub repository (optional)

If you want to maintain your own copy and GitHub Actions workflows, create a
new empty repository first, then point the cloned project to it:

```bash
gh auth login
gh repo create my-pfe-hunter --public --source=. --remote=origin --push
```

Replace `my-pfe-hunter` with your preferred repository name. The `--push`
option uploads the cloned project to your new repository. If you only want to
use the original repository, skip this step.

Before pushing, verify that local environment files are not tracked:

```bash
git status
git check-ignore .env dashboard/.env
```

Never commit API keys, database passwords, service-role keys, webhook URLs, or
CV files. Configure your own values as GitHub Actions secrets in the next step.

### 2.3 Add Required Secrets

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Description |
|--------|-------------|
| `DATABASE_URL` | Supabase connection string (with `?sslmode=require`) |
| `GEMINI_API_KEY` | Your Google Gemini API key |
| `SUPABASE_URL` | Supabase project URL used to access CV Storage |
| `SUPABASE_SERVICE_KEY` | Supabase service-role key used by GitHub Actions to download the active CV from Storage |
| `API_TOKEN` | Token for API authentication |

## Step 3: Frontend Deployment (Cloudflare Pages)

### 3.1 Build the Dashboard
```bash
cd dashboard
npm install
npm run build
```

### 3.2 Deploy to Cloudflare Pages

1. Go to [pages.cloudflare.com](https://pages.cloudflare.com)
2. Click **Create a project → Connect to Git**
3. Select your `pfe-hunter` repository
4. Configure:
   - **Framework preset:** Vite
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
   - **Root directory:** `dashboard`

### 3.3 Set Environment Variables

In Cloudflare Pages → Settings → Environment variables:

| Variable | Value |
|----------|-------|
| `VITE_API_URL` | `https://your-api.onrender.com/api` |
| `VITE_API_TOKEN` | Optional local-development fallback; production access uses `?token=YOUR_TOKEN` |

## Step 4: Backend Deployment (Render)

### 4.1 Create Render Account

1. Go to [render.com](https://render.com) and sign up
2. Connect your GitHub account

### 4.2 Create Web Service

1. Click **New → Web Service**
2. Select your `pfe-hunter` repository
3. Configure:
   - **Name:** `pfe-hunter-api`
   - **Region:** Choose closest to you
   - **Branch:** `main`
   - **Runtime:** Docker
   - **Dockerfile Path:** `./Dockerfile.api`

### 4.3 Set Environment Variables

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | Your Supabase connection string |
| `API_PORT` | `3001` |
| `FRONTEND_URL` | `https://your-app.pages.dev` |
| `API_TOKEN` | Your API token |
| `GEMINI_API_KEY` | Your Gemini API key |
| `DISCORD_WEBHOOK_URL` | Your Discord webhook (optional) |
| `NODE_ENV` | `production` |

The automatic run interval and Discord webhook are configured from the dashboard's
Settings page and stored in Supabase (`scrape_interval_minutes` and
`discord_webhook_url`). GitHub Actions polls every 5 minutes and only runs when
the configured interval has elapsed. Manual `workflow_dispatch` runs bypass the
interval check.

### 4.4 Pipeline secrets explained

| Secret | Role |
|--------|------|
| `SUPABASE_URL` | Supabase project URL used by the Storage client to access the `cvs` bucket. |
| `SUPABASE_SERVICE_KEY` | Server-side Supabase service-role key used to download the active CV from Storage. Never expose it in the dashboard or frontend. |
| `DATABASE_URL` | Supabase Postgres connection string used to find the active CV, read settings, scrape configuration, postings, and pipeline history. |

## Step 5: Test the Deployment

### 5.1 Check API Health
```bash
curl https://your-api.onrender.com/api/health
```

Should return: `{"status":"ok","database":"connected"}`

### 5.2 Check Frontend
Visit `https://your-app.pages.dev/?token=YOUR_API_TOKEN` to authenticate and open the dashboard. The token is retained for the current browser session while navigating between dashboard pages.

To create the API token, generate a long random value locally, set it as
`API_TOKEN` in Render's environment variables, then use the same value in the
dashboard URL. For example in PowerShell:

```powershell
$token = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 } | ForEach-Object { [byte]$_ }))
```

Do not commit the token or place it in a public repository.

### 5.3 Trigger Manual Pipeline
1. Go to your GitHub repository
2. Click **Actions → PFE Hunter Pipeline**
3. Click **Run workflow**

## Monitoring

- **API logs:** Render dashboard → your service → Logs
- **Pipeline logs:** GitHub Actions → workflow runs
- **Database:** Supabase dashboard → Table Editor

## Troubleshooting

### Database Connection Errors
- Verify `DATABASE_URL` includes `?sslmode=require`
- Check Supabase project is not paused (free tier pauses after 7 days inactive)

### CORS Errors
- Ensure `FRONTEND_URL` in Render matches your Cloudflare Pages URL exactly
- Check browser console for specific CORS error messages

### Pipeline Fails
- Check GitHub Actions logs for specific error
- Verify all secrets are set correctly
- Test locally with same environment variables

## Cost Breakdown (All Free Tiers)

| Service | Free Tier Limits |
|---------|------------------|
| Supabase | 500MB database, 1GB storage |
| Cloudflare Pages | Unlimited requests, 25MB per deployment |
| Render | 750 hours/month (spins down after 15 min idle) |
| GitHub Actions | 2000 minutes/month (public repos = unlimited) |

## Next Steps

1. Set up custom domain (optional)
2. Configure Discord notifications
3. Adjust pipeline schedule in `.github/workflows/pipeline.yml`
4. Monitor resource usage
