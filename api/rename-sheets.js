/**
 * Rename existing Google Sheets to match new naming convention
 */

require('dotenv').config({ path: '../.env' });
const { google } = require('googleapis');

async function renameSheets() {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    
    if (!spreadsheetId) {
      console.error('❌ GOOGLE_SHEETS_SPREADSHEET_ID not configured in .env');
      process.exit(1);
    }

    console.log(`Renaming sheets in: ${spreadsheetId}\n`);
    
    // Initialize Google Sheets API
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_SHEETS_CREDENTIALS_PATH,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    
    // Get current sheets
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: spreadsheetId,
    });
    
    console.log('Current sheets:');
    spreadsheet.data.sheets.forEach(sheet => {
      console.log(`  - ${sheet.properties.title} (ID: ${sheet.properties.sheetId})`);
    });
    
    // Map old names to new names
    const renameMap = {
      'Audit Summary': 'Property Summary',
      'Image Results': 'Image Details',
      'Issues': 'Action Items'
    };
    
    // Build rename requests
    const requests = [];
    
    for (const sheet of spreadsheet.data.sheets) {
      const oldName = sheet.properties.title;
      const newName = renameMap[oldName];
      
      if (newName) {
        console.log(`\n📝 Renaming: "${oldName}" → "${newName}"`);
        requests.push({
          updateSheetProperties: {
            properties: {
              sheetId: sheet.properties.sheetId,
              title: newName,
            },
            fields: 'title',
          },
        });
      }
    }
    
    if (requests.length === 0) {
      console.log('\n✅ No sheets need renaming (already using correct names)');
      return;
    }
    
    // Execute rename
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: spreadsheetId,
      requestBody: {
        requests: requests,
      },
    });
    
    console.log('\n✅ Sheets renamed successfully!');
    console.log('\nNew sheet names:');
    console.log('  - Property Summary');
    console.log('  - Image Details');
    console.log('  - Action Items');
    console.log('\nYou can now run audits and data will be written to these sheets.\n');
    
  } catch (error) {
    console.error('❌ Error renaming sheets:', error.message);
    process.exit(1);
  }
}

renameSheets();
