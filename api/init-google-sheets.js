/**
 * Initialize Google Sheets with headers
 * Run this once after setting up Google Sheets
 */

require('dotenv').config({ path: '../.env' });
const { GoogleSheetsWriter } = require('./dist/api/src/services/GoogleSheetsWriter');

async function initializeSheets() {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    
    if (!spreadsheetId) {
      console.error('❌ GOOGLE_SHEETS_SPREADSHEET_ID not configured in .env');
      process.exit(1);
    }

    console.log(`Initializing Google Sheets: ${spreadsheetId}`);
    
    const writer = new GoogleSheetsWriter(spreadsheetId);
    
    // Test connection first
    const connected = await writer.testConnection();
    if (!connected) {
      console.error('❌ Failed to connect to Google Sheets');
      process.exit(1);
    }
    
    // Initialize sheets with headers
    await writer.initializeSheets();
    
    console.log('\n✅ Google Sheets initialized successfully!');
    console.log('\nNext steps:');
    console.log('1. Open your Google Sheet');
    console.log('2. Verify tabs were created/updated:');
    console.log('   - Property Summary');
    console.log('   - Property History');
    console.log('   - Image Details');
    console.log('   - Action Items');
    console.log('   - System Rules & Logic');
    console.log('   - Text Summary');
    console.log('   - Text Details');
    console.log('   - Text Action Items');
    console.log('   - Text Missing Info');
    console.log('3. In Image Details, confirm columns:');
    console.log('   - F = Config Name');
    console.log('   - G = Thumbnail');
    console.log('   - I = Width, J = Height');
    console.log('4. Run an audit to test: npm run dev');
    console.log('5. Check the sheets for results\n');
    
  } catch (error) {
    console.error('❌ Error initializing Google Sheets:', error.message);
    console.error('\nTroubleshooting:');
    console.error('1. Check GOOGLE_SHEETS_SPREADSHEET_ID in .env');
    console.error('2. Check GOOGLE_SHEETS_CREDENTIALS_PATH in .env');
    console.error('3. Make sure google-credentials.json exists');
    console.error('4. Make sure you shared the sheet with the service account email\n');
    process.exit(1);
  }
}

initializeSheets();
