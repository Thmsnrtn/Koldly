/**
 * Verification script for OAuth, email verification, legal pages, and billing features
 * Tests that all endpoints and pages are accessible
 */

const http = require('http');

const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

function makeRequest(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const protocol = url.protocol === 'https:' ? require('https') : http;

    const req = protocol.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, data });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

async function verify() {
  console.log('🔍 Verifying OAuth, Email Verification, Legal Pages, and Billing Features\n');

  const tests = [
    { name: 'Health Check', path: '/health' },
    { name: 'Signup Page (with OAuth button)', path: '/signup', shouldContain: 'Sign Up with Google' },
    { name: 'Login Page (with OAuth button)', path: '/login', shouldContain: 'Sign In with Google' },
    { name: 'Terms of Service Page', path: '/terms', shouldContain: 'Terms of Service' },
    { name: 'Privacy Policy Page', path: '/privacy', shouldContain: 'Privacy Policy' },
    { name: 'Billing Page', path: '/billing', shouldContain: 'Billing & Subscription' },
    { name: 'OAuth Google Start Endpoint', path: '/auth/google', shouldStatus: 301 },
    { name: 'Email Verification Page', path: '/verify-email', shouldContain: 'Verifying Your Email' }
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      const response = await makeRequest(test.path);

      if (test.shouldStatus && response.status !== test.shouldStatus) {
        console.log(`❌ ${test.name}: Expected status ${test.shouldStatus}, got ${response.status}`);
        failed++;
      } else if (test.shouldContain && !response.data.includes(test.shouldContain)) {
        console.log(`❌ ${test.name}: Expected content not found: "${test.shouldContain}"`);
        failed++;
      } else if (!test.shouldStatus && !test.shouldContain && response.status !== 200) {
        console.log(`❌ ${test.name}: Expected 200, got ${response.status}`);
        failed++;
      } else {
        console.log(`✅ ${test.name}`);
        passed++;
      }
    } catch (err) {
      console.log(`❌ ${test.name}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

verify().then(success => {
  process.exit(success ? 0 : 1);
}).catch(err => {
  console.error('Verification failed:', err);
  process.exit(1);
});
