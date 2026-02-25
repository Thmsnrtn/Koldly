const http = require('http');

const baseUrl = 'http://localhost:3000';

const pages = [
  { path: '/', name: 'Landing Page', requiresAuth: false },
  { path: '/login', name: 'Login', requiresAuth: false },
  { path: '/signup', name: 'Signup', requiresAuth: false },
  { path: '/forgot-password', name: 'Forgot Password', requiresAuth: false },
  { path: '/reset-password', name: 'Reset Password', requiresAuth: false },
  { path: '/pricing', name: 'Pricing', requiresAuth: false },
  { path: '/terms', name: 'Terms', requiresAuth: false },
  { path: '/privacy', name: 'Privacy', requiresAuth: false },
  { path: '/demo', name: 'Demo', requiresAuth: false },
  { path: '/proof', name: 'Proof', requiresAuth: false },
  { path: '/dashboard', name: 'Dashboard', requiresAuth: true },
  { path: '/campaigns', name: 'Campaigns', requiresAuth: true },
  { path: '/analytics', name: 'Analytics', requiresAuth: true },
  { path: '/integrations', name: 'Integrations', requiresAuth: true },
  { path: '/settings', name: 'Settings', requiresAuth: true },
  { path: '/campaign-sending', name: 'Campaign Sending', requiresAuth: true },
  { path: '/inbox', name: 'Inbox', requiresAuth: true },
  { path: '/billing', name: 'Billing', requiresAuth: true },
  { path: '/onboarding', name: 'Onboarding', requiresAuth: true },
  { path: '/admin/metrics', name: 'Admin Metrics', requiresAuth: true },
  { path: '/nonexistent', name: 'Nonexistent Page (404)', requiresAuth: false }
];

async function testPage(path) {
  return new Promise((resolve) => {
    const req = http.get(`${baseUrl}${path}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const result = {
          path,
          status: res.statusCode,
          contentLength: data.length,
          hasContent: data.length > 0,
          hasTitle: data.includes('<title'),
          hasHtmlDecl: data.includes('<!DOCTYPE'),
          redirectTo: res.headers['location'] || null
        };
        resolve(result);
      });
    });
    req.on('error', (err) => {
      resolve({ path, error: err.message });
    });
    req.setTimeout(5000, () => {
      req.abort();
      resolve({ path, error: 'Timeout' });
    });
  });
}

async function runAudit() {
  console.log('Starting page audit...\n');
  const results = [];
  
  for (const page of pages) {
    const result = await testPage(page.path);
    results.push({ ...page, ...result });
    console.log(`${page.name.padEnd(30)} ${result.status || 'ERR'} ${result.redirectTo ? '→ ' + result.redirectTo : ''}`);
  }
  
  console.log('\n\n=== AUDIT SUMMARY ===\n');
  const byStatus = {};
  results.forEach(r => {
    const status = r.status || 'ERROR';
    byStatus[status] = (byStatus[status] || 0) + 1;
  });
  
  console.log('Status codes:');
  Object.keys(byStatus).sort().forEach(status => {
    console.log(`  ${status}: ${byStatus[status]}`);
  });
  
  const redirects = results.filter(r => r.redirectTo);
  if (redirects.length > 0) {
    console.log('\nRedirects:');
    redirects.forEach(r => {
      console.log(`  ${r.path} → ${r.redirectTo}`);
    });
  }
  
  const errors = results.filter(r => r.error);
  if (errors.length > 0) {
    console.log('\nErrors:');
    errors.forEach(r => {
      console.log(`  ${r.path}: ${r.error}`);
    });
  }
}

runAudit().catch(console.error);
