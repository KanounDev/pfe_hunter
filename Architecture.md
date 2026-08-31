### Architecture Data Flow Breakdown

*   **Data Source & Scraping:**
    *   **LinkedIn Jobs** serves as the initial data source.
    *   The **JobSpy Scraper** (Python, open-source, no credits) scrapes job postings from LinkedIn. 
    *   This scraping process occurs every 6 hours and pulls 25 or fewer postings per run.
*   **Data Processing & Storage:**
    *   The scraper sends the raw postings as JSON to the **Backend API** (Node.js/TypeScript).
    *   The Backend API communicates with a **Database** (Postgres/SQLite on Supabase free tier).
    *   The database runs a deduplication check against existing records before scoring.
    *   The API stores new postings, fit scores, and seen `job_ids` (for deduplication) in the database.
*   **AI Analysis & Tooling:**
    *   The Backend API sends only new postings to the **LLM Agent** (Gemini API on a free tier).
    *   These are sent as one batched Gemini call per run, consisting of approximately 15-25 postings per call.
    *   If the LLM Agent determines a fit score of 70 or higher, it triggers a tool call to the **MCP Tool Layer** (Tool connections).
*   **User Delivery & Interfaces:**
    *   The MCP Tool Layer sends a digest to **Notifications** (Telegram/Discord, free, no card) a maximum of 4 times per day.
    *   These Notifications are delivered to the **User** as digest alerts.
    *   Additionally, a **React Dashboard** (Tracked postings and fit scores, hosted free on Vercel) is connected bi-directionally to the Database.
    *   The User can access this dashboard to view the tracked postings and scores.