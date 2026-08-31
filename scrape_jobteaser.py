# scrape_jobteaser.py
#
# Custom JobTeaser scraper for PFE Hunter.
# JobTeaser is not supported by JobSpy, so this implements direct scraping.
#
# JobTeaser search fields:
#   - Keyword: "Rechercher par offre, entreprise ou mots-clé"
#   - Contract Type: "Contrat" (CDI, internship, apprenticeship)
#   - Location: "Ville, département..."
#
# SETUP:
#   pip install requests beautifulsoup4 lxml
#
# USAGE:
#   from scrape_jobteaser import scrape_jobteaser
#   jobs = scrape_jobteaser("software engineer", "Paris", 10)

import hashlib
import re
import time
from typing import Optional, List, Dict, Any
from datetime import datetime, timezone

try:
    import requests
    from bs4 import BeautifulSoup
    HAS_DEPS = True
except ImportError:
    HAS_DEPS = False
    print("WARNING: requests or beautifulsoup4 not installed. JobTeaser scraping disabled.")
    print("Install with: pip install requests beautifulsoup4 lxml")


JOBTEASER_BASE_URL = "https://www.jobteaser.com"
JOBTEASER_SEARCH_URL = f"{JOBTEASER_BASE_URL}/fr/jobs"

# Headers to mimic a real browser
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
}


def strip_emojis(text: Optional[str]) -> Optional[str]:
    """Remove emojis and non-ASCII characters."""
    if not text:
        return text
    return text.encode('ascii', 'ignore').decode('ascii')


def derive_jobteaser_id(job_url: str) -> str:
    """Generate a stable job ID from JobTeaser URL."""
    # JobTeaser URLs typically look like:
    # https://www.jobteaser.com/fr/jobs/software-engineer-at-company-123456
    # Extract the ID from the URL
    match = re.search(r'-(\d+)$', job_url)
    if match:
        return f"jt-{match.group(1)}"

    # Fallback: hash the URL
    return f"jt-{hashlib.sha256(job_url.encode('utf-8')).hexdigest()[:16]}"


def parse_job_listing(job_element, base_url: str) -> Optional[Dict[str, Any]]:
    """
    Parse a job listing element from JobTeaser search results.
    Returns a standardized job dictionary.
    """
    try:
        # Extract job URL
        link_elem = job_element.find('a', href=True)
        if not link_elem:
            return None

        job_url = link_elem['href']
        if not job_url.startswith('http'):
            job_url = base_url + job_url

        # Extract title
        title_elem = (
            job_element.find('h2') or
            job_element.find('h3') or
            job_element.find('a', class_=re.compile(r'job.*title'))
        )
        title = title_elem.get_text(strip=True) if title_elem else None

        if not title:
            return None

        # Extract company
        company_elem = (
            job_element.find('span', class_=re.compile(r'company')) or
            job_element.find('p', class_=re.compile(r'company')) or
            job_element.find(string=re.compile(r'Entreprise:'))
        )
        company = None
        if company_elem:
            company = company_elem.get_text(strip=True)

        # Extract location
        location_elem = (
            job_element.find('span', class_=re.compile(r'location|ville')) or
            job_element.find('p', class_=re.compile(r'location')) or
            job_element.find(string=re.compile(r'Localisation:'))
        )
        location = None
        if location_elem:
            location = location_elem.get_text(strip=True)

        # Extract job ID
        job_id = derive_jobteaser_id(job_url)

        return {
            'job_id': job_id,
            'job_url': job_url,
            'title': strip_emojis(title),
            'company': strip_emojis(company) if company else None,
            'location': strip_emojis(location) if location else None,
            'description': '',  # Will fetch separately if needed
            'source': 'jobteaser',
        }

    except Exception as e:
        print(f"    Error parsing job listing: {e}")
        return None


def fetch_job_description(job_url: str) -> str:
    """Fetch the full job description from a JobTeaser job page."""
    try:
        response = requests.get(job_url, headers=HEADERS, timeout=30)
        response.raise_for_status()

        soup = BeautifulSoup(response.text, 'lxml')

        # Try multiple possible description selectors
        desc_elem = (
            soup.find('div', class_=re.compile(r'description|job-details|content')) or
            soup.find('section', class_=re.compile(r'description')) or
            soup.find('div', {'id': re.compile(r'description')}) or
            soup.find('article')
        )

        if desc_elem:
            # Clean up the text
            description = desc_elem.get_text(separator='\n', strip=True)
            # Remove excessive whitespace
            description = re.sub(r'\n{3,}', '\n\n', description)
            description = re.sub(r' {2,}', ' ', description)
            return strip_emojis(description)

        return ""

    except Exception as e:
        print(f"    Error fetching job description: {e}")
        return ""


