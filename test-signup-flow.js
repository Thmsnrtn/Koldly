const BASE_URL = 'https://koldly.polsia.app';

async function testSignupFlow() {
  const email = `test${Date.now()}@example.com`;
  const password = 'TestPassword123';
  
  try {
    // Step 1: Signup
    console.log('Step 1: Testing signup endpoint...');
    let res = await fetch(`${BASE_URL}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test User',
        email,
        password
      })
    });
    
    if (!res.ok) {
      console.error('✗ Signup failed:', res.status, await res.text());
      return;
    }
    
    const signupData = await res.json();
    console.log('✓ Signup successful');
    
    if (!signupData.token) {
      console.error('✗ No token returned from signup');
      return;
    }
    
    const token = signupData.token;
    console.log('✓ Auth token received');
    
    // Step 2: Verify auth
    console.log('\nStep 2: Verifying auth...');
    res = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!res.ok) {
      console.error('✗ Auth verification failed:', res.status);
      return;
    }
    
    const userData = await res.json();
    console.log('✓ Auth verified for:', userData.user?.email);
    
    // Step 3: Create campaign
    console.log('\nStep 3: Testing campaign creation...');
    res = await fetch(`${BASE_URL}/api/campaigns`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        name: 'Test Campaign',
        description: 'Test campaign for flow verification',
        icp_description: 'B2B SaaS founders'
      })
    });
    
    if (!res.ok) {
      console.error('✗ Campaign creation failed:', res.status, await res.text());
      return;
    }
    
    const campaignData = await res.json();
    console.log('✓ Campaign created:', campaignData.campaign?.name);
    
    // Step 4: Get campaigns
    console.log('\nStep 4: Fetching campaigns...');
    res = await fetch(`${BASE_URL}/api/campaigns`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!res.ok) {
      console.error('✗ Fetching campaigns failed:', res.status);
      return;
    }
    
    const campaignsData = await res.json();
    console.log(`✓ Found ${campaignsData.campaigns?.length || 0} campaigns`);
    
    console.log('\n✓ FULL FLOW TEST PASSED');
    
  } catch (err) {
    console.error('✗ Error:', err.message);
  }
}

testSignupFlow();
