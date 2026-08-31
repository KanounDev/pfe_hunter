# Job Scraping Guide

This document explains the job scraping capabilities of PFE Hunter.

## Supported Job Sites

### 1. LinkedIn (via JobSpy)
- **Status**: ✅ Fully supported
- **Search Fields**:
  - Keyword search
  - Location
  - Date posted (hours_old)
- **Features**: Full job descriptions, company info
- **Rate Limit**: Moderate (be careful not to over-scrape)

### 2. Indeed (via JobSpy)
- **Status**: ✅ Fully supported
- **Search Fields**:
  - Keyword: "Intitulé de poste, mots-clés ou entreprise"
  - Location: "Ville, département, code postal ou « Télétravail »"
  - Date posted (hours_old)
- **Features**: Full job descriptions, salary info when available
- **Configuration**: Targets French Indeed (`country_indeed='france'`)

### 3. JobTeaser (Custom Scraper)
- **Status**: ⚠️ Experimental
- **Search Fields**:
  - Keyword: "Rechercher par offre, entreprise ou mots-clé"
  - Contract Type: "Contrat" (CDI, stage, alternance)
  - Location: "Ville, département..."
- **Features**: Basic job info, optional full descriptions
- **Dependencies**: `requests`, `beautifulsoup4`, `lxml`
- **Note**: Custom implementation since JobSpy doesn't support it

## Installation

### Required for all scrapers:
```bash
pip install python-jobspy==1.1.82 psycopg2-binary python-dotenv
```

### Additional for JobTeaser:
```bash
pip install requests beautifulsoup4 lxml
```

## Usage

### In Python (direct):
```python
from scrape_jobspy import main

# Run scraper with database settings
inserted, skipped = main()
```

### Periodic execution:
```python
from scrape_jobspy import run_periodic

# Run every 5 minutes (reads interval from database)
run_periodic()
```

### Command line:
```bash
# Single run
python scrape_jobspy.py

# Periodic (every 5 minutes)
python scrape_jobspy.py --periodic 5

# Periodic (interval from database)
python scrape_jobspy.py --periodic
```

## Configuration

Settings are stored in the `user_settings` table:

| Setting | Description | Default |
|---------|-------------|---------|
| `search_terms` | Keywords to search (JSON array) | `["software engineering internship"]` |
| `locations` | Locations to search (JSON array) | `["France"]` |
| `job_sites` | Sites to scrape (JSON array) | `["linkedin", "indeed", "jobteaser"]` |
| `results_wanted` | Max results per source | `10` |
| `hours_old` | Only jobs posted within N hours | `8` |
| `title_keywords` | Filter by title keywords (JSON array) | `["software", "developer", ...]` |

## Deduplication

Jobs are deduplicated by `job_id` before insertion:
- **LinkedIn**: Extracts job ID from `/view/<id>` URL pattern
- **Indeed**: Extracts job ID from `jk=` URL parameter
- **JobTeaser**: Generates hash from URL

## Troubleshooting

### JobTeaser returns no results
1. Check dependencies: `pip list | grep -E "requests|beautifulsoup4|lxml"`
2. Test manually: `python scrape_jobteaser.py`
3. Check debug HTML file if generated
4. JobTeaser may have changed their site structure

### Indeed returns no results
1. Check your IP isn't blocked
2. Try reducing `results_wanted` (max 50 recommended)
3. Increase `hours_old` if searching for older jobs

### Rate limiting
- LinkedIn: 1-2 requests per second max
- Indeed: 1 request per second
- JobTeaser: 1 request per second
- All scrapers have retry logic with exponential backoff

## Testing Individual Scrapers

```python
# Test LinkedIn
from scrape_jobspy import scrape_linkedin
df, source = scrape_linkedin("software engineer", "Paris", 10, 24)

# Test Indeed
from scrape_jobspy import scrape_indeed
df, source = scrape_indeed("développeur", "France", 10, 24)

# Test JobTeaser
from scrape_jobteaser import scrape_jobteaser
jobs = scrape_jobteaser("stage développeur", "Paris", 10)
```

## Notes

- JobTeaser scraper is experimental and may break if the site changes
- Indeed is configured for French market (`country_indeed='france'`)
- All scrapers respect `robots.txt` and implement polite delays
- Maximum `results_wanted` is 50 to avoid IP blocks
