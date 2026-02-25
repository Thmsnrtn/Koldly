#!/bin/bash

BASE_URL="https://koldly.polsia.app"
RESULTS="test-results.txt"
echo "=== KOLDLY FLOW AUDIT ===" > $RESULTS

# Test 1: Landing page
echo "Test 1: Landing page" >> $RESULTS
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/")
echo "  Landing page: HTTP $HTTP_CODE" >> $RESULTS

# Test 2: Signup page
echo "Test 2: Signup page" >> $RESULTS
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/signup")
echo "  Signup page: HTTP $HTTP_CODE" >> $RESULTS

# Test 3: Login page
echo "Test 3: Login page" >> $RESULTS
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/login")
echo "  Login page: HTTP $HTTP_CODE" >> $RESULTS

# Test 4: Pricing page
echo "Test 4: Pricing page" >> $RESULTS
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/pricing")
echo "  Pricing page: HTTP $HTTP_CODE" >> $RESULTS

# Test 5: Dashboard (should redirect unauthenticated)
echo "Test 5: Dashboard (should redirect unauthenticated)" >> $RESULTS
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/dashboard")
echo "  Dashboard unauthenticated: HTTP $HTTP_CODE" >> $RESULTS

# Test 6: API Auth config
echo "Test 6: API Auth config" >> $RESULTS
curl -s "$BASE_URL/api/auth/config" >> $RESULTS
echo "" >> $RESULTS

cat $RESULTS
