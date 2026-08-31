# start-local.py
#
# Unified starter for PFE Hunter - runs everything needed for local testing.
#
# This starts:
#   1. Backend API (Express server on port 3001)
#   2. React Dashboard (Vite dev server on port 5173)
#   3. Periodic scraper (every 5 minutes by default)
#
# USAGE:
#   python start-local.py              # Start everything (scraper every 5 min)
#   python start-local.py --no-scraper # Start only API + Dashboard
#   python start-local.py --interval 10 # Run scraper every 10 minutes

import subprocess
import sys
import time
import signal
import os
from pathlib import Path

HERE = Path(__file__).parent
API_SCRIPT = HERE / "api.mjs"
DASHBOARD_DIR = HERE / "dashboard"
PERIODIC_SCRIPT = HERE / "run_periodic.py"

processes = []

def is_port_in_use(port):
    """Return True if something is already listening on localhost:port."""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0

def start_api():
    """Start the Express backend API."""
    # Fail fast with a clear message instead of a confusing
    # "EADDRINUSE" crash when an old instance still holds the port.
    if is_port_in_use(3001):
        print("ERROR: Port 3001 is already in use - another API instance is running.")
        print("Stop it first (close the other start-local window, or kill its PID):")
        print("  netstat -ano | findstr :3001   ->   taskkill /PID <pid> /F")
        sys.exit(1)
    print("[1/3] Starting Backend API on http://localhost:3001...")
    proc = subprocess.Popen(
        ["node", str(API_SCRIPT)],
        cwd=str(HERE),
    )
    processes.append(("API", proc))
    return proc

def start_dashboard():
    """Start the React dashboard."""
    print("[2/3] Starting React Dashboard on http://localhost:5173...")
    # Call npm.cmd directly (no shell) so the whole process tree can be
    # killed on Windows; shell=True used to orphan the vite child process.
    npm_cmd = "npm.cmd" if os.name == "nt" else "npm"
    proc = subprocess.Popen(
        [npm_cmd, "run", "dev"],
        cwd=str(DASHBOARD_DIR),
    )
    processes.append(("Dashboard", proc))
    return proc

def start_periodic(interval_minutes=5):
    """Start the periodic scraper."""
    print(f"[3/3] Starting Periodic Scraper (every {interval_minutes} min)...")
    proc = subprocess.Popen(
        [sys.executable, str(PERIODIC_SCRIPT), "--interval", str(interval_minutes)],
        cwd=str(HERE),
    )
    processes.append(("Scraper", proc))
    return proc

def _kill_tree(proc):
    """Kill a process and ALL its children. Needed on Windows where
    terminate() only kills the parent and leaves children (vite, esbuild)
    running as orphans that keep holding their ports."""
    if proc.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                capture_output=True,
                timeout=10,
            )
        else:
            proc.terminate()
    except Exception:
        pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()

def cleanup(signum=None, frame=None):
    """Stop all running processes."""
    print("\n\nStopping all services...")
    for name, proc in processes:
        print(f"  Stopping {name}...")
        _kill_tree(proc)
    print("All services stopped.")
    sys.exit(0)

def main():
    import argparse

    parser = argparse.ArgumentParser(description="Start PFE Hunter locally")
    parser.add_argument(
        "--no-scraper",
        action="store_true",
        help="Don't run the periodic scraper (just API + Dashboard)",
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=5,
        metavar="MINUTES",
        help="Scraper interval in minutes (default: 5)",
    )

    args = parser.parse_args()

    print("\n" + "=" * 60)
    print("PFE Hunter - Local Development")
    print("=" * 60)

    # Handle Ctrl+C gracefully
    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)

    # Start services
    start_api()
    time.sleep(2)  # Let API start first

    start_dashboard()
    time.sleep(2)  # Let dashboard start

    if not args.no_scraper:
        start_periodic(args.interval)

    print("\n" + "=" * 60)
    print("All services running!")
    print("=" * 60)
    print(f"\n  Dashboard:  http://localhost:5173")
    print(f"  API:        http://localhost:3001/api")
    print(f"  Health:     http://localhost:3001/api/health")
    if not args.no_scraper:
        print(f"  Scraper:    Running every {args.interval} min")
    print("\n  Press Ctrl+C to stop all services")
    print("=" * 60 + "\n")

    # Keep running until interrupted
    while True:
        time.sleep(1)
        # Check if any process died
        for name, proc in processes:
            if proc.poll() is not None:
                print(f"\nWarning: {name} process died (exit code {proc.returncode})")

if __name__ == "__main__":
    main()
