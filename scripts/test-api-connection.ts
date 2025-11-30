import axios from 'axios';

async function testConnection() {
  const baseUrls = [
    'https://api.hypereth.io/v1/aster',
    'https://api.asterdex.com',
  ];

  for (const baseUrl of baseUrls) {
    console.log(`\nTesting: ${baseUrl}`);
    
    // Test ping endpoint
    try {
      const pingResponse = await axios.get(`${baseUrl}/fapi/v1/ping`, { timeout: 5000 });
      console.log('✅ Ping successful:', pingResponse.status, pingResponse.data);
    } catch (error: any) {
      console.log('❌ Ping failed:', error.message);
      if (error.response) {
        console.log('   Status:', error.response.status);
        console.log('   Data:', error.response.data);
      }
    }

    // Test time endpoint
    try {
      const timeResponse = await axios.get(`${baseUrl}/fapi/v1/time`, { timeout: 5000 });
      console.log('✅ Time endpoint successful:', timeResponse.status, timeResponse.data);
    } catch (error: any) {
      console.log('❌ Time endpoint failed:', error.message);
    }
  }
}

testConnection().catch(console.error);

