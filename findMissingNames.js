require('dotenv').config();
const db = require('./db');
const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');

console.log('🔍 MISSING NAMES FINDER SCRIPT 🔍');
console.log('📋 This script finds names from CSV that don\'t exist in contacts_fresh table\n');

// Function to parse full name in "LAST_NAME, FIRST_NAME [MIDDLE_NAME]" format
const parseFullName = (fullName) => {
  if (!fullName || typeof fullName !== 'string') {
    return { firstName: '', lastName: '', fullLastName: '' };
  }
  
  const trimmed = fullName.trim();
  const parts = trimmed.split(',');
  
  if (parts.length >= 2) {
    const fullLastName = parts[0].trim();
    const firstAndMiddle = parts[1].trim();
    
    // Split the first and middle name part, take only the first name
    const firstNameParts = firstAndMiddle.split(/\s+/);
    const firstName = firstNameParts[0] || '';
    
    // For last name, take only the first word if multiple words exist
    const lastNameParts = fullLastName.split(/\s+/);
    const lastName = lastNameParts[0] || '';
    
    return {
      lastName: lastName,
      firstName: firstName,
      fullLastName: fullLastName
    };
  } else {
    // If no comma, treat whole thing as last name
    const lastNameParts = trimmed.split(/\s+/);
    const lastName = lastNameParts[0] || '';
    
    return {
      lastName: lastName,
      firstName: '',
      fullLastName: trimmed
    };
  }
};

// Function to read and parse CSV file
const readCsvFile = (filePath) => {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      reject(new Error(`CSV file not found: ${filePath}`));
      return;
    }

    const csvContent = fs.readFileSync(filePath, 'utf8');
    
    Papa.parse(csvContent, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header) => header.trim(), // Clean up headers
      complete: (results) => {
        if (results.errors && results.errors.length > 0) {
          console.warn('⚠️ CSV parsing warnings:', results.errors);
        }
        resolve(results.data);
      },
      error: (error) => {
        reject(error);
      }
    });
  });
};

// Function to get all existing contacts from database (case insensitive)
const getExistingContacts = async () => {
  const query = `
    WITH ranked_contacts AS (
      SELECT 
        c.contact_id,
        LOWER(TRIM(c.first_name)) as first_name_lower,
        LOWER(TRIM(c.last_name)) as last_name_lower,
        c.first_name,
        c.last_name,
        s.story_id,
        s.status,
        ROW_NUMBER() OVER (
          PARTITION BY LOWER(TRIM(c.first_name)), LOWER(TRIM(c.last_name))
          ORDER BY 
            CASE WHEN s.story_id IS NOT NULL THEN 0 ELSE 1 END, -- Prefer contacts with insurance stories
            CASE 
              WHEN s.status IN ('EOB', 'submitted', 'readyToBill') THEN 0 
              ELSE 1 
            END,
            c.contact_id -- Tie breaker for consistency
        ) as rn
      FROM contacts_fresh c
      LEFT JOIN story_fresh s ON s.destination = c.contact_id AND s.type = 'insurance' AND s.status != 'duplicate'
      WHERE c.first_name IS NOT NULL 
        AND c.last_name IS NOT NULL
        AND TRIM(c.first_name) != ''
        AND TRIM(c.last_name) != ''
        AND (c.subtype != 'duplicate' OR c.subtype IS NULL) AND (c.type != 'duplicate' OR c.type IS NULL)
    )
    SELECT 
      contact_id,
      first_name_lower,
      last_name_lower,
      first_name,
      last_name
    FROM ranked_contacts
    WHERE rn = 1
  `;
  
  const result = await db.query(query);
  return result.rows;
};

