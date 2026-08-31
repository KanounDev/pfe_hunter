#!/bin/bash
# quick_test.sh - Quick verification of PFE Hunter components

echo "========================================="
echo "PFE Hunter Quick Test Suite"
echo "========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test counter
PASS=0
FAIL=0

# Function to test endpoint
test_endpoint() {
    local name=$1
    local url=$2
    local expected_status=${3:-200}

    echo -n "Testing $name... "

    response=$(curl -s -w "\n%{http_code}" "$url" 2>&1)
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" -eq "$expected_status" ]; then
        echo -e "${GREEN}✓ PASS${NC} (HTTP $http_code)"
        PASS=$((PASS + 1))
        return 0
    else
        echo -e "${RED}✗ FAIL${NC} (Expected HTTP $expected_status, got $http_code)"
        FAIL=$((FAIL + 1))
        return 1
    fi
}

# Check if API server is running
echo "Step 1: Checking API Server"
echo "-----------------------------------------"
if curl -s --connect-timeout 5 http://localhost:3001/api/health > /dev/null 2>&1; then
    echo -e "API Server: ${GREEN}Running${NC}"
    echo ""
else
    echo -e "API Server: ${RED}Not Running${NC}"
    echo "Please start the API server: node api.mjs"
    echo ""
    exit 1
fi

# Run tests
echo "Step 2: Running API Tests"
echo "-----------------------------------------"
test_endpoint "Health Check" "http://localhost:3001/api/health"
test_endpoint "Get Settings" "http://localhost:3001/api/settings"
test_endpoint "Get Stats" "http://localhost:3001/api/stats"
test_endpoint "Get Postings" "http://localhost:3001/api/postings"
test_endpoint "Get Companies" "http://localhost:3001/api/companies"
test_endpoint "Get Locations" "http://localhost:3001/api/locations"
test_endpoint "Get CV" "http://localhost:3001/api/cv"
test_endpoint "Get Pipeline Status" "http://localhost:3001/api/pipeline/status"
test_endpoint "Get Pipeline Runs" "http://localhost:3001/api/pipeline/runs"
test_endpoint "Get Distribution" "http://localhost:3001/api/distribution"

echo ""
echo "Step 3: Testing Settings Update"
echo "-----------------------------------------"

# Test settings update
echo -n "Testing settings update... "
update_result=$(curl -s -X PUT http://localhost:3001/api/settings/fit_score_threshold \
  -H "Content-Type: application/json" \
  -d '{"value":"75"}')

if echo "$update_result" | grep -q "fit_score_threshold"; then
    echo -e "${GREEN}✓ PASS${NC}"
    PASS=$((PASS + 1))
else
    echo -e "${RED}✗ FAIL${NC}"
    FAIL=$((FAIL + 1))
fi

echo ""
echo "Step 4: Verifying Database Connection"
echo "-----------------------------------------"

# Test database by checking stats
echo -n "Testing database connectivity... "
stats=$(curl -s http://localhost:3001/api/stats)

if echo "$stats" | grep -q "total"; then
    echo -e "${GREEN}✓ PASS${NC}"
    echo "  Database contains $(echo "$stats" | grep -o '"total":[0-9]*' | grep -o '[0-9]*') job postings"
    PASS=$((PASS + 1))
else
    echo -e "${RED}✗ FAIL${NC}"
    FAIL=$((FAIL + 1))
fi

echo ""
echo "========================================="
echo "Test Results Summary"
echo "========================================="
echo -e "Passed: ${GREEN}$PASS${NC}"
echo -e "Failed: ${RED}$FAIL${NC}"
echo ""

if [ $FAIL -eq 0 ]; then
    echo -e "${GREEN}All tests passed! ✓${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Test frontend: npm run dev (in dashboard/ directory)"
    echo "  2. Navigate to http://localhost:5173"
    echo "  3. Test Settings page: http://localhost:5173/settings"
    echo "  4. Test 'Run Now' button on Dashboard"
    echo "  5. Test CV upload via Settings page"
    exit 0
else
    echo -e "${RED}Some tests failed. Check API logs for details.${NC}"
    exit 1
fi
