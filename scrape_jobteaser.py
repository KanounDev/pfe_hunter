# scrape_jobteaser.py
#
# Custom JobTeaser scraper for PFE Hunter.
# JobTeaser is not supported by JobSpy, so this implements direct scraping.
#
# 2026-09 UPDATE: JobTeaser reworked their search page:
#   - Search endpoint moved from /fr/jobs?query=... (now HTTP 410 Gone)
#     to /fr/job-offers?q=...&location=...
#   - Job detail URLs now embed a UUID:
#     /fr/job-offers/<uuid>-<slug>
#   - The site sits behind a Cloudflare managed challenge ("JobTeaser |
#     Security checkup", Cf-Mitigated: challenge). Plain `requests` gets a
#     403, so we fetch through curl_cffi with browser TLS impersonation
#     (impersonate="chrome"), which passes the check. A plain-requests
#     fallback is kept for environments without curl_cffi, but it will
#     usually be blocked.
#
# Page structure (CSS modules — hash suffix may change between builds, the
# "JobAdCard-module__" prefix is the stable part):
#   <div class="JobAdCard-module__<hash>__main">
#     <header class="JobAdCard-module__<hash>__header">
#       <p class="JobAdCard-module__<hash>__companyName">Welo Data</p>
#       <h3><a class="JobAdCard-module__<hash>__link" href="/fr/job-offers/...">
#             French AI Voice Trainer</a></h3>
#     <div class="JobAdCard-module__<hash>__body">
#       <div class="JobAdCard-module__<hash>__contractInfo">Freelance/Indépendant</div>
#       <div class="JobAdCard-module__<hash>__contractInfo">France</div>
#
# SETUP:
#   pip install requests beautifulsoup4 lxml curl-cffi
#
# USAGE:
#   from scrape_jobteaser import scrape_jobteaser
#   jobs = scrape_jobteaser("software engineer", "Paris", 10)

import hashlib
import re
import time
from typing import Optional, List, Dict, Any

try:
    import requests
    from bs4 import BeautifulSoup
    HAS_DEPS = True
except ImportError:
    HAS_DEPS = False
    print("WARNING: requests or beautifulsoup4 not installed. JobTeaser scraping disabled.")
    print("Install with: pip install requests beautifulsoup4 lxml curl-cffi")

# Browser TLS impersonation — required to pass JobTeaser's Cloudflare check.
try:
    from curl_cffi import requests as cffi_requests
    HAS_CURL_CFFI = True
except ImportError:
    HAS_CURL_CFFI = False
    print("WARNING: curl-cffi not installed — JobTeaser requests will likely be "
          "blocked by Cloudflare. Install with: pip install curl-cffi")

# Prefer lxml (fast); fall back to the stdlib parser when it's missing.
try:
    import lxml  # noqa: F401
    BS_PARSER = 'lxml'
except ImportError:
    BS_PARSER = 'html.parser'


JOBTEASER_BASE_URL = "https://www.jobteaser.com"
JOBTEASER_SEARCH_URL = f"{JOBTEASER_BASE_URL}/fr/job-offers"

# Headers to mimic a real browser (curl_cffi also impersonates TLS + HTTP/2)
HEADERS = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    'Upgrade-Insecure-Requests': '1',
}

# CSS-module stable prefixes (hash suffixes change between site builds)
CARD_LINK_CLASS = re.compile(r'JobAdCard-module__\S*__link')
COMPANY_CLASS = re.compile(r'JobAdCard-module__\S*__companyName')
CONTRACT_INFO_CLASS = re.compile(r'JobAdCard-module__\S*__contractInfo')
JOBAD_CLASS = re.compile(r'JobAdCard-module__')

# Job detail URL: /fr/job-offers/<uuid>-<slug> (also accept legacy <slug>-<int>)
UUID_RE = re.compile(
    r'/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})'
)

# Keywords that identify a contract-type chip rather than a location chip
CONTRACT_KEYWORDS = re.compile(
    r'stage|alternance|internship|apprenticeship|apprentissage|cdi|cdd|'
    r'freelance|indépendant|independant|temps plein|temps partiel|full.?time|'
    r'part.?time|permanent|contract|vie|v.i.e',
    re.I,
)