// Main function to find missing names
const findMissingNames = async (csvFilePath) => {
  try {
    console.log(`📖 Reading CSV file: ${csvFilePath}`);
    
    // Read and parse CSV
    const csvData = await readCsvFile(csvFilePath);
    console.log(`✅ CSV parsed successfully. Found ${csvData.length} rows`);
    
    // Check if required columns exist
    if (csvData.length > 0) {
      const firstRow = csvData[0];
      const missingColumns = [];
      
      if (!firstRow.hasOwnProperty('FullName')) {
        missingColumns.push('FullName');
      }
      if (!firstRow.hasOwnProperty('TransType')) {
        missingColumns.push('TransType');
      }
      if (!firstRow.hasOwnProperty('Payment')) {
        missingColumns.push('Payment');
      }
      
      if (missingColumns.length > 0) {
        console.error(`❌ Required columns not found in CSV: ${missingColumns.join(', ')}`);
        console.log('Available columns:', Object.keys(firstRow));
        process.exit(1);
      }
    }
    
    // Filter for payment records only
    const paymentRecords = csvData.filter(row => 
      row.TransType && row.TransType.trim().toLowerCase() === 'payment' && 
      row.Payment && parseFloat(row.Payment) > 0
    );
    
    console.log(`💳 Filtered for payment records: ${paymentRecords.length} out of ${csvData.length} total rows`);
    console.log(`💰 Payment filter criteria: TransType='payment' AND Payment > 0`);
    
    if (paymentRecords.length === 0) {
      console.log('❌ No payment records found matching the criteria. Exiting.');
      return;
    }
    
    // Declare variables that will be used throughout the function
    let csvNamesRaw = [];
    let duplicateCounts = new Map();
    
    // Parse all names from payment records and track duplicates
    console.log('🔍 Parsing names from payment records (ignoring middle names)...');
    csvNamesRaw = [];
    const invalidNames = [];
    const nameOccurrences = new Map(); // Track how many times each name appears
    const middleNameExamples = []; // Track examples of names with middle names
    
    for (let i = 0; i < paymentRecords.length; i++) {
      const row = paymentRecords[i];
      const fullName = row.FullName;
      
      if (!fullName || fullName.trim() === '') {
        continue;
      }
      
      const parsed = parseFullName(fullName);
      
      if (parsed.firstName === '' && parsed.lastName === '') {
        invalidNames.push({ row: i + 1, fullName });
        continue;
      }
      
      // Check if this name has a middle name (for reporting purposes)
      const parts = fullName.split(',');
      if (parts.length >= 2) {
        const firstAndMiddle = parts[1].trim();
        const firstNameParts = firstAndMiddle.split(/\s+/);
        if (firstNameParts.length > 1 && middleNameExamples.length < 10) {
          middleNameExamples.push({
            original: fullName,
            parsed: `${parsed.lastName}, ${parsed.firstName}`,
            middleName: firstNameParts.slice(1).join(' ')
          });
        }
      }
      
      const nameEntry = {
        rowNumber: i + 1,
        originalFullName: fullName,
        firstName: parsed.firstName,
        lastName: parsed.lastName,
        firstNameLower: parsed.firstName.toLowerCase().trim(),
        lastNameLower: parsed.lastName.toLowerCase().trim(),
        // Include other relevant data from the row
        ptKey: row.PtKey,
        acctNbr: row.AcctNbr,
        ptID: row.PtID,
        transType: row.TransType,
        payment: row.Payment
      };
      
      csvNamesRaw.push(nameEntry);
      
      // Track name occurrences for deduplication reporting
      const nameKey = `${nameEntry.firstNameLower}|${nameEntry.lastNameLower}`;
      if (!nameOccurrences.has(nameKey)) {
        nameOccurrences.set(nameKey, []);
      }
      nameOccurrences.get(nameKey).push(nameEntry);
    }
    
    // Show examples of middle name handling
    if (middleNameExamples.length > 0) {
      console.log('\n=== MIDDLE NAME HANDLING EXAMPLES ===');
      console.log('These names contain middle names that will be ignored for comparison:');
      middleNameExamples.forEach(example => {
        console.log(`  Original: ${example.original}`);
        console.log(`  Parsed:   ${example.parsed} (ignored: "${example.middleName}")`);
        console.log('');
      });
    }
    
    // Deduplicate names - keep first occurrence of each unique name
    console.log('🔄 Deduplicating names...');
    const csvNames = [];
    const seenNames = new Set();
    duplicateCounts = new Map();
    
    for (const nameEntry of csvNamesRaw) {
      const nameKey = `${nameEntry.firstNameLower}|${nameEntry.lastNameLower}`;
      
      if (!seenNames.has(nameKey)) {
        csvNames.push(nameEntry);
        seenNames.add(nameKey);
        
        // Track duplicate count for reporting
        const occurrences = nameOccurrences.get(nameKey);
        if (occurrences.length > 1) {
          duplicateCounts.set(nameKey, occurrences.length);
        }
      }
    }
    
    console.log(`✅ Parsed ${csvNamesRaw.length} total name entries from payment records`);
    console.log(`✅ Found ${csvNames.length} unique names after deduplication`);
    console.log(`🔄 Removed ${csvNamesRaw.length - csvNames.length} duplicate entries`);
    if (invalidNames.length > 0) {
      console.log(`⚠️ Found ${invalidNames.length} invalid/empty names`);
    }
    
    // Get existing contacts from database
    console.log('🔍 Fetching existing contacts from database...');
    const existingContacts = await getExistingContacts();
    console.log(`✅ Found ${existingContacts.length} existing contacts in database`);
    
// Create a Set of existing name combinations for fast lookup
const existingNamesSet = new Set();
existingContacts.forEach(contact => {
  // Clean the first name by removing quotes and taking only the first word
  const cleanFirstName = (contact.first_name_lower || '').trim()
    .replace(/["']/g, '') // Remove quotes
    .split(/\s+/)[0]; // Take first word only
  
  const lastNameFirst = (contact.last_name_lower || '').trim().split(/\s+/)[0];
  
  const nameKey = `${cleanFirstName}|${lastNameFirst}`;
  existingNamesSet.add(nameKey);
});
    
    // Find missing names
console.log('🔍 Comparing names to find missing ones...');
const missingNames = [];
const foundNames = [];

csvNames.forEach(csvName => {
  // Match importData.js logic: use only first word of first and last names
  const firstNameFirst = csvName.firstNameLower.split(/\s+/)[0];
  const lastNameFirst = csvName.lastNameLower.split(/\s+/)[0];
  const nameKey = `${firstNameFirst}|${lastNameFirst}`;
  
  if (!existingNamesSet.has(nameKey)) {
    missingNames.push(csvName);
  } else {
    foundNames.push(csvName);
  }
});
    
    // Display results
    console.log('\n=== RESULTS ===');
    console.log(`📊 Total rows in CSV: ${csvData.length}`);
    console.log(`💳 Payment records found: ${paymentRecords.length}`);
    console.log(`📊 Total name entries from payments: ${csvNamesRaw.length}`);
    console.log(`📊 Unique names in payment records: ${csvNames.length}`);
    console.log(`🔄 Duplicate entries removed: ${csvNamesRaw.length - csvNames.length}`);
    console.log(`✅ Names found in database: ${foundNames.length}`);
    console.log(`❌ Names missing from database: ${missingNames.length}`);
    
    if (invalidNames.length > 0) {
      console.log(`⚠️ Invalid names skipped: ${invalidNames.length}`);
    }
    
    // Show duplicate information
    if (duplicateCounts.size > 0) {
      console.log(`\n=== DUPLICATE NAMES INFO ===`);
      console.log(`Found ${duplicateCounts.size} names that appeared multiple times in payment records:`);
      const sortedDuplicates = Array.from(duplicateCounts.entries()).sort((a, b) => b[1] - a[1]);
      sortedDuplicates.slice(0, 10).forEach(([nameKey, count]) => {
        const [firstName, lastName] = nameKey.split('|');
        console.log(`  ${lastName.toUpperCase()}, ${firstName.toUpperCase()}: ${count} occurrences`);
      });
      if (sortedDuplicates.length > 10) {
        console.log(`  ... and ${sortedDuplicates.length - 10} more`);
      }
    }
    
    // Display missing names
    if (missingNames.length > 0) {
      console.log('\n=== MISSING NAMES FROM PAYMENT RECORDS ===');
      console.log('The following names from payment records do not exist in contacts_fresh:');
      console.log('Row# | Full Name (Original) | First Name | Last Name | Payment | PtKey | AcctNbr | PtID');
      console.log('-----|---------------------|------------|-----------|---------|-------|---------|------');
      
      missingNames.forEach(name => {
        console.log(`${String(name.rowNumber).padEnd(4)} | ${String(name.originalFullName).padEnd(19)} | ${String(name.firstName).padEnd(10)} | ${String(name.lastName).padEnd(9)} | ${String(name.payment || '').padEnd(7)} | ${String(name.ptKey || '').padEnd(5)} | ${String(name.acctNbr || '').padEnd(7)} | ${name.ptID || ''}`);
      });
    }
    
    // Display invalid names if any
    if (invalidNames.length > 0) {
      console.log('\n=== INVALID NAMES SKIPPED ===');
      invalidNames.forEach(invalid => {
        console.log(`Row ${invalid.row}: "${invalid.fullName}"`);
      });
    }
    
    // Save results to CSV file
    const outputFile = 'missing_names_report5.csv';
    
    if (missingNames.length > 0) {
      // Prepare CSV data
      const csvHeaders = [
        'Row_Number',
        'Full_Name_Original', 
        'First_Name',
        'Last_Name',
        'Payment_Amount',
        'Trans_Type',
        'PtKey',
        'AcctNbr',
        'PtID'
      ];
      
      const csvRows = missingNames.map(name => [
        name.rowNumber,
        name.originalFullName,
        name.firstName,
        name.lastName,
        name.payment || '',
        name.transType || '',
        name.ptKey || '',
        name.acctNbr || '',
        name.ptID || ''
      ]);
      
      // Use Papa Parse to generate CSV
      const csvContent = Papa.unparse({
        fields: csvHeaders,
        data: csvRows
      });
      
      fs.writeFileSync(outputFile, csvContent);
      console.log(`\n📄 Missing names saved to CSV: ${outputFile}`);
    } else {
      console.log(`\n📄 No missing names found - no CSV file created`);
    }
    
    // Also create a summary file with duplicate information
    const summaryFile = 'missing_names_summary3.txt';
    let summaryContent = `MISSING NAMES ANALYSIS SUMMARY\n`;
    summaryContent += `Generated: ${new Date().toISOString()}\n`;
    summaryContent += `Source CSV: ${csvFilePath}\n\n`;
    summaryContent += `PAYMENT FILTER APPLIED:\n`;
    summaryContent += `- Criteria: TransType='payment' AND Payment > 0\n`;
    summaryContent += `- Total rows in CSV: ${csvData.length}\n`;
    summaryContent += `- Payment records found: ${paymentRecords.length}\n\n`;
    summaryContent += `RESULTS:\n`;
    summaryContent += `- Total CSV entries (payments only): ${csvNamesRaw.length}\n`;
    summaryContent += `- Unique names in payment records: ${csvNames.length}\n`;
    summaryContent += `- Duplicate entries removed: ${csvNamesRaw.length - csvNames.length}\n`;
    summaryContent += `- Names found in database: ${foundNames.length}\n`;
    summaryContent += `- Names missing from database: ${missingNames.length}\n`;
    summaryContent += `- Invalid names skipped: ${invalidNames.length}\n\n`;
    
    if (duplicateCounts.size > 0) {
      summaryContent += `DUPLICATE NAMES (Top 20):\n`;
      const sortedDuplicates = Array.from(duplicateCounts.entries()).sort((a, b) => b[1] - a[1]);
      sortedDuplicates.slice(0, 20).forEach(([nameKey, count]) => {
        const [firstName, lastName] = nameKey.split('|');
        summaryContent += `- ${lastName.toUpperCase()}, ${firstName.toUpperCase()}: ${count} occurrences\n`;
      });
      if (sortedDuplicates.length > 20) {
        summaryContent += `... and ${sortedDuplicates.length - 20} more\n`;
      }
    }
    
    if (invalidNames.length > 0) {
      summaryContent += `\nINVALID NAMES SKIPPED:\n`;
      invalidNames.forEach(invalid => {
        summaryContent += `- Row ${invalid.row}: "${invalid.fullName}"\n`;
      });
    }
    
    fs.writeFileSync(summaryFile, summaryContent);
    console.log(`\n📄 Summary report saved to: ${summaryFile}`);
    
  } catch (error) {
    console.error('❌ Error in findMissingNames:', error.message);
    throw error;
  }
};

// Command line usage
if (require.main === module) {
  // Get CSV file path from command line argument or use default
  const csvFilePath = process.argv[2] || 'patient_data2026_7.csv';
  
  console.log(`Starting missing names analysis for: ${csvFilePath}\n`);
  
  findMissingNames(csvFilePath)
    .then(() => {
      console.log('\n✅ Missing names analysis completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Missing names analysis failed:', error.message);
      process.exit(1);
    });
}

module.exports = {
  findMissingNames,
  parseFullName,
  readCsvFile,
  getExistingContacts
};