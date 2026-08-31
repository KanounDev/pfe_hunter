# PFE Hunter - Testing Guide

Complete testing checklist for all features implemented in Steps 3-10.

## Prerequisites

Before testing, ensure all services are running:

```bash
# Terminal 1: Start PostgreSQL
# Ensure PostgreSQL is running on port 5432

# Terminal 2: Start Backend API
cd C:\Users\khale\Downloads\test_apify_gemini
node api.mjs

# Terminal 3: Start Frontend Dashboard
cd C:\Users\khale\Downloads\test_apify_gemini\dashboard
npm run dev
```

---

## Test Suite 1: Settings Management

### Test 1.1: Settings Page Load
**Steps:**
1. Navigate to `http://localhost:5173/settings`
2. Verify page loads without errors

**Expected Result:**
- ✅ Page displays all setting sections
- ✅ Current values are loaded from database
- ✅ No error messages displayed

### Test 1.2: Update Numeric Settings
**Steps:**
1. Change "Scrape Interval" to 60 minutes
2. Change "Results per Source" to 20
3. Change "Hours Old" to 24
4. Change "Fit Score Threshold" to 75
5. Click "Save Changes"

**Expected Result:**
- ✅ Success message: "Settings saved successfully!"
- ✅ Values persist after page refresh
- ✅ "Save Changes" button disabled after save

### Test 1.3: Validation - Numeric Bounds
**Steps:**
1. Set "Scrape Interval" to 1 (below minimum)
2. Click "Save Changes"

**Expected Result:**
- ✅ Error message: "Scrape interval must be between 5 and 1440 minutes"
- ✅ Settings not saved

**Repeat for:**
- Results per Source: 0 (min: 1) and 100 (max: 50)
- Hours Old: 0 (min: 1) and 200 (max: 168)
- Fit Score Threshold: -1 (min: 0) and 101 (max: 100)

### Test 1.4: Multiple Search Terms
**Steps:**
1. Enter "software engineer" in Search Terms field
2. Click "Add" or press Enter
3. Enter "data scientist"
4. Click "Add"
5. Enter "machine learning intern"
6. Click "Add"
7. Remove "data scientist" by clicking ×
8. Click "Save Changes"

**Expected Result:**
- ✅ Tags display correctly: "software engineer", "machine learning intern"
- ✅ "data scientist" removed successfully
- ✅ Settings saved with 2 search terms
- ✅ JSON array stored correctly in database

### Test 1.5: Multiple Locations
**Steps:**
1. Enter "Paris" in Locations field
2. Click "Add"
3. Enter "Lyon"
4. Click "Add"
5. Enter "Remote"
6. Click "Add"
7. Remove one location
8. Click "Save Changes"

**Expected Result:**
- ✅ All locations displayed as tags
- ✅ Removal works correctly
- ✅ Settings saved successfully

### Test 1.6: Job Sites Selection
**Steps:**
1. Uncheck all job sites
2. Click "Save Changes"

**Expected Result:**
- ✅ Error: "At least one job site must be selected"

**Steps (continued):**
1. Check "LinkedIn" and "Indeed"
2. Click "Save Changes"

**Expected Result:**
- ✅ Settings saved with 2 job sites selected
- ✅ Unchecked sites not included

### Test 1.7: Reset Functionality
**Steps:**
1. Click "Reset Changes" (after making changes)

**Expected Result:**
- ✅ Form reverts to last saved values
- ✅ "Save Changes" button disabled

**Steps (continued):**
1. Click "Reset to Defaults"

**Expected Result:**
- ✅ All settings revert to default values
- ✅ Confirmation prompt appeared
- ✅ Success message displayed

---

## Test Suite 2: CV Management

### Test 2.1: CV Upload - No File
**Steps:**
1. Navigate to Settings page
2. Click "Upload CV" without selecting a file
   (Note: If CV upload UI not on Settings page, add it)

**Expected Result:**
- ✅ Error message: "No file uploaded"

### Test 2.2: CV Upload - Invalid File Type
**Steps:**
1. Try to upload an image file (.jpg, .png)
2. Try to upload a text file (.txt)

**Expected Result:**
- ✅ Error: "Invalid file type. Only PDF and Word documents are allowed."
- ✅ File not uploaded

### Test 2.3: CV Upload - Valid PDF
**Steps:**
1. Select a PDF file (max 5MB)
2. Upload the file

**Expected Result:**
- ✅ Success message: "CV uploaded successfully"
- ✅ CV info displayed (filename, size, upload date)
- ✅ Previous CV (if any) deactivated

### Test 2.4: CV Download
**Steps:**
1. Click "Download CV" button

**Expected Result:**
- ✅ File downloads with correct filename
- ✅ File content matches original

### Test 2.5: CV Delete
**Steps:**
1. Click "Delete CV" button