def _http_get(url: str, timeout: int = 30, params: Optional[Dict[str, Any]] = None):
    """GET `url` with browser impersonation when available.

    Returns a response-like object (curl_cffi or requests) whose .status_code
    and .text can be used directly.
    """
    if HAS_CURL_CFFI:
        return cffi_requests.get(url, headers=HEADERS, timeout=timeout,
                                 params=params, impersonate='chrome')
    return requests.get(url, headers=HEADERS, timeout=timeout, params=params)



# Emoji / symbol ranges to strip (keeps accented letters like é, à, ç intact)
EMOJI_RE = re.compile(
    '[\\U0001F000-\\U0001FAFF'   # pictographs, transport, supplemental symbols
    '\\U00002600-\\U000027BF'    # misc symbols, dingbats
    '\\U0001F1E6-\\U0001F1FF'    # regional indicators (flags)
    '\\uFE0F\\u200D]'            # variation selectors, zero-width joiners
)


def strip_emojis(text: Optional[str]) -> Optional[str]:
    """Remove emojis and other symbols, preserving accented letters."""
    if not text:
        return text
    return EMOJI_RE.sub('', text).strip()


def derive_jobteaser_id(job_url: str) -> str:
    """Generate a stable job ID from a JobTeaser URL.

    Detail URLs embed a UUID since the 2026-09 redesign:
      https://www.jobteaser.com/fr/job-offers/<uuid>-<slug>
    Legacy URLs ended with -<integer>.
    """
    uuid_match = UUID_RE.search(job_url)
    if uuid_match:
        return f"jt-{uuid_match.group(1)}"

    match = re.search(r'-(\d+)$', job_url)
    if match:
        return f"jt-{match.group(1)}"

    # Fallback: hash the URL
    return f"jt-{hashlib.sha256(job_url.encode('utf-8')).hexdigest()[:16]}"


def parse_job_listing(job_element, base_url: str) -> Optional[Dict[str, Any]]:
    """
    Parse one JobTeaser job card from the search results page.

    `job_element` can be the card's <a> link or the card root — the card root
    (outermost element carrying a JobAdCard-module class) is resolved either
    way. Returns a standardized job dictionary.
    """
    try:
        # Locate the card link
        elem_classes = ' '.join(job_element.get('class') or []) if getattr(job_element, 'name', None) else ''
        if job_element.name == 'a' and CARD_LINK_CLASS.search(elem_classes):
            link_elem = job_element
        else:
            link_elem = (
                job_element.find('a', class_=CARD_LINK_CLASS) or
                job_element.find('a', href=re.compile(r'/fr/job[_-]offers?/'))
            )
        if not link_elem:
            return None

        job_url = link_elem.get('href', '')
        if not job_url:
            return None
        if not job_url.startswith('http'):
            job_url = base_url + job_url

        # Card root = outermost ancestor carrying a JobAdCard-module class
        card = link_elem
        while card.parent is not None:
            parent_classes = ' '.join(card.parent.get('class') or [])
            if not JOBAD_CLASS.search(parent_classes):
                break
            card = card.parent

        # Title: the link text, else the first heading inside the card
        title = link_elem.get_text(strip=True)
        if not title:
            title_elem = card.find(['h2', 'h3', 'h4'])
            title = title_elem.get_text(strip=True) if title_elem else ''
        if not title:
            return None

        # Company: first companyName element inside the card
        company_elem = card.find(class_=COMPANY_CLASS)
        company = company_elem.get_text(strip=True) if company_elem else None

        # contractInfo chips hold [contract-type, location] (sometimes more).
        # The location chip is the one that is NOT a contract keyword.
        chips = [c.get_text(strip=True) for c in card.find_all(class_=CONTRACT_INFO_CLASS)]
        chips = [c for c in chips if c]
        location = None
        for chip in reversed(chips):
            if not CONTRACT_KEYWORDS.search(chip):
                location = chip
                break
        if location is None and chips:
            location = chips[-1]

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
        response = _http_get(job_url, timeout=30)
        response.raise_for_status()

        soup = BeautifulSoup(response.text, BS_PARSER)

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

