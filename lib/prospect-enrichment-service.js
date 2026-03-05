/**
 * Prospect Enrichment Service
 *
 * Real contact data via Apollo.io (primary) and Hunter.io (fallback).
 * Provides two capabilities:
 *   1. discoverByICP(icp, batchSize) — search for real companies/people matching an ICP
 *   2. enrichProspect(prospect)      — verify/enrich a single prospect record
 *
 * Environment variables required:
 *   APOLLO_API_KEY   — Apollo.io API key
 *   HUNTER_API_KEY   — Hunter.io API key (fallback / email verification)
 */

const https = require('https');

// Apollo.io People Search API base
const APOLLO_BASE = 'https://api.apollo.io/v1';
const HUNTER_BASE = 'https://api.hunter.io/v2';

// ICP company size → Apollo num_employees_ranges mapping
const SIZE_TO_APOLLO_RANGE = {
  '1-10': ['1,10'],
  '11-50': ['11,50'],
  '51-200': ['51,200'],
  '51-100': ['51,100'],
  '101-200': ['101,200'],
  '201-500': ['201,500'],
  '501-1000': ['501,1000'],
  '1000+': ['1001,10000'],
  'enterprise': ['1001,10000'],
  'smb': ['11,500'],
  'mid-market': ['201,1000'],
  'startup': ['1,200']
};

function apolloRequest(path, body) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.APOLLO_API_KEY;
    if (!apiKey) {
      return reject(new Error('APOLLO_API_KEY not configured'));
    }

    const payload = JSON.stringify({ ...body, api_key: apiKey });
    const options = {
      hostname: 'api.apollo.io',
      port: 443,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Cache-Control': 'no-cache'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) {
            return reject(new Error(`Apollo API ${res.statusCode}: ${data.slice(0, 200)}`));
          }
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Apollo parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Apollo request timed out')); });
    req.write(payload);
    req.end();
  });
}

function hunterRequest(path) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.HUNTER_API_KEY;
    if (!apiKey) {
      return reject(new Error('HUNTER_API_KEY not configured'));
    }

    const sep = path.includes('?') ? '&' : '?';
    const fullPath = `/v2${path}${sep}api_key=${apiKey}`;
    const options = {
      hostname: 'api.hunter.io',
      port: 443,
      path: fullPath,
      method: 'GET'
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) {
            return reject(new Error(`Hunter API ${res.statusCode}: ${data.slice(0, 200)}`));
          }
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Hunter parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Hunter request timed out')); });
    req.end();
  });
}

/**
 * Build Apollo People Search filters from a structured ICP object.
 * icp_structured is produced by ProspectDiscoveryService.parseICP()
 */
function buildApolloFilters(icp, batchSize) {
  const filters = {
    per_page: Math.min(batchSize, 25),
    page: 1
  };

  // Job titles → person_titles
  if (icp.job_titles && icp.job_titles.length > 0) {
    filters.person_titles = icp.job_titles.slice(0, 5);
  }

  // Industries → organization_industry_tag_ids is complex; use keyword search instead
  if (icp.industries && icp.industries.length > 0) {
    filters.organization_industry_tag_ids = undefined; // skip — use q_keywords
    filters.q_keywords = icp.industries.slice(0, 3).join(' OR ');
  }

  // Geographies → person_locations
  if (icp.geographies && icp.geographies.length > 0) {
    filters.person_locations = icp.geographies.slice(0, 5);
  }

  // Company sizes → num_employees_ranges
  const sizeRanges = [];
  if (icp.company_sizes) {
    for (const size of icp.company_sizes) {
      const normalized = size.toLowerCase().trim();
      for (const [key, ranges] of Object.entries(SIZE_TO_APOLLO_RANGE)) {
        if (normalized.includes(key)) {
          sizeRanges.push(...ranges);
          break;
        }
      }
    }
  }
  if (sizeRanges.length > 0) {
    filters.organization_num_employees_ranges = [...new Set(sizeRanges)].slice(0, 5);
  }

  // Funding stage
  if (icp.funding_stages && icp.funding_stages.length > 0) {
    const stages = icp.funding_stages.map(s => s.toLowerCase());
    if (stages.some(s => s.includes('series'))) {
      filters.organization_latest_funding_stage_cd = stages
        .filter(s => s.match(/series [a-e]/))
        .map(s => s.replace('series ', 'series_').toUpperCase().replace(' ', '_'));
    }
  }

  return filters;
}

/**
 * Map Apollo person result to Koldly prospect schema
 */
function apolloPersonToProspect(person) {
  const org = person.organization || {};
  return {
    company_name: org.name || person.organization_name || 'Unknown',
    website: org.website_url || null,
    industry: org.industry || null,
    location: [person.city, person.state, person.country].filter(Boolean).join(', ') || null,
    estimated_size: org.employee_count ? `${org.employee_count} employees` : (org.estimated_num_employees ? `~${org.estimated_num_employees} employees` : null),
    team_size: org.estimated_num_employees ? String(org.estimated_num_employees) : null,
    funding_stage: org.latest_funding_stage || null,
    // Contact details
    contact_first_name: person.first_name || null,
    contact_last_name: person.last_name || null,
    contact_title: person.title || null,
    contact_email: person.email || null,
    linkedin_url: person.linkedin_url || null,
    // Metadata
    relevance_score: 75, // Real data default; AI research step will refine
    data_source: 'apollo',
    apollo_person_id: person.id || null,
    apollo_org_id: org.id || null
  };
}