**Expected Result:**
- ✅ Success message: "CV deleted successfully"
- ✅ CV removed from database and filesystem
- ✅ No CV info displayed

### Test 2.6: CV Upload - File Too Large
**Steps:**
1. Try to upload a PDF larger than 5MB

**Expected Result:**
- ✅ Error: "File too large. Maximum size is 5MB."

---

## Test Suite 3: "Run Now" Button

### Test 3.1: Trigger Pipeline Run
**Steps:**
1. Navigate to Dashboard
2. Click "▶️ Run Now" button

**Expected Result:**
- ✅ Button changes to "Running..." with pulsing animation
- ✅ Progress section appears
- ✅ Step indicator: "Initializing..."

### Test 3.2: Monitor Progress
**Steps:**
1. Wait for scraper to start

**Expected Result:**
- ✅ Step changes to "Scraping job postings"
- ✅ Progress bar animates
- ✅ Stats update: "📊 X found"

### Test 3.3: Scoring Phase
**Steps:**
1. Wait for scraping to complete

**Expected Result:**
- ✅ Step changes to "Scoring with Gemini AI"
- ✅ Stats show: "💾 X inserted"
- ✅ Progress bar advances

### Test 3.4: Completion
**Steps:**
1. Wait for scoring to complete

**Expected Result:**
- ✅ Step changes to "Completed"
- ✅ Status: "success"
- ✅ Success message with stats
- ✅ Elapsed time displayed

### Test 3.5: Concurrent Run Prevention
**Steps:**
1. While a run is in progress, click "Run Now" again

**Expected Result:**
- ✅ Error: "A pipeline run is already in progress"
- ✅ No duplicate run started

### Test 3.6: Failed Run Handling
**Steps:**
1. Temporarily break configuration (e.g., wrong database URL)
2. Trigger a run

**Expected Result:**
- ✅ Error message displayed
- ✅ Status: "failed"
- ✅ Error details shown

---

## Test Suite 4: Multi-Location/Multi-Search Scraping

### Test 4.1: Multiple Search Terms
**Steps:**
1. Navigate to Settings
2. Add search terms: "developer", "engineer", "intern"
3. Add location: "Paris"
4. Select job site: "LinkedIn"
5. Save settings
6. Run pipeline
7. Check logs

**Expected Result:**
- ✅ Scraper runs 3 times (one per search term)
- ✅ Each run logged with correct parameters
- ✅ All results collected and deduplicated

### Test 4.2: Multiple Locations
**Steps:**
1. Set search term: "software engineer"
2. Add locations: "Paris", "Lyon", "Bordeaux"
3. Select job site: "Indeed"
4. Save and run pipeline

**Expected Result:**
- ✅ Scraper runs 3 times (one per location)
- ✅ Jobs from all locations collected
- ✅ Location field correctly populated

### Test 4.3: Multiple Combinations
**Steps:**
1. Search terms: "developer", "engineer"
2. Locations: "Paris", "Remote"
3. Job sites: "LinkedIn", "Indeed"
4. Save and run pipeline

**Expected Result:**
- ✅ Total runs: 2 terms × 2 locations × 2 sites = 8 runs
- ✅ All combinations executed
- ✅ No duplicates in database

### Test 4.4: Deduplication
**Steps:**
1. Run pipeline with same settings twice
2. Check database

**Expected Result:**
- ✅ Second run finds same jobs
- ✅ No duplicates inserted (deduped)
- ✅ "postings_deduped" count increases

---

## Test Suite 5: Job Sites

### Test 5.1: LinkedIn Scraping
**Steps:**
1. Select only "LinkedIn" as job site
2. Run pipeline

**Expected Result:**
- ✅ Jobs scraped from LinkedIn
- ✅ Job URLs contain "linkedin.com"
- ✅ Job IDs start with "li-"

### Test 5.2: Indeed Scraping
**Steps:**
1. Select only "Indeed" as job site
2. Run pipeline

**Expected Result:**
- ✅ Jobs scraped from Indeed (France)
- ✅ Job URLs contain "indeed.com"
- ✅ Job IDs start with "in-"

### Test 5.3: JobTeaser Scraping
**Steps:**
1. Select only "JobTeaser" as job site
2. Run pipeline

**Expected Result:**
- ✅ Jobs scraped (if dependencies installed)
- ✅ Or clear error message if dependencies missing
- ✅ Job IDs start with "jt-"

### Test 5.4: All Sites Together
**Steps:**
1. Select all three job sites
2. Run pipeline

**Expected Result:**
- ✅ Jobs collected from all sites
- ✅ Source field correctly identifies site
- ✅ No conflicts between sources

---

## Test Suite 6: Fit Score & Notifications