def _search_jobteaser(search_term: str, location: Optional[str], contract_type: Optional[str], results_wanted: int) -> List[Dict[str, Any]]:
    """One search request against the /fr/job-offers page → parsed jobs.

    Returns [] on Cloudflare block, dead endpoint, or genuinely no results.
    """
    jobs = []

    try:
        # JobTeaser search URL format (2026-09 redesign):
        # https://www.jobteaser.com/fr/job-offers?q=software+engineer&location=France
        # (the old /fr/jobs?query=... endpoint returns HTTP 410 Gone)
        params = {'q': search_term}
        if location:
            params['location'] = location
        if contract_type:
            params['contract'] = contract_type

        # Make request — browser-impersonated to pass the Cloudflare check
        response = _http_get(JOBTEASER_SEARCH_URL, params=params, timeout=30)

        if response.status_code == 403:
            print(f"    Blocked by Cloudflare (403 'Security checkup').")
            if not HAS_CURL_CFFI:
                print(f"    Install curl-cffi for browser TLS impersonation: pip install curl-cffi")
            return []

        if response.status_code in (404, 410):
            print(f"    JobTeaser search endpoint unavailable ({response.status_code}) — the site layout may have changed again")
            return []

        response.raise_for_status()

        # Parse HTML
        soup = BeautifulSoup(response.text, BS_PARSER)

        # Find job cards: <a class="JobAdCard-module__<hash>__link"
        #                   href="/fr/job-offers/<uuid>-<slug>">
        link_elements = soup.find_all(
            'a', class_=CARD_LINK_CLASS, href=re.compile(r'/fr/job[_-]offers?/')
        )

        if not link_elements:
            print(f"    No job listings found on page")
            # Debug: save the HTML for analysis
            debug_file = f"jobteaser_debug_{int(time.time())}.html"
            with open(debug_file, 'w', encoding='utf-8') as f:
                f.write(response.text)
            print(f"    Saved debug HTML to {debug_file}")
            return []

        print(f"    Found {len(link_elements)} job card(s) on page")

        # Parse each job listing (dedupe — a card can expose its link twice)
        seen_ids = set()
        for link_elem in link_elements:
            if len(jobs) >= results_wanted:
                break

            job = parse_job_listing(link_elem, JOBTEASER_BASE_URL)
            if job and job['job_id'] not in seen_ids:
                seen_ids.add(job['job_id'])
                jobs.append(job)

        print(f"    Parsed {len(jobs)} valid job(s)")

    except requests.exceptions.RequestException as e:
        print(f"    Request failed: {e}")
    except Exception as e:
        print(f"    Scraping failed: {e}")
        import traceback
        traceback.print_exc()

    return jobs


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
        location: Location to search in (e.g., "France", "Paris", "Lyon")
        results_wanted: Maximum number of results to return
        fetch_description: Whether to fetch full job descriptions (slower)
        contract_type: Filter by contract type (e.g., "internship", "alternance", "cdi")

    Location note: since the 2026-09 redesign the search only matches
    geocoded REGION names ("France" works; free-text cities like "Paris"
    return zero rows). When a location yields nothing, we retry nationwide
    rather than coming back empty-handed.

    Returns:
        List of job dictionaries with standardized format
    """
    if not HAS_DEPS:
        print("  ERROR: Missing dependencies for JobTeaser scraping")
        print("    Install with: pip install requests beautifulsoup4 lxml curl-cffi")
        return []

    print(f"  Scraping JobTeaser: '{search_term}' in '{location}'...")

    jobs = _search_jobteaser(search_term, location, contract_type, results_wanted)

    # City-level locations return zero rows on the new search — retry without
    # the location filter so JobTeaser still contributes results.
    if not jobs and location:
        print(f"    No results for '{location}' (new JobTeaser search only matches region names) — retrying nationwide...")
        jobs = _search_jobteaser(search_term, None, contract_type, results_wanted)

    # Optionally fetch full descriptions
    if fetch_description:
        for job in jobs:
            print(f"      Fetching description for: {job['title'][:50]}...")
            job['description'] = fetch_job_description(job['job_url'])
            time.sleep(1)  # Be polite to the server

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
