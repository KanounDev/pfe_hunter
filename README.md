# PFE Hunter

PFE Hunter is an AI-assisted job discovery platform for finding and ranking internship and entry-level opportunities. It scrapes job postings, removes duplicates, scores new postings against a CV with Google Gemini, and presents the results in a React dashboard.

## Features

- Job scraping with the Python JobSpy and JobTeaser scrapers
- PostgreSQL persistence and duplicate detection
- Gemini-powered fit scoring
- React dashboard for postings, scores, settings, and pipeline activity
- Optional Discord notifications for high-scoring postings
- CV upload and storage support through local disk or Supabase Storage
- Docker Compose setup for local API, database, and worker development

## Architecture

```text
React dashboard (Vite)
        |
        v
Node.js API (Express) <-> PostgreSQL
        ^
        |
Python scraper and scoring worker -> Gemini -> Discord notifications
```

See [Architecture.md](Architecture.md) for the data flow and [DEPLOYMENT.md](DEPLOYMENT.md) for production deployment instructions.

## Prerequisites

- Node.js 20 or newer
- npm
- Python 3.11 for the scraper worker (pinned via `.python-version`; Render, GitHub Actions, and the Dockerfiles all use it)
- Docker Desktop, if using the Compose setup
- A Google Gemini API key for scoring

## Quick Start With Docker

1. Create a `.env` file in the project root:

```env
GEMINI_API_KEY=your_gemini_api_key
API_TOKEN=local_dev_token
DISCORD_WEBHOOK_URL=
# Compose uses local CV storage and the persistent uploads_data volume.
# Do not set CV_FILE_PATH when using a dashboard-uploaded CV.
```

2. Start the local services:

```bash
docker compose up --build
```

The API is available at `http://localhost:3001` and the PostgreSQL database is available from the host at `localhost:5433` (it uses port `5432` inside Docker). The worker starts periodic scraping with the local Compose interval.

3. Start the dashboard in a second terminal:

```bash
cd dashboard
npm install
npm run dev
```

Open the Vite URL shown in the terminal, usually `http://localhost:5173`. Use the same value as `API_TOKEN` when the dashboard requests authentication.

Stop the services with:

```bash
docker compose down
```

Add `-v` to remove the local PostgreSQL and upload volumes.

## Local Development Without Docker

Start PostgreSQL on port `5432`, then install the Node.js and Python dependencies:

```bash
npm install
pip install -r requirements.txt
```

Configure the API environment, at minimum:

```env
DATABASE_URL=postgres://user:password@localhost:5432/pfe_hunter
API_PORT=3001
API_TOKEN=local_dev_token
FRONTEND_URL=http://localhost:5173
GEMINI_API_KEY=your_gemini_api_key
CV_STORAGE=local
CV_LOCAL_DIR=./uploads/cvs
```

Start the API:

```bash
node api.mjs
```

Start the dashboard in another terminal:

```bash
cd dashboard
npm install
npm run dev
```

Run the periodic worker separately when needed:

```bash
python run_periodic.py --interval 360
```

## Useful Commands

| Command | Description |
| --- | --- |
| `npm start` | Start the Node.js API |
| `npm test` | Placeholder test command; automated tests are not configured yet |
| `docker compose up --build` | Build and start the local services |
| `cd dashboard && npm run dev` | Start the dashboard development server |
| `cd dashboard && npm run build` | Build the dashboard for production |
| `cd dashboard && npm run lint` | Run dashboard linting |

Check the API health endpoint with:

```bash
curl http://localhost:3001/api/health
```

## Project Structure

- `api.mjs` - Express API server
- `db.mjs` and `schema.sql` - Database access and schema
- `scrape_jobspy.py` and `scrape_jobteaser.py` - Job scrapers
- `run_periodic.py` - Periodic scraping and scoring worker
- `gemini-scoring.mjs` - Gemini scoring integration
- `notifications.mjs` - Notification delivery
- `mcp-server.mjs` - MCP tool server
- `dashboard/` - React and Vite dashboard
- `Dockerfile.api` and `Dockerfile.worker` - Container definitions
- `docker-compose.yml` - Local multi-service environment

## Documentation

- [Deployment Guide](DEPLOYMENT.md)
- [Architecture](Architecture.md)

## License

This project is licensed under the MIT License.