### Test 6.1: Fit Score Calculation
**Steps:**
1. Ensure CV is uploaded
2. Run pipeline
3. Check job postings

**Expected Result:**
- ✅ New jobs have fit_score (0-100)
- ✅ fit_reasoning populated
- ✅ scored_at timestamp set

### Test 6.2: Threshold Filtering
**Steps:**
1. Set fit_score_threshold to 80
2. Run pipeline
3. Check notifications

**Expected Result:**
- ✅ Only jobs with score ≥ 80 trigger notifications
- ✅ Lower-scored jobs still saved but not notified

### Test 6.3: Fit Score Info Modal
**Steps:**
1. Navigate to Dashboard
2. Click ℹ️ icon next to "Average Fit Score"

**Expected Result:**
- ✅ Modal opens with detailed explanation
- ✅ Score ranges displayed with colors
- ✅ Rate limit info shown
- ✅ Tips for improving scores visible
- ✅ Close button works

---

## Test Suite 7: Error Handling

### Test 7.1: Database Connection Lost
**Steps:**
1. Stop PostgreSQL
2. Try to load Dashboard

**Expected Result:**
- ✅ Error message: "Cannot connect to API server"
- ✅ Retry button available
- ✅ No app crash

### Test 7.2: API Server Down
**Steps:**
1. Stop Node.js API server
2. Try to navigate to Settings

**Expected Result:**
- ✅ Error message displayed
- ✅ Retry option available
- ✅ Loading state clears

### Test 7.3: Invalid Settings Data
**Steps:**
1. Manually insert invalid JSON in database
2. Load Settings page

**Expected Result:**
- ✅ Graceful fallback to defaults
- ✅ Error logged but page loads
- ✅ User can reset to fix

### Test 7.4: Network Timeout
**Steps:**
1. Slow down network (browser dev tools)
2. Trigger pipeline run

**Expected Result:**
- ✅ Loading states show
- ✅ Eventually times out with clear error
- ✅ Retry logic attempts (up to 3 times)

---

## Test Suite 8: UI/UX

### Test 8.1: Responsive Design
**Steps:**
1. Open dashboard on mobile viewport (375px)
2. Check all pages

**Expected Result:**
- ✅ Navigation collapses or scrolls
- ✅ Cards stack vertically
- ✅ Buttons remain clickable
- ✅ Text readable

### Test 8.2: Dark/Light Theme
**Steps:**
1. Click theme toggle (☀️/🌙)
2. Check all pages

**Expected Result:**
- ✅ All components adapt to theme
- ✅ Colors readable in both modes
- ✅ Preference saved to localStorage

### Test 8.3: Loading States
**Steps:**
1. Slow down API responses
2. Observe loading states

**Expected Result:**
- ✅ Skeleton loaders show for stats
- ✅ Spinner for async operations
- ✅ Disabled buttons during loading

### Test 8.4: Accessibility
**Steps:**
1. Navigate using keyboard only
2. Use screen reader

**Expected Result:**
- ✅ All interactive elements focusable
- ✅ ARIA labels present
- ✅ Logical tab order
- ✅ Screen reader announces content

---

## Test Suite 9: Performance

### Test 9.1: Large Dataset
**Steps:**
1. Insert 1000+ job postings
2. Load Dashboard
3. Load Postings page

**Expected Result:**
- ✅ Dashboard loads in < 2 seconds
- ✅ Pagination works on Postings page
- ✅ No browser lag

### Test 9.2: Rapid Updates
**Steps:**
1. Click "Run Now" multiple times quickly

**Expected Result:**
- ✅ Only one run executes
- ✅ Subsequent clicks rejected with message
- ✅ No race conditions

### Test 9.3: Memory Leaks
**Steps:**
1. Open browser dev tools (Memory tab)
2. Navigate between pages 10 times
3. Check memory usage

**Expected Result:**
- ✅ Memory usage stable
- ✅ No significant leaks detected

---

## Test Suite 10: Integration

### Test 10.1: Full Pipeline Flow
**Steps:**
1. Upload CV
2. Configure settings (multi-term, multi-location)
3. Run pipeline
4. Check results

**Expected Result:**
- ✅ All jobs scraped and scored
- ✅ Notifications sent for high-fit jobs
- ✅ Dashboard shows updated stats
- ✅ Postings table shows new jobs

### Test 10.2: Periodic Scraping
**Steps:**
1. Set scrape interval to 5 minutes
2. Start periodic scraper: `python scrape_jobspy.py --periodic`
3. Wait 10 minutes

**Expected Result:**
- ✅ First run executes immediately
- ✅ Second run after 5 minutes
- ✅ Results logged correctly

### Test 10.3: Settings Persistence
**Steps:**
1. Change multiple settings
2. Restart API server
3. Reload page

**Expected Result:**
- ✅ All settings persisted
- ✅ Values match last save

---

## Test Results Template

Use this template to track test results:

```markdown
## Test Execution Report

**Date:** 2026-08-30
**Tester:** [Name]
**Environment:** Windows 11, Node.js vX.X.X, PostgreSQL vX.X

### Suite 1: Settings Management
- [ ] 1.1 Settings Page Load - PASS/FAIL
- [ ] 1.2 Update Numeric Settings - PASS/FAIL
- [ ] 1.3 Validation - Numeric Bounds - PASS/FAIL
- [ ] 1.4 Multiple Search Terms - PASS/FAIL
- [ ] 1.5 Multiple Locations - PASS/FAIL
- [ ] 1.6 Job Sites Selection - PASS/FAIL
- [ ] 1.7 Reset Functionality - PASS/FAIL

### Suite 2: CV Management
- [ ] 2.1 CV Upload - No File - PASS/FAIL
- [ ] 2.2 CV Upload - Invalid File Type - PASS/FAIL
- [ ] 2.3 CV Upload - Valid PDF - PASS/FAIL
- [ ] 2.4 CV Download - PASS/FAIL
- [ ] 2.5 CV Delete - PASS/FAIL
- [ ] 2.6 CV Upload - File Too Large - PASS/FAIL

### Suite 3: "Run Now" Button
- [ ] 3.1 Trigger Pipeline Run - PASS/FAIL
- [ ] 3.2 Monitor Progress - PASS/FAIL
- [ ] 3.3 Scoring Phase - PASS/FAIL
- [ ] 3.4 Completion - PASS/FAIL
- [ ] 3.5 Concurrent Run Prevention - PASS/FAIL
- [ ] 3.6 Failed Run Handling - PASS/FAIL

### Suite 4: Multi-Location/Multi-Search
- [ ] 4.1 Multiple Search Terms - PASS/FAIL
- [ ] 4.2 Multiple Locations - PASS/FAIL
- [ ] 4.3 Multiple Combinations - PASS/FAIL
- [ ] 4.4 Deduplication - PASS/FAIL

### Suite 5: Job Sites
- [ ] 5.1 LinkedIn Scraping - PASS/FAIL
- [ ] 5.2 Indeed Scraping - PASS/FAIL
- [ ] 5.3 JobTeaser Scraping - PASS/FAIL
- [ ] 5.4 All Sites Together - PASS/FAIL

### Suite 6: Fit Score & Notifications
- [ ] 6.1 Fit Score Calculation - PASS/FAIL
- [ ] 6.2 Threshold Filtering - PASS/FAIL
- [ ] 6.3 Fit Score Info Modal - PASS/FAIL

### Suite 7: Error Handling
- [ ] 7.1 Database Connection Lost - PASS/FAIL
- [ ] 7.2 API Server Down - PASS/FAIL
- [ ] 7.3 Invalid Settings Data - PASS/FAIL
- [ ] 7.4 Network Timeout - PASS/FAIL

### Suite 8: UI/UX
- [ ] 8.1 Responsive Design - PASS/FAIL
- [ ] 8.2 Dark/Light Theme - PASS/FAIL
- [ ] 8.3 Loading States - PASS/FAIL
- [ ] 8.4 Accessibility - PASS/FAIL

### Suite 9: Performance
- [ ] 9.1 Large Dataset - PASS/FAIL
- [ ] 9.2 Rapid Updates - PASS/FAIL
- [ ] 9.3 Memory Leaks - PASS/FAIL

### Suite 10: Integration
- [ ] 10.1 Full Pipeline Flow - PASS/FAIL
- [ ] 10.2 Periodic Scraping - PASS/FAIL
- [ ] 10.3 Settings Persistence - PASS/FAIL

### Issues Found:
1. [Description] - Priority: High/Medium/Low
2. [Description] - Priority: High/Medium/Low

### Recommendations:
1. [Improvement suggestion]
2. [Enhancement suggestion]
```

---

## Automated Testing Script

Create a test script to automate basic checks:

```bash
#!/bin/bash
# test_pfe_hunter.sh

echo "=== PFE Hunter Automated Tests ==="

# Test API health
echo "Testing API health..."
curl -s http://localhost:3001/api/health | jq .

# Test settings retrieval
echo -e "\nTesting settings retrieval..."
curl -s http://localhost:3001/api/settings | jq .

# Test CV endpoints
echo -e "\nTesting CV endpoints..."
curl -s http://localhost:3001/api/cv | jq .

# Test pipeline status
echo -e "\nTesting pipeline status..."
curl -s http://localhost:3001/api/pipeline/status | jq .

# Test stats
echo -e "\nTesting stats..."
curl -s http://localhost:3001/api/stats | jq .

echo -e "\n=== All tests completed ==="
```

Run with: `bash test_pfe_hunter.sh`
