# PHASE 2: MATURITY ROADMAP

**Target:** Transform Koldly from fragile MVP to production-hardened SaaS
**Timeline:** 6 phased implementation sprints
**Starting Date:** 2026-02-23

---

## STABILIZE (Critical Issues) - Sprints 1-2

### Sprint 1A: Fix Deployment & Infrastructure (HIGH PRIORITY)

**Scope:** Prevent data loss and deployment hangs

| Item | Files | Risk | Acceptance |
|------|-------|------|-----------|
| **1. Fix render.yaml buildCommand** | render.yaml | CRITICAL | `buildCommand: npm run build` set; deploys run migrations before startup |
| **2. Add connectionTimeoutMillis** | server.js (Pool config) | CRITICAL | Pool({ connectionTimeoutMillis: 10000 }) set; DB timeouts don't hang |
| **3. Update SSL connection string** | server.js, migrate.js | LOW | sslmode=require → sslmode=verify-full; no SSL warnings in logs |
| **4. Add /health?check=db endpoint** | server.js | MEDIUM | /health?check=db tests actual DB connection; returns 503 on failure |

**Effort:** 1 hour
**Test:** Deploy to prod, verify migrations run, check health endpoint
**Commit:** "Infra: Fix render.yaml buildCommand, connectionTimeoutMillis, SSL config"

---

### Sprint 1B: Add Resilience Layer (HIGH PRIORITY)

**Scope:** Prevent transient failures from becoming user-facing errors

| Item | Files | Risk | Acceptance |
|------|-------|------|-----------|
| **1. Add fetchWithRetry() middleware** | lib/retry-service.js (new) | MEDIUM | 3 retry attempts on transient errors; exponential backoff (100→200→400ms) |
| **2. Add request timeouts** | server.js (all async routes) | MEDIUM | 12s timeout on /api/auth/me, 30s on campaign operations, 60s on analytics |
| **3. Add idempotency keys** | lib/idempotency.js (new) | MEDIUM | Duplicate requests ignored; campaign creation is idempotent |
| **4. Global error catcher** | server.js (middleware) | MEDIUM | Unhandled route errors caught, logged, respond 500 with user-friendly message |

**Effort:** 2 hours
**Test:** Simulate transient failures (timeout, retry, then success); verify idempotency on double-click
**Commit:** "Reliability: Add retry logic, timeouts, idempotency, global error handler"

---

### Sprint 1C: Security Hardening (MEDIUM PRIORITY)

**Scope:** Prevent common attacks and data leaks

