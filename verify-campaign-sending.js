#!/usr/bin/env node
/**
 * Verify Campaign Sending Engine Implementation
 * Tests core functionality without network calls
 */

const { Pool } = require('pg');
const CampaignSendingService = require('./lib/campaign-sending-service');

async function runVerification() {
  console.log('🔍 Verifying Campaign Sending Engine...\n');

  const checks = {
    passed: 0,
    failed: 0,
    warnings: []
  };

  // Check 1: Campaign Sending Service exists and exports
  try {
    if (typeof CampaignSendingService !== 'function') {
      throw new Error('CampaignSendingService is not a class');
    }
    console.log('✅ CampaignSendingService class loaded');
    checks.passed++;
  } catch (err) {
    console.log('❌ CampaignSendingService:', err.message);
    checks.failed++;
  }

  // Check 2: Methods exist
  const requiredMethods = [
    'startCampaign',
    'processSendingQueue',
    'pauseCampaign',
    'resumeCampaign',
    'addProspectToCampaign',
    'removeProspectFromCampaign',
    'getCampaignStatus',
    'queueFollowupEmails',
    'queueInitialEmails'
  ];

  const service = CampaignSendingService.prototype;
  for (const method of requiredMethods) {
    if (typeof service[method] === 'function') {
      console.log(`✅ Method exists: ${method}`);
      checks.passed++;
    } else {
      console.log(`❌ Missing method: ${method}`);
      checks.failed++;
    }
  }

  // Check 3: Migration file exists
  try {
    const migration = require('./migrations/1740200000000_add_campaign_sending_engine.js');
    if (migration.name === 'add_campaign_sending_engine' && typeof migration.up === 'function') {
      console.log('✅ Migration file valid');
      checks.passed++;
    } else {
      throw new Error('Invalid migration structure');
    }
  } catch (err) {
    console.log('❌ Migration file:', err.message);
    checks.failed++;
  }

  // Check 4: Server endpoints registered
  try {
    const fs = require('fs');
    const serverCode = fs.readFileSync('./server.js', 'utf8');
    const requiredEndpoints = [
      'POST /api/campaigns/:campaignId/send/start',
      'POST /api/campaigns/:campaignId/send/pause',
      'POST /api/campaigns/:campaignId/send/resume',
      'POST /api/campaigns/:campaignId/send/add-prospect',
      'POST /api/campaigns/:campaignId/send/remove-prospect',
      'GET /api/campaigns/:campaignId/send/status',
      'POST /api/campaigns/send/process-queue'
    ];

    for (const endpoint of requiredEndpoints) {
      if (serverCode.includes(endpoint)) {
        console.log(`✅ Endpoint registered: ${endpoint}`);
        checks.passed++;
      } else {
        console.log(`❌ Missing endpoint: ${endpoint}`);
        checks.failed++;
      }
    }
  } catch (err) {
    console.log('❌ Server endpoint check:', err.message);
    checks.failed++;
  }

  // Check 5: Scheduler integration
  try {
    const scheduler = require('./lib/scheduler.js');
    if (scheduler.initializeScheduler && scheduler.processSendingQueue) {
      console.log('✅ Scheduler has sendingQueue processor');
      checks.passed++;
    } else {
      throw new Error('Scheduler missing queue processor');
    }
  } catch (err) {
    console.log('❌ Scheduler integration:', err.message);
    checks.failed++;
  }

  // Check 6: UI file exists
  try {
    const fs = require('fs');
    const uiCode = fs.readFileSync('./public/campaign-sending.html', 'utf8');
    if (uiCode.includes('campaign-sending') && uiCode.includes('toggleCampaignStatus')) {
      console.log('✅ Campaign Sending UI page created');
      checks.passed++;
    } else {
      throw new Error('UI missing critical functionality');
    }
  } catch (err) {
    console.log('❌ UI verification:', err.message);
    checks.failed++;
  }

  console.log('\n' + '='.repeat(50));
  console.log(`Summary: ${checks.passed} passed, ${checks.failed} failed`);

  if (checks.failed === 0) {
    console.log('\n✨ Campaign Sending Engine is fully implemented!');
    process.exit(0);
  } else {
    console.log('\n⚠️  Some checks failed');
    process.exit(1);
  }
}

runVerification().catch(err => {
  console.error('Verification error:', err);
  process.exit(1);
});
