/**
 * Clear old data from Google Sheets and verify structure
 */

require('dotenv').config({ path: '../.env' });
const { google } = require('googleapis');

async function clearAndVerifySheets() {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    
    if (!spreadsheetId) {
      console.error('❌ GOOGLE_SHEETS_SPREADSHEET_ID not configured in .env');
      process.exit(1);
    }

    console.log(`Clearing and verifying Google Sheets: ${spreadsheetId}\n`);
    
    // Initialize Google Sheets API
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_SHEETS_CREDENTIALS_PATH,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    
    // Expected structure
    const expectedSheets = {
      'Property Summary': [
        'Property ID',
        'Property Name',
        'Overall Status',
        'Quality Score',
        'Action Required',
        'Critical Issues',
        'Warnings',
        'Total Images',
        'Failed Images',
        'Watermarks',
        'Low Resolution',
        'Duplicates',
        'Last Audit',
      ],
      'Image Details': [
        'Property ID',
        'Property Name',
        'Image ID',
        'Image URL',
        '✅ Resolution OK',
        '✅ Not Blurry',
        '✅ Sharp Enough',
        '❌ Watermark',
        '✅ Categorized',
        '❌ Duplicate',
        'Overall Status',
        'Action',
        'Category',
      ],
      'Action Items': [
        'Priority',
        'Property ID',
        'Property Name',
        'Image ID',
        'Issue Type',
        'Issue',
        'Action Required',
        'Image URL',
      ],
    };

    // Get current spreadsheet
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: spreadsheetId,
    });

    console.log('📋 Current sheets:');
    spreadsheet.data.sheets.forEach(sheet => {
      console.log(`  - ${sheet.properties.title}`);
    });
    console.log('');

    // Process each expected sheet
    for (const [sheetName, expectedHeaders] of Object.entries(expectedSheets)) {
      console.log(`\n🔍 Processing: ${sheetName}`);
      console.log('─'.repeat(60));

      // Check if sheet exists
      const sheet = spreadsheet.data.sheets.find(
        s => s.properties.title === sheetName
      );

      if (!sheet) {
        console.log(`❌ Sheet "${sheetName}" does not exist!`);
        console.log(`   Creating it now...`);
        
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: spreadsheetId,
          requestBody: {
            requests: [{
              addSheet: {
                properties: { title: sheetName },
              },
            }],
          },
        });
        console.log(`✅ Created sheet: ${sheetName}`);
      }

      // Get current headers
      const headerResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId,
        range: `${sheetName}!A1:Z1`,
      });

      const currentHeaders = headerResponse.data.values ? headerResponse.data.values[0] : [];
      
      console.log(`\n📊 Current headers (${currentHeaders.length}):`);
      console.log(`   ${currentHeaders.join(', ')}`);
      
      console.log(`\n✅ Expected headers (${expectedHeaders.length}):`);
      console.log(`   ${expectedHeaders.join(', ')}`);

      // Compare headers
      const headersMatch = JSON.stringify(currentHeaders) === JSON.stringify(expectedHeaders);
      
      if (!headersMatch) {
        console.log(`\n⚠️  Headers DO NOT match!`);
        console.log(`   Updating headers...`);
        
        // Update headers
        await sheets.spreadsheets.values.update({
          spreadsheetId: spreadsheetId,
          range: `${sheetName}!A1`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [expectedHeaders],
          },
        });

        // Format headers (bold, dark background)
        const sheetId = sheet ? sheet.properties.sheetId : 
          (await sheets.spreadsheets.get({ spreadsheetId }))
            .data.sheets.find(s => s.properties.title === sheetName).properties.sheetId;

        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: spreadsheetId,
          requestBody: {
            requests: [{
              repeatCell: {
                range: {
                  sheetId: sheetId,
                  startRowIndex: 0,
                  endRowIndex: 1,
                },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: { red: 0.2, green: 0.2, blue: 0.2 },
                    textFormat: {
                      foregroundColor: { red: 1, green: 1, blue: 1 },
                      bold: true,
                    },
                  },
                },
                fields: 'userEnteredFormat(backgroundColor,textFormat)',
              },
            }],
          },
        });

        console.log(`✅ Headers updated and formatted`);
      } else {
        console.log(`\n✅ Headers match perfectly!`);
      }

      // Get data rows count
      const dataResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId,
        range: `${sheetName}!A2:Z`,
      });

      const dataRows = dataResponse.data.values ? dataResponse.data.values.length : 0;
      console.log(`\n📈 Current data rows: ${dataRows}`);

      if (dataRows > 0) {
        console.log(`🗑️  Clearing ${dataRows} old data rows...`);
        
        // Clear all data except headers
        await sheets.spreadsheets.values.clear({
          spreadsheetId: spreadsheetId,
          range: `${sheetName}!A2:Z`,
        });

        console.log(`✅ Old data cleared`);
      } else {
        console.log(`✅ No old data to clear`);
      }
    }

    // Check for old sheets that should be deleted
    console.log(`\n\n🔍 Checking for old sheets to delete...`);
    console.log('─'.repeat(60));
    
    const oldSheetNames = ['Audit Summary', 'Image Results', 'Issues', 'Sheet1'];
    const sheetsToDelete = spreadsheet.data.sheets.filter(sheet => 
      oldSheetNames.includes(sheet.properties.title)
    );

    if (sheetsToDelete.length > 0) {
      console.log(`\nFound ${sheetsToDelete.length} old sheet(s):`);
      sheetsToDelete.forEach(sheet => {
        console.log(`  - ${sheet.properties.title}`);
      });

      console.log(`\n🗑️  Deleting old sheets...`);
      
      const deleteRequests = sheetsToDelete.map(sheet => ({
        deleteSheet: {
          sheetId: sheet.properties.sheetId,
        },
      }));

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: spreadsheetId,
        requestBody: {
          requests: deleteRequests,
        },
      });

      console.log(`✅ Old sheets deleted`);
    } else {
      console.log(`✅ No old sheets to delete`);
    }

    console.log(`\n\n${'═'.repeat(60)}`);
    console.log(`✅ GOOGLE SHEETS READY FOR USE`);
    console.log(`${'═'.repeat(60)}`);
    console.log(`\n📋 Final structure:`);
    console.log(`  1. Property Summary (${expectedSheets['Property Summary'].length} columns)`);
    console.log(`  2. Image Details (${expectedSheets['Image Details'].length} columns)`);
    console.log(`  3. Action Items (${expectedSheets['Action Items'].length} columns)`);
    console.log(`\n✅ All sheets have correct headers`);
    console.log(`✅ All old data cleared`);
    console.log(`✅ Ready for new audits`);
    console.log(`\n🚀 Next step: Run an audit through the web UI`);
    console.log(`   URL: http://localhost:3000/\n`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

clearAndVerifySheets();