| Item | Files | Risk | Acceptance |
|------|-------|------|-----------|
| **1. Add audit logging** | lib/audit-logger.js (new); update all mutation endpoints | MEDIUM | Login, password change, campaign delete logged with user_id, timestamp, IP |
| **2. Add SQL injection test** | migrations/audit_logging.js, verify endpoints | MEDIUM | Query builder prevents injection; test with malicious input |
| **3. Add XSS prevention** | public/*.html (check output encoding) | MEDIUM | All user input escaped in HTML; test with <script>alert('xss')</script> |
| **4. Add CSRF protection** | server.js (middleware) | LOW | Same-site cookie flag set to Strict |

**Effort:** 2 hours
**Test:** Verify audit logs are written; test XSS input is escaped; check CSRF headers
**Commit:** "Security: Add audit logging, XSS prevention, CSRF headers"

---

## HARDEN (Testing & Validation) - Sprints 3-4

### Sprint 2A: Add Unit Tests (HIGH PRIORITY)

**Scope:** Test all business logic in isolation

| Item | Files | Risk | Acceptance |
|------|-------|------|-----------|
| **1. Setup Jest** | package.json, jest.config.js (new) | LOW | Jest installed; npm test runs |
| **2. Test auth service** | tests/auth-service.test.js (new) | MEDIUM | bcrypt hashing, JWT generation, password validation tested |
| **3. Test form validation** | tests/forms.test.js (new) | MEDIUM | Email validation, password strength, required fields tested |
| **4. Test helpers/utilities** | tests/utils.test.js (new) | LOW | Date formatting, parsing, truncation tested |

**Files Changed:** 6
**Effort:** 3 hours
**Test:** npm test runs all tests; coverage >70% on critical paths
**Commit:** "Testing: Add Jest + unit tests for auth, forms, utilities"

---

### Sprint 2B: Add Integration Tests (HIGH PRIORITY)

**Scope:** Test API endpoints end-to-end with database

| Item | Files | Risk | Acceptance |
|------|-------|------|-----------|
| **1. Setup test database** | tests/setup.js (new) | MEDIUM | Separate test DB created; migrations run on startup |
| **2. Test auth endpoints** | tests/api/auth.test.js (new) | MEDIUM | /signup, /login, /verify-email, /password-reset all tested with edge cases |
| **3. Test campaign CRUD** | tests/api/campaigns.test.js (new) | HIGH | Campaign creation, listing, update, deletion tested; auth required |
| **4. Test protected routes** | tests/api/protection.test.js (new) | MEDIUM | /dashboard while logged out redirects; invalid JWT returns 401 |

**Files Changed:** 5
**Effort:** 4 hours
**Test:** npm test passes all integration tests; API returns correct status codes and data
**Commit:** "Testing: Add integration tests for auth, campaigns, protection"

---

### Sprint 2C: Add E2E Test Script (MEDIUM PRIORITY)

**Scope:** Verify core user journey works end-to-end

| Item | Files | Risk | Acceptance |
|------|-------|------|-----------|
| **1. Create E2E test script** | tests/e2e-flow.js (new) | MEDIUM | Full user journey: signup→login→create campaign→view analytics→logout |
| **2. Edge case tests** | tests/edge-cases.js (new) | MEDIUM | Concurrent requests, expired tokens, malformed input all tested |
| **3. Performance baseline** | tests/performance.test.js (new) | LOW | Measure response times; alert if >2s |

**Files Changed:** 3
**Effort:** 2 hours
**Test:** E2E script runs successfully; all journeys complete without errors
**Commit:** "Testing: Add E2E script + edge case + performance tests"

---

## POLISH (UX/Observability) - Sprints 5-6

### Sprint 3A: Add Structured Logging (MEDIUM PRIORITY)

**Scope:** Make production debugging possible

| Item | Files | Risk | Acceptance |
|------|-------|------|-----------|
| **1. Add request logging middleware** | lib/request-logger.js (new) | LOW | Every request logged with: method, path, status, duration, user_id |
| **2. Add request ID tracking** | server.js (add req.id = uuid()) | LOW | Every log includes request ID for tracing |
| **3. Standardize log format** | All .js files (update console calls) | MEDIUM | All logs JSON-formatted: {level, timestamp, req_id, message, context} |
| **4. Add error reporting** | lib/error-reporter.js (new) | MEDIUM | Unhandled errors sent to Sentry or similar; production debug link |

**Files Changed:** 10+
**Effort:** 2.5 hours
**Test:** Deploy; check logs are structured JSON; verify Sentry receives errors
**Commit:** "Observability: Add structured logging, request IDs, error reporting"

---

### Sprint 3B: Add Response Monitoring (MEDIUM PRIORITY)

**Scope:** Track performance trends

| Item | Files | Risk | Acceptance |
|------|-------|------|-----------|
| **1. Add response time logging** | server.js (middleware) | LOW | Every endpoint logs response time; flag >1s as "slow" |
| **2. Add database pool monitoring** | lib/db-monitor.js (new) | LOW | Log pool status: active connections, waiting queue, idle |
| **3. Add error rate tracking** | lib/error-tracker.js (new) | LOW | Count 5xx errors per minute; alert if >10% |
| **4. Create /metrics endpoint** | server.js (add /metrics) | MEDIUM | /metrics returns JSON: uptime, request count, error count, avg response time |

**Files Changed:** 5
**Effort:** 1.5 hours
**Test:** Make requests; check logs for response times; verify /metrics endpoint
**Commit:** "Observability: Add response monitoring, pool monitoring, metrics"

---

### Sprint 3C: Polish Empty/Loading/Error States (MEDIUM PRIORITY)

**Scope:** Perfect UX on all edge cases

| Item | Files | Risk | Acceptance |
|------|-------|------|-----------|
| **1. Add retry UI** | public/js/retry-ui.js (new) | MEDIUM | Failed requests show "Retry" button; auto-retry transient errors |
| **2. Add slow network detection** | public/js/network-status.js (new) | LOW | Toast notification if network is slow (>3s for request) |
| **3. Add loading state on all data pages** | public/*.html (update) | MEDIUM | All pages show skeleton while loading; no blank pages |
| **4. Add empty state CTAs** | public/*.html (update) | LOW | Empty campaigns page has "Create Campaign" CTA; empty analytics has "Send campaigns" |

**Files Changed:** 15+
**Effort:** 2 hours
**Test:** Load each page; verify skeletons appear; verify retries work
**Commit:** "UX: Add retry UI, slow network detection, empty state CTAs"

---

## SCALE (Performance Optimization) - Future Sprints

### Sprint 4A: Database Optimization

| Item | Files | Risk | Acceptance |
|------|-------|------|-----------|
| **1. Enable connection pooling** | server.js (Pool config) | LOW | min: 2, max: 10; connections reused |
| **2. Add missing indexes** | migrations/new_migration.js | MEDIUM | Index campaigns(user_id, created_at); prospects(campaign_id, status) |
| **3. Add query performance logging** | lib/db-logger.js (new) | LOW | Log slow queries (>100ms) with execution plan |

**Files Changed:** 3
**Effort:** 1.5 hours

---

### Sprint 4B: Caching Layer

| Item | Files | Risk | Acceptance |
|------|-------|------|-----------|
| **1. Add Redis connection** | lib/cache-service.js (new) | MEDIUM | Redis initialized; cache /analytics queries for 5min |
| **2. Cache campaign lists** | server.js (/api/campaigns endpoint) | MEDIUM | Cache per-user campaign list; invalidate on create/delete |
| **3. Cache analytics summaries** | server.js (/api/analytics/summary) | MEDIUM | Cache aggregated metrics; TTL 1 min |

**Files Changed:** 3
**Effort:** 2 hours

---

### Sprint 4C: Frontend Optimization

| Item | Files | Risk | Acceptance |
|------|-------|------|-----------|
| **1. Minify JS/CSS** | public/js/*, public/css/* | LOW | Production build minifies assets |
| **2. Add gzip compression** | server.js (middleware) | LOW | gzip middleware enabled |
| **3. Lazy load non-critical content** | public/index.html | LOW | Above-fold content loads first; lazy-load charts |

**Files Changed:** 2
**Effort:** 1 hour

---

## RELEASE CRITERIA

**Before marking COMPLETE:**

- ✅ All tests pass (unit, integration, E2E)
- ✅ No unhandled exceptions in logs
- ✅ Audit logs show sensitive actions
- ✅ Error reporting sends to Sentry/similar
- ✅ /health endpoint responds with 200
- ✅ /metrics endpoint shows healthy numbers
- ✅ Core user flow works end-to-end (signup→campaign→analytics→billing)
- ✅ No console errors on any page
- ✅ Mobile responsive on 375px viewport
- ✅ All pages have proper loading/empty/error states
- ✅ Retry logic works on transient failures
- ✅ Request timeouts prevent hangs
- ✅ Idempotency prevents duplicate operations
- ✅ CORS blocks requests from unauthorized origins
- ✅ Rate limiting prevents brute force
- ✅ Audit logs contain all sensitive actions

---

## Success Metrics

| Metric | Current | Target | By When |
|--------|---------|--------|---------|
| **Test Coverage** | 0% | >80% on critical paths | Sprint 2C |
| **P99 Response Time** | Unknown | <2s for most endpoints | Sprint 3B |
| **Error Rate (5xx)** | Unknown | <0.1% | Sprint 3A |
| **Audit Log Events** | 0 | 100% of sensitive actions | Sprint 1C |
| **MTTR (time to fix)** | Unknown | <1hr with structured logs | Sprint 3A |
| **Uptime** | >99% (target) | 99.9% | Sprint 2A |

---

## Risk Mitigation

| Risk | Mitigation | Owner |
|------|-----------|-------|
| Tests fail, breaking deploy | Test in staging before merging to main | Engineering |
| DB timeout hangs user | connectionTimeoutMillis set; add timeouts on all endpoints | Engineering |
| Migrations skip on deploy | render.yaml buildCommand fixed; verified in logs | Engineering |
| Unhandled errors crash app | Global error handler + error reporting setup | Engineering |
| Performance degrades | Caching layer + connection pooling added | Engineering |
| Users confused on errors | Retry UI + friendly error messages | Engineering |

---

## Timeline

| Sprint | Start | End | Focus |
|--------|-------|-----|-------|
| 1A | Day 1 | Day 1 | Infra fixes |
| 1B | Day 1 | Day 1 | Resilience |
| 1C | Day 1 | Day 2 | Security logging |
| 2A | Day 2 | Day 2 | Unit tests |
| 2B | Day 2 | Day 3 | Integration tests |
| 2C | Day 3 | Day 3 | E2E + edge cases |
| 3A | Day 3 | Day 4 | Structured logging |
| 3B | Day 4 | Day 4 | Metrics |
| 3C | Day 4 | Day 4 | Polish UX |
| 4+ | Week 2+ | - | Performance, scaling |

**Total Estimated Effort:** 24-30 hours
**Critical Path:** Sprints 1A + 1B + 2A (7 hours) = minimum MVP of hardening

---

## Deploy Strategy

- **Phased deployment:** One sprint per deploy
- **Rollback plan:** If P0 issue found, git revert + redeploy
- **Monitoring:** Check logs for errors immediately post-deploy
- **Validation:** Run E2E test after each deploy

