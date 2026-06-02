/**
 * Clear all data from sheets and reinitialize with correct structure
 */

require('dotenv').config({ path: '../.env' });
const { google } = require('googleapis');

async function clearAndReinitSheets() {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    
    if (!spreadsheetId) {
      console.error('❌ GOOGLE_SHEETS_SPREADSHEET_ID not configured in .env');
      process.exit(1);
    }

    console.log(`\n🔄 Clearing and reinitializing Google Sheets: ${spreadsheetId}\n`);
    
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_SHEETS_CREDENTIALS_PATH || '../google-credentials.json',
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    
    // Get current sheets
    const metadata = await sheets.spreadsheets.get({ spreadsheetId });
    console.log('📋 Current sheets:');
    metadata.data.sheets.forEach(sheet => {
      console.log(`   - ${sheet.properties.title}`);
    });
    
    // Delete all sheets except the first one (can't delete all)
    const sheetsToDelete = metadata.data.sheets.slice(1);
    if (sheetsToDelete.length > 0) {
      console.log('\n🗑️  Deleting old sheets...');
      const deleteRequests = sheetsToDelete.map(sheet => ({
        deleteSheet: {
          sheetId: sheet.properties.sheetId
        }
      }));
      
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: deleteRequests }
      });
      console.log('   ✅ Old sheets deleted');
    }
    
    // Clear the first sheet and rename it
    const firstSheet = metadata.data.sheets[0];
    console.log('\n🧹 Clearing first sheet...');
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `${firstSheet.properties.title}!A:Z`
    });
    
    // Rename first sheet to "Property Summary"
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          updateSheetProperties: {
            properties: {
              sheetId: firstSheet.properties.sheetId,
              title: 'Property Summary'
            },
            fields: 'title'
          }
        }]
      }
    });
    console.log('   ✅ First sheet cleared and renamed');
    
    // Now initialize with correct structure
    console.log('\n📝 Initializing sheets with correct structure...');
    const { GoogleSheetsWriter } = require('./dist/api/src/services/GoogleSheetsWriter');
    const writer = new GoogleSheetsWriter(spreadsheetId);
    await writer.initializeSheets();
    
    console.log('\n✅ Google Sheets cleared and reinitialized successfully!\n');
    console.log('📊 New structure:');
    console.log('   1. Property Summary');
    console.log('   2. Property History');
    console.log('   3. Image Details');
    console.log('   4. Action Items');
    console.log('   5. System Rules & Logic');
    console.log('   6. Text Summary');
    console.log('   7. Text Details');
    console.log('   8. Text Action Items');
    console.log('   9. Text Missing Info');
    console.log('\n🧭 Image Details key columns:');
    console.log('   - F = Config Name');
    console.log('   - G = Thumbnail');
    console.log('   - I = Width, J = Height\n');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

clearAndReinitSheets();
