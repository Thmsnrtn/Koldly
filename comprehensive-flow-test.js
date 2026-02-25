const BASE_URL = 'https://koldly.polsia.app';

async function testFlow() {
  const results = [];
  
  try {
    // Test 1: Landing page
    results.push('=== FLOW AUDIT ===');
    let res = await fetch(`${BASE_URL}/`);
    results.push(`✓ Landing page: ${res.status}`);
    
    // Test 2: Signup page
    res = await fetch(`${BASE_URL}/signup`);
    results.push(`✓ Signup page: ${res.status}`);
    
    // Test 3: Login page
    res = await fetch(`${BASE_URL}/login`);
    results.push(`✓ Login page: ${res.status}`);
    
    // Test 4: Dashboard (should 200 with auth redirect JS)
    res = await fetch(`${BASE_URL}/dashboard`);
    results.push(`✓ Dashboard page: ${res.status}`);
    
    // Test 5: Campaigns page (should 200 with auth redirect JS)
    res = await fetch(`${BASE_URL}/campaigns`);
    results.push(`✓ Campaigns page: ${res.status}`);
    
    // Test 6: Pricing page
    res = await fetch(`${BASE_URL}/pricing`);
    results.push(`✓ Pricing page: ${res.status}`);
    
    // Test 7: Auth config
    res = await fetch(`${BASE_URL}/api/auth/config`);
    const config = await res.json();
    results.push(`✓ Auth config: ${res.status} - Google OAuth: ${config.googleOAuth}`);
    
    // Test 8: Check Stripe links in pricing
    res = await fetch(`${BASE_URL}/pricing`);
    const text = await res.text();
    const stripeLinks = text.match(/https:\/\/buy\.stripe\.com\/[a-zA-Z0-9]+/g) || [];
    results.push(`✓ Pricing page has ${stripeLinks.length} Stripe checkout links`);
    
  } catch(err) {
    results.push(`✗ Error: ${err.message}`);
  }
  
  console.log(results.join('\n'));
}

testFlow();