def scrape_jobteaser(
    search_term: str,
    location: str,
    results_wanted: int = 10,
    fetch_description: bool = False,
    contract_type: Optional[str] = None
) -> List[Dict[str, Any]]:
    """
    Scrape JobTeaser job listings.

    Args:
        search_term: Keywords to search (e.g., "software engineer", "stage développeur")
        location: Location to search in (e.g., "Paris", "France", "Lyon")
        results_wanted: Maximum number of results to return
        fetch_description: Whether to fetch full job descriptions (slower)
        contract_type: Filter by contract type (e.g., "stage", "alternance", "cdi")

    Returns:
        List of job dictionaries with standardized format
    """
    if not HAS_DEPS:
        print("  ERROR: Missing dependencies for JobTeaser scraping")
        print("    Install with: pip install requests beautifulsoup4 lxml")
        return []

    print(f"  Scraping JobTeaser: '{search_term}' in '{location}'...")

    jobs = []

    try:
        # Build search URL
        # JobTeaser search URL format:
        # https://www.jobteaser.com/fr/jobs?query=software+engineer&location=Paris
        params = {
            'query': search_term,
            'location': location,
        }

        if contract_type:
            params['contract_type'] = contract_type

        # Make request
        response = requests.get(
            JOBTEASER_SEARCH_URL,
            params=params,
            headers=HEADERS,
            timeout=30
        )

        if response.status_code == 404:
            print(f"    JobTeaser search endpoint not found (404)")
            print(f"    Note: JobTeaser may have changed their site structure")
            return []

        response.raise_for_status()

        # Parse HTML
        soup = BeautifulSoup(response.text, 'lxml')

        # Find job listings
        # Try multiple possible selectors for job listing containers
        job_elements = (
            soup.find_all('div', class_=re.compile(r'job.*listing|job.*card|offer')) or
            soup.find_all('li', class_=re.compile(r'job|offer')) or
            soup.find_all('article') or
            soup.find_all('div', {'data-job-id': True})
        )

        if not job_elements:
            print(f"    No job listings found on page")
            # Debug: save the HTML for analysis
            debug_file = f"jobteaser_debug_{int(time.time())}.html"
            with open(debug_file, 'w', encoding='utf-8') as f:
                f.write(response.text)
            print(f"    Saved debug HTML to {debug_file}")
            return []

        print(f"    Found {len(job_elements)} job listing(s) on page")

        # Parse each job listing
        for job_elem in job_elements[:results_wanted]:
            job = parse_job_listing(job_elem, JOBTEASER_BASE_URL)

            if job:
                # Optionally fetch full description
                if fetch_description:
                    print(f"      Fetching description for: {job['title'][:50]}...")
                    job['description'] = fetch_job_description(job['job_url'])
                    time.sleep(1)  # Be polite to the server

                jobs.append(job)

        print(f"    Parsed {len(jobs)} valid job(s)")

    except requests.exceptions.RequestException as e:
        print(f"    Request failed: {e}")
    except Exception as e:
        print(f"    Scraping failed: {e}")
        import traceback
        traceback.print_exc()

    return jobs


def scrape_jobteaser_to_dataframe(
    search_term: str,
    location: str,
    results_wanted: int = 10,
    fetch_description: bool = False
):
    """
    Scrape JobTeaser and return results in a pandas DataFrame
    (compatible with JobSpy format).

    Returns:
        pandas.DataFrame with columns matching JobSpy output
    """
    import pandas as pd

    jobs = scrape_jobteaser(search_term, location, results_wanted, fetch_description)

    if not jobs:
        return pd.DataFrame()

    df = pd.DataFrame(jobs)

    # Add columns expected by JobSpy
    df['site'] = 'jobteaser'
    df['date_posted'] = None
    df['job_type'] = None

    return df


if __name__ == "__main__":
    # Test the scraper
    print("Testing JobTeaser scraper...")
    print()

    jobs = scrape_jobteaser(
        search_term="stage développeur",
        location="Paris",
        results_wanted=5,
        fetch_description=False
    )

    print()
    print(f"Found {len(jobs)} jobs:")
    for i, job in enumerate(jobs, 1):
        print(f"{i}. {job['title']}")
        print(f"   Company: {job.get('company', 'N/A')}")
        print(f"   Location: {job.get('location', 'N/A')}")
        print(f"   URL: {job['job_url']}")
        print()
