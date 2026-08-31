# scrape_jobspy.py
#
# Free, creditless data source for the "PFE Hunter" pipeline.
# Uses JobSpy (open-source, MIT licensed) to scrape job postings directly —
# no API credits, no account, no per-request cost. Runs entirely on your machine.
#
# Now reads settings DYNAMICALLY from Postgres database.
# Supports multiple: search terms, locations, job sites.
#
# SETUP:
#   pip install python-jobspy==1.1.82 psycopg2-binary python-dotenv
#   python scrape_jobspy.py
#
# ENVIRONMENT:
#   DATABASE_URL=postgres://user:password@localhost:5432/pfe_hunter

import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, List, Dict, Any
from urllib.parse import urlparse

import psycopg2

# Load environment variables from .env file
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from jobspy import scrape_jobs

# ---------- CONSTANTS ----------

MAX_RETRIES = 3
RETRY_BACKOFF_SECONDS = 5
RUN_LOG_FILE = Path("scrape_run_log.json")

# Valid job sites
VALID_JOB_SITES = ["linkedin", "indeed", "jobteaser"]


# ---------- DATABASE CONNECTION ----------

def get_db_connection():
    """Parse DATABASE_URL and return a psycopg2 connection."""
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise ValueError("DATABASE_URL environment variable is not set")

    parsed = urlparse(database_url)
    return psycopg2.connect(
        host=parsed.hostname,
        port=parsed.port or 5432,
        database=parsed.path.lstrip("/"),
        user=parsed.username,
        password=parsed.password,
    )


# ---------- SETTINGS MANAGEMENT ----------

def get_settings(conn) -> Dict[str, Any]:
    """
    Fetch all settings from the database and parse them into a dictionary.
    Returns a dict with setting_key -> parsed_value.
    """
    with conn.cursor() as cur:
        cur.execute("SELECT setting_key, setting_value FROM user_settings")
        rows = cur.fetchall()

    settings = {}
    for key, value in rows:
        # Parse JSON arrays
        if key in ["search_terms", "locations", "job_sites", "title_keywords"]:
            try:
                settings[key] = json.loads(value)
            except json.JSONDecodeError:
                settings[key] = []
        # Parse integers
        elif key in ["scrape_interval_minutes", "results_wanted", "hours_old", "fit_score_threshold"]:
            try:
                settings[key] = int(value)
            except (ValueError, TypeError):
                settings[key] = get_default_setting(key)
        else:
            settings[key] = value

    # Apply defaults for missing settings
    defaults = get_default_settings()
    for key, value in defaults.items():
        if key not in settings:
            settings[key] = value

    return settings


def get_default_settings() -> Dict[str, Any]:
    """Return default settings if database values are missing."""
    return {
        "scrape_interval_minutes": 300,
        "results_wanted": 10,
        "hours_old": 336,
        "fit_score_threshold": 70,
        "search_terms": ["software engineering internship"],
        "locations": ["France"],
        "job_sites": ["linkedin", "indeed", "jobteaser"],
        "title_keywords": ["software", "developer", "backend", "frontend", "fullstack", "full-stack", "engineer", "data", "ai", "machine learning", "intern", "stage"],
    }


def get_default_setting(key: str) -> Any:
    """Get a single default setting value."""
    return get_default_settings().get(key)


# ---------- HELPER FUNCTIONS ----------

def append_run_log(entry: dict):
    """Append one run's stats to a local JSON list file."""
    if RUN_LOG_FILE.exists():
        try:
            history = json.loads(RUN_LOG_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            history = []
    else:
        history = []

    history.append(entry)
    RUN_LOG_FILE.write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8")


def derive_job_id(job_url: Optional[str], source: str = "linkedin") -> Optional[str]:
    """
    Extract stable job_id from job URL.
    - LinkedIn: Extract from /view/<id> pattern
    - Indeed: Use URL hash
    - JobTeaser: Use URL hash
    """
    if not job_url:
        return None

    # LinkedIn pattern
    if "linkedin" in job_url.lower():
        match = re.search(r"/view/(\d+)", job_url)
        if match:
            return f"li-{match.group(1)}"

    # Indeed pattern (job URLs contain jk= parameter)
    if "indeed" in job_url.lower():
        match = re.search(r"jk=([a-f0-9]+)", job_url)
        if match:
            return f"in-{match.group(1)}"

    # JobTeaser or fallback: hash the URL
    return f"jt-{hashlib.sha256(job_url.encode('utf-8')).hexdigest()[:16]}"


def strip_emojis(text: Optional[str]) -> Optional[str]:
    """Remove emojis and non-ASCII characters."""
    if not text:
        return text
    return text.encode('ascii', 'ignore').decode('ascii')


def matches_title_keywords(title: Optional[str], keywords: List[str]) -> bool:
    """Check if job title matches any of the allowed keywords (case-insensitive)."""
    if not title:
        return False
    title_lower = title.lower()
    return any(keyword.lower() in title_lower for keyword in keywords)


def ensure_schema(conn):
    """Create database tables if they don't exist."""
    schema_sql = Path(__file__).parent.joinpath("schema.sql").read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(schema_sql)
    conn.commit()


def insert_postings(conn, postings: list) -> tuple:
    """
    Insert postings with deduplication via ON CONFLICT DO NOTHING.
    Returns (inserted_count, skipped_count).
    """
    if not postings:
        return 0, 0

    with conn.cursor() as cur:
        inserted = 0
        for p in postings:
            cur.execute(
                """
                INSERT INTO job_postings (job_id, job_url, title, company, location, description, source)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (job_id) DO NOTHING
                RETURNING job_id
                """,
                (
                    p["job_id"],
                    p["job_url"],
                    p["title"],
                    p.get("company"),
                    p.get("location"),
                    p.get("description"),
                    p.get("source", "linkedin"),
                ),
            )
            if cur.fetchone():
                inserted += 1

    conn.commit()
    return inserted, len(postings) - inserted


# ---------- SCRAPING FUNCTIONS ----------

def scrape_linkedin(search_term: str, location: str, results_wanted: int, hours_old: int):
    """Scrape LinkedIn jobs using JobSpy."""
    print(f"  Scraping LinkedIn: '{search_term}' in '{location}'...")

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            df = scrape_jobs(
                site_name=["linkedin"],
                search_term=search_term,
                location=location,
                results_wanted=results_wanted,
                hours_old=hours_old,
                linkedin_fetch_description=True,
            )
            return df, "linkedin"
        except Exception as err:
            print(f"    LinkedIn attempt {attempt}/{MAX_RETRIES} failed: {err}")
            if attempt < MAX_RETRIES:
                wait = RETRY_BACKOFF_SECONDS * (2 ** (attempt - 1))
                print(f"    Retrying in {wait}s...")
                time.sleep(wait)

    return None, "linkedin"


def scrape_indeed(search_term: str, location: str, results_wanted: int, hours_old: int):
    """
    Scrape Indeed jobs using JobSpy.

    Indeed search fields:
      - Keyword: "Intitulé de poste, mots-clés ou entreprise"
      - Location: "Ville, département, code postal ou « Télétravail »"
    """
    print(f"  Scraping Indeed: '{search_term}' in '{location}'...")

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            # JobSpy supports Indeed natively
            # Use country_indeed='france' for French Indeed site
            df = scrape_jobs(
                site_name=["indeed"],
                search_term=search_term,
                location=location,
                results_wanted=results_wanted,
                hours_old=hours_old,
                country_indeed="france",  # Target French Indeed site
            )
            return df, "indeed"
        except Exception as err:
            print(f"    Indeed attempt {attempt}/{MAX_RETRIES} failed: {err}")
            if attempt < MAX_RETRIES:
                wait = RETRY_BACKOFF_SECONDS * (2 ** (attempt - 1))
                print(f"    Retrying in {wait}s...")
                time.sleep(wait)

    return None, "indeed"


def scrape_jobteaser(search_term: str, location: str, results_wanted: int):
    """
    Scrape JobTeaser jobs using custom scraper.

    JobTeaser search fields:
      - Keyword: "Rechercher par offre, entreprise ou mots-clé"
      - Contract Type: "Contrat" (CDI, internship, apprenticeship)
      - Location: "Ville, département..."

    NOTE: JobTeaser is not supported by JobSpy, so we use a custom implementation.
    """
    print(f"  Scraping JobTeaser: '{search_term}' in '{location}'...")

    try:
        # Import the custom JobTeaser scraper
        from scrape_jobteaser import scrape_jobteaser_to_dataframe

        df = scrape_jobteaser_to_dataframe(
            search_term=search_term,
            location=location,
            results_wanted=results_wanted,
            fetch_description=False  # Faster, can be enabled if needed
        )

        if df is not None and len(df) > 0:
            print(f"    Found {len(df)} postings from JobTeaser")
            return df, "jobteaser"
        else:
            print(f"    No results from JobTeaser")
            return None, "jobteaser"

    except ImportError as err:
        print(f"    JobTeaser scraper not available: {err}")
        print(f"    Install dependencies: pip install requests beautifulsoup4 lxml")
        return None, "jobteaser"
    except Exception as err:
        print(f"    JobTeaser scraping failed: {err}")
        return None, "jobteaser"


def normalize_posting(row, source: str) -> Optional[Dict]:
    """Normalize a job posting from any source into our standard format."""
    title = row.get("title")
    job_url = row.get("job_url")

    if not title or not job_url:
        return None

    job_id = derive_job_id(job_url, source)
    if not job_id:
        return None

    return {
        "job_id": job_id,
        "job_url": job_url,
        "title": strip_emojis(title),
        "company": strip_emojis(row.get("company")),
        "location": strip_emojis(row.get("location")),
        "description": strip_emojis(row.get("description")) or "",
        "source": source,
    }


# ---------- MAIN FUNCTION ----------

def main():
    """Main scraping function that reads settings from DB and scrapes all configured sources."""
    started_at = datetime.now(timezone.utc)
    start_time = time.monotonic()

    # Connect to database
    try:
        conn = get_db_connection()
    except Exception as err:
        print(f"Failed to connect to database: {err}")
        print("Make sure DATABASE_URL is set and Postgres is running.")
        return 0, 0

    # Ensure schema exists
    ensure_schema(conn)

    # Load settings from database
    print("Loading settings from database...")
    settings = get_settings(conn)

    search_terms = settings.get("search_terms", ["software engineering internship"])
    locations = settings.get("locations", ["France"])
    job_sites = settings.get("job_sites", ["linkedin"])
    results_wanted = settings.get("results_wanted", 10)
    hours_old = settings.get("hours_old", 336)
    title_keywords = settings.get("title_keywords", [])

    print(f"  Search terms: {search_terms}")
    print(f"  Locations: {locations}")
    print(f"  Job sites: {job_sites}")
    print(f"  Results per source: {results_wanted}")
    print(f"  Hours old: {hours_old}")
    print(f"  Title keywords: {len(title_keywords)} keywords")

    # Track totals
    total_postings_found = 0
    total_inserted = 0
    total_skipped = 0
    all_postings = []

    # Scrape each combination of search_term x location x site
    for search_term in search_terms:
        for location in locations:
            for site in job_sites:
                if site not in VALID_JOB_SITES:
                    print(f"  Skipping unknown site: {site}")
                    continue

                # Scrape based on site
                if site == "linkedin":
                    df, source = scrape_linkedin(search_term, location, results_wanted, hours_old)
                elif site == "indeed":
                    df, source = scrape_indeed(search_term, location, results_wanted, hours_old)
                elif site == "jobteaser":
                    df, source = scrape_jobteaser(search_term, location, results_wanted)
                else:
                    continue

                if df is None or len(df) == 0:
                    print(f"    No results from {site}")
                    continue

                print(f"    Found {len(df)} postings from {site}")

                # Normalize and filter
                for _, row in df.iterrows():
                    posting = normalize_posting(row, source)
                    if not posting:
                        continue

                    # Filter by title keywords
                    if title_keywords and not matches_title_keywords(posting["title"], title_keywords):
                        continue

                    all_postings.append(posting)

    total_postings_found = len(all_postings)
    print(f"\nTotal postings after filtering: {total_postings_found}")

    # Insert all postings
    if all_postings:
        print(f"Inserting {total_postings_found} posting(s) into Postgres...")
        inserted, skipped = insert_postings(conn, all_postings)
        print(f"Inserted {inserted} new posting(s), {skipped} already existed (deduped).")
        total_inserted = inserted
        total_skipped = skipped
    else:
        print("No postings to insert.")

    # Log the run
    elapsed_seconds = round(time.monotonic() - start_time, 1)
    log_entry = {
        "timestamp": started_at.isoformat(),
        "status": "success",
        "postings_found": total_postings_found,
        "postings_inserted": total_inserted,
        "postings_deduped": total_skipped,
        "elapsed_seconds": elapsed_seconds,
        "settings": {
            "search_terms": search_terms,
            "locations": locations,
            "job_sites": job_sites,
            "results_wanted": results_wanted,
        },
    }
    append_run_log(log_entry)
    print(f"Logged this run to {RUN_LOG_FILE}")

    conn.close()
    return total_inserted, total_skipped


def run_periodic(interval_minutes: int = None):
    """
    Run the scraper periodically at the specified interval.
    If interval_minutes is None, reads from database settings.
    """
    import signal
    import sys

    # Get interval from database if not specified
    if interval_minutes is None:
        try:
            conn = get_db_connection()
            settings = get_settings(conn)
            interval_minutes = settings.get("scrape_interval_minutes", 300) // 60
            conn.close()
        except Exception:
            interval_minutes = 5  # Default fallback

    print(f"Starting periodic scraper (every {interval_minutes} min). Press Ctrl+C to stop.\n")

    def handle_shutdown(signum, frame):
        print("\nStopping periodic scraper...")
        sys.exit(0)

    signal.signal(signal.SIGINT, handle_shutdown)
    signal.signal(signal.SIGTERM, handle_shutdown)

    while True:
        run_start = datetime.now(timezone.utc)
        print(f"\n{'='*60}")
        print(f"[{run_start.strftime('%Y-%m-%d %H:%M:%S UTC')}] Starting scrape run")
        print('='*60)

        try:
            main()
        except Exception as err:
            print(f"Run failed: {err}")

        print(f"\nNext run in {interval_minutes} minute(s)...")
        time.sleep(interval_minutes * 60)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="PFE Hunter - Job Scraper")
    parser.add_argument(
        "--periodic",
        type=int,
        metavar="MINUTES",
        nargs="?",
        const=None,  # Read from database
        default=None,
        help="Run periodically every N minutes. If no value given, reads from database settings."
    )
    args = parser.parse_args()

    if args.periodic is not None or args.periodic is None:
        # Check if --periodic flag was provided without value
        if "--periodic" in sys.argv:
            run_periodic(args.periodic)
        else:
            main()
