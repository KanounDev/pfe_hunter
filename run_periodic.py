# run_periodic.py
#
# Unified periodic runner for PFE Hunter.
# Runs both the scraper AND the pipeline on a schedule.
#
# USAGE:
#   python run_periodic.py              # Run every 5 minutes (default)
#   python run_periodic.py --interval 2 # Run every 2 minutes
#   python run_periodic.py --once       # Run once and exit
#
# PRODUCTION:
#   For production (GitHub Actions/Supabase), this logic moves to:
#   - GitHub Actions scheduled workflow (cron: '0 */6 * * *')
#   - Or Supabase Edge Functions with pg_cron
#
# This script is for LOCAL TESTING ONLY.

import argparse
import subprocess
import sys
import time
import signal
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent
SCRAPER_SCRIPT = HERE / "scrape_jobspy.py"
PIPELINE_SCRIPT = HERE / "pfe-hunter-pipeline.mjs"
RUN_LOG_FILE = HERE / "periodic_run_log.json"


def log_run(status: str, details: dict = None):
    """Append run result to log file."""
    import json

    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "status": status,
        **(details or {}),
    }

    history = []
    if RUN_LOG_FILE.exists():
        try:
            history = json.loads(RUN_LOG_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            history = []

    history.append(entry)
    RUN_LOG_FILE.write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8")


def run_scraper():
    """Run the Python scraper and return (success, inserted_count)."""
    print("\n[1/2] Running LinkedIn scraper...")
    try:
        result = subprocess.run(
            [sys.executable, str(SCRAPER_SCRIPT)],
            capture_output=True,
            text=True,
            timeout=120,  # 2 min timeout
        )

        if result.returncode != 0:
            print(f"Scraper FAILED:\n{result.stderr}")
            return False, 0

        # Parse output for inserted count
        output = result.stdout + result.stderr
        print(output)

        # Look for "Inserted X new posting(s)" in output
        import re
        match = re.search(r"Inserted (\d+) new posting\(s\)", output)
        inserted = int(match.group(1)) if match else 0

        return True, inserted

    except subprocess.TimeoutExpired:
        print("Scraper TIMEOUT (>2 min)")
        return False, 0
    except Exception as err:
        print(f"Scraper ERROR: {err}")
        return False, 0


def run_pipeline():
    """Run the Node.js pipeline and return (success, scored_count)."""
    print("\n[2/2] Running scoring pipeline...")
    try:
        result = subprocess.run(
            ["node", str(PIPELINE_SCRIPT)],
            capture_output=True,
            text=True,
            timeout=180,  # 3 min timeout (Gemini can be slow)
        )

        if result.returncode != 0:
            print(f"Pipeline FAILED:\n{result.stderr}")
            return False, 0

        output = result.stdout + result.stderr
        print(output)

        # Parse output for scored count
        import re
        match = re.search(r"Scoring (\d+) posting\(s\)", output)
        scored = int(match.group(1)) if match else 0

        return True, scored

    except subprocess.TimeoutExpired:
        print("Pipeline TIMEOUT (>3 min)")
        return False, 0
    except Exception as err:
        print(f"Pipeline ERROR: {err}")
        return False, 0


def run_once():
    """Run one complete cycle: scrape -> score -> notify."""
    run_start = datetime.now(timezone.utc)

    print("\n" + "=" * 60)
    print(f"[{run_start.strftime('%Y-%m-%d %H:%M:%S UTC')}] Starting PFE Hunter run")
    print("=" * 60)

    # Step 1: Scrape
    scraper_ok, inserted = run_scraper()

    if not scraper_ok:
        log_run("failed", {"step": "scraper", "inserted": 0})
        return False

    # Step 2: Score + Notify (always run, even if 0 new postings)
    # The pipeline handles "nothing to score" gracefully
    pipeline_ok, scored = run_pipeline()

    if not pipeline_ok:
        log_run("failed", {"step": "pipeline", "inserted": inserted, "scored": 0})
        return False

    # Success
    elapsed = (datetime.now(timezone.utc) - run_start).total_seconds()
    print(f"\n{'=' * 60}")
    print(f"Run complete in {elapsed:.1f}s")
    print(f"  - Scraped: {inserted} new posting(s)")
    print(f"  - Scored: {scored} posting(s)")
    print("=" * 60)

    log_run("success", {
        "inserted": inserted,
        "scored": scored,
        "elapsed_seconds": round(elapsed, 1),
    })

    return True


def run_periodic(interval_minutes: int):
    """
    Run the complete cycle periodically.
    """
    print(f"\n{'#' * 60}")
    print(f"PFE Hunter - Periodic Runner")
    print(f"Interval: Every {interval_minutes} minute(s)")
    print(f"Press Ctrl+C to stop")
    print("#" * 60)

    def handle_shutdown(signum, frame):
        print("\n\nStopping periodic runner...")
        sys.exit(0)

    signal.signal(signal.SIGINT, handle_shutdown)
    signal.signal(signal.SIGTERM, handle_shutdown)

    while True:
        run_once()

        next_run = datetime.now(timezone.utc)
        sleep_seconds = interval_minutes * 60

        print(f"\nNext run in {interval_minutes} minute(s)...")
        print(f"(Press Ctrl+C to stop)")

        time.sleep(sleep_seconds)


def main():
    parser = argparse.ArgumentParser(
        description="PFE Hunter - Periodic Runner",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python run_periodic.py              # Run every 5 minutes
  python run_periodic.py --interval 2 # Run every 2 minutes
  python run_periodic.py --once       # Run once and exit
        """,
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=5,
        metavar="MINUTES",
        help="Run every N minutes (default: 5)",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run once and exit (no periodic loop)",
    )

    args = parser.parse_args()

    if args.once:
        success = run_once()
        sys.exit(0 if success else 1)
    else:
        run_periodic(interval_minutes=args.interval)


if __name__ == "__main__":
    main()
