# Koldly

AI-powered autonomous SDR that discovers prospects, researches their pain points, writes personalized outreach, and manages multi-step email sequences — all with human-in-the-loop approval.

**Live:** https://koldly.com

## Stack

- **Backend**: Express.js + PostgreSQL (Neon)
- **AI**: Anthropic Claude (Haiku for fast tasks, Sonnet for complex drafting)
- **Email**: Postmark (transactional — see note in `lib/email-service.js` about cold email providers)
- **Billing**: Stripe (subscriptions + checkout)
- **Frontend**: Vanilla JS (no framework)
- **Deployment**: Fly.io (Docker)

## Architecture

1. **Onboarding** → Collects product description + ICP + sender identity
2. **Discovery** → AI finds matching prospects based on ICP
3. **Research** → AI enriches prospects with pain points and fit scoring
4. **Email Generation** → AI writes personalized outreach per prospect
5. **Approval Queue** → Human reviews/edits/approves before sending
6. **Sending** → Approved emails queued and sent via Postmark
7. **Reply Handling** → AI categorizes replies and drafts responses

## Key Features

- Autonomous pipeline (cron-driven: discover → research → generate → queue → send)
- Human-in-the-loop approval queue for all outreach
- AI reply categorization + response drafting
- Multi-step follow-up sequences (Day 3, Day 7)
- CSV prospect import
- Stripe billing with free/starter/growth/scale tiers
- Admin metrics dashboard

## Development

```bash
npm install
npm run migrate
npm run dev
```

## Deployment

Deployed on Fly.io via `fly.toml`. Push to deploy with `fly deploy`.