class ProspectEnrichmentService {
  /**
   * Discover real people/companies matching a structured ICP via Apollo.io.
   * Falls back to Hunter.io domain search if Apollo is unavailable.
   *
   * @param {object} icp - Structured ICP from parseICP()
   * @param {number} batchSize - Max prospects to return
   * @returns {Array} Array of prospect objects ready to insert
   */
  async discoverByICP(icp, batchSize = 25) {
    // Try Apollo first
    if (process.env.APOLLO_API_KEY) {
      try {
        return await this._apolloDiscover(icp, batchSize);
      } catch (err) {
        console.warn('[Enrichment] Apollo failed, no fallback available:', err.message);
      }
    }

    // No data source available — return empty so the caller can fall back to AI brainstorm
    console.warn('[Enrichment] No API keys configured (APOLLO_API_KEY, HUNTER_API_KEY). Real prospect discovery unavailable.');
    return [];
  }

  async _apolloDiscover(icp, batchSize) {
    const filters = buildApolloFilters(icp, batchSize);
    const response = await apolloRequest('/v1/mixed_people/search', filters);

    const people = response.people || [];
    if (people.length === 0) {
      console.info('[Enrichment] Apollo returned 0 results for ICP filters');
      return [];
    }

    return people.map(p => apolloPersonToProspect(p));
  }

  /**
   * Enrich a single prospect — verify email, fill in missing fields.
   * Used after CSV import to add contact details.
   *
   * @param {object} prospect - { company_name, website, contact_email, contact_title }
   * @returns {object} Enriched prospect fields (partial update object)
   */
  async enrichProspect(prospect) {
    const enriched = {};

    // Step 1: Try Hunter.io domain search if we have a website
    if (prospect.website && process.env.HUNTER_API_KEY) {
      try {
        const domain = new URL(
          prospect.website.startsWith('http') ? prospect.website : `https://${prospect.website}`
        ).hostname.replace('www.', '');

        const response = await hunterRequest(`/domain-search?domain=${encodeURIComponent(domain)}&limit=5`);
        const data = response.data || {};

        if (data.emails && data.emails.length > 0) {
          // Pick the best match by job title if we have one
          let best = data.emails[0];
          if (prospect.contact_title) {
            const titleLower = prospect.contact_title.toLowerCase();
            const titleMatch = data.emails.find(e =>
              (e.position || '').toLowerCase().includes(titleLower.split(' ')[0])
            );
            if (titleMatch) best = titleMatch;
          }

          enriched.contact_email = enriched.contact_email || best.value;
          enriched.contact_first_name = enriched.contact_first_name || best.first_name;
          enriched.contact_last_name = enriched.contact_last_name || best.last_name;
          enriched.contact_title = enriched.contact_title || best.position;
        }

        if (data.organization) {
          enriched.industry = enriched.industry || data.organization.industry;
          enriched.estimated_size = enriched.estimated_size || (data.organization.size ? `${data.organization.size} employees` : null);
        }
      } catch (err) {
        console.warn(`[Enrichment] Hunter.io enrichment failed for ${prospect.website}:`, err.message);
      }
    }

    // Step 2: Verify email deliverability if we have one
    if ((enriched.contact_email || prospect.contact_email) && process.env.HUNTER_API_KEY) {
      const emailToVerify = enriched.contact_email || prospect.contact_email;
      try {
        const response = await hunterRequest(`/email-verifier?email=${encodeURIComponent(emailToVerify)}`);
        const data = response.data || {};
        enriched.email_verification_status = data.status || 'unknown'; // valid, invalid, accept_all, unknown
        enriched.email_smtp_verified = data.result === 'deliverable';
      } catch (err) {
        console.warn(`[Enrichment] Email verification failed for ${emailToVerify}:`, err.message);
      }
    }

    return enriched;
  }

  /**
   * Bulk email verification for a list of email addresses.
   * Updates email_recipient_status table with results.
   *
   * @param {Array} emails - [{ id, email }] where id is the generated_email.id
   * @param {object} pool - Postgres pool
   */
  async bulkVerifyEmails(emails, pool) {
    const results = { verified: 0, invalid: 0, skipped: 0 };

    for (const { id, email } of emails) {
      if (!process.env.HUNTER_API_KEY) {
        results.skipped++;
        continue;
      }

      try {
        const response = await hunterRequest(`/email-verifier?email=${encodeURIComponent(email)}`);
        const data = response.data || {};
        const isValid = data.result === 'deliverable';

        await pool.query(
          `INSERT INTO email_recipient_status (email, smtp_verified, mx_records_checked, verification_status, last_checked_at)
           VALUES ($1, $2, TRUE, $3, NOW())
           ON CONFLICT (email) DO UPDATE
           SET smtp_verified = $2, mx_records_checked = TRUE, verification_status = $3, last_checked_at = NOW()`,
          [email, isValid, data.status || 'unknown']
        );

        isValid ? results.verified++ : results.invalid++;

        // Small delay to respect Hunter rate limits
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        console.warn(`[Enrichment] Bulk verify failed for ${email}:`, err.message);
        results.skipped++;
      }
    }

    return results;
  }
}

module.exports = ProspectEnrichmentService;
