// require('dotenv').config();
// const db = require('./db');
// const ordersDBtools = require('./ordersDBTools');
// const fs = require('fs');
// const Papa = require('papaparse');

// console.log('💰 PAYMENT DATA PROCESSOR SCRIPT 💰');
// console.log('📋 This script processes payment data for existing patients and adds to insurance/interaction tables\n');

// // Function to parse full name in "LAST_NAME, FIRST_NAME [MIDDLE_NAME]" format
// const parseFullName = (fullName) => {
//   if (!fullName || typeof fullName !== 'string') {
//     return { firstName: '', lastName: '', fullLastName: '' };
//   }
  
//   const trimmed = fullName.trim();
//   const parts = trimmed.split(',');
  
//   if (parts.length >= 2) {
//     const fullLastName = parts[0].trim();
//     const firstAndMiddle = parts[1].trim();
    
//     // Split the first and middle name part, take only the first name
//     const firstNameParts = firstAndMiddle.split(/\s+/);
//     const firstName = firstNameParts[0] || '';
    
//     // For last name, take only the first word if multiple words exist
//     const lastNameParts = fullLastName.split(/\s+/);
//     const lastName = lastNameParts[0] || '';
    
//     return {
//       lastName: lastName,
//       firstName: firstName,
//       fullLastName: fullLastName
//     };
//   } else {
//     // If no comma, treat whole thing as last name
//     const lastNameParts = trimmed.split(/\s+/);
//     const lastName = lastNameParts[0] || '';
    
//     return {
//       lastName: lastName,
//       firstName: '',
//       fullLastName: trimmed
//     };
//   }
// };

// // Function to normalize product string (extract 'hand' or 'foot')
// const normalizeProduct = (product) => {
//   if (!product) return null;
  
//   const productLower = product.toString().toLowerCase().trim();
  
//   if (productLower.includes('hand')) {
//     return 'hand';
//   } else if (productLower.includes('foot')) {
//     return 'foot';
//   }
  
//   return null;
// };

// // Function to check if two products match
// const productsMatch = (csvItemID, dbProduct) => {
//   const csvProductNormalized = normalizeProduct(csvItemID);
//   const dbProductNormalized = normalizeProduct(dbProduct);
  
//   if (!csvProductNormalized || !dbProductNormalized) {
//     return false;
//   }
  
//   return csvProductNormalized === dbProductNormalized;
// };

// // Function to read and parse CSV file
// const readCsvFile = (filePath) => {
//   return new Promise((resolve, reject) => {
//     if (!fs.existsSync(filePath)) {
//       reject(new Error(`CSV file not found: ${filePath}`));
//       return;
//     }

//     const csvContent = fs.readFileSync(filePath, 'utf8');
    
//     Papa.parse(csvContent, {
//       header: true,
//       skipEmptyLines: true,
//       transformHeader: (header) => header.trim(),
//       complete: (results) => {
//         if (results.errors && results.errors.length > 0) {
//           console.warn('⚠️ CSV parsing warnings:', results.errors);
//         }
//         resolve(results.data);
//       },
//       error: (error) => {
//         reject(error);
//       }
//     });
//   });
// };

// // Function to get existing contacts from database with duplicate detection
// const getExistingContacts = async () => {
//   const query = `
//     WITH ranked_contacts AS (
//       SELECT 
//         c.contact_id,
//         LOWER(TRIM(c.first_name)) as first_name_lower,
//         LOWER(TRIM(c.last_name)) as last_name_lower,
//         c.first_name,
//         c.last_name,
//         s.story_id,
//         s.status,
//         ROW_NUMBER() OVER (
//           PARTITION BY LOWER(TRIM(c.first_name)), LOWER(TRIM(c.last_name))
//           ORDER BY 
//             CASE WHEN s.story_id IS NOT NULL THEN 0 ELSE 1 END,
//             CASE 
//               WHEN s.status IN ('EOB', 'submitted', 'readyToBill') THEN 0 
//               ELSE 1 
//             END,
//             c.contact_id
//         ) as rn,
//         COUNT(*) OVER (
//           PARTITION BY LOWER(TRIM(c.first_name)), LOWER(TRIM(c.last_name))
//         ) as duplicate_count
//       FROM contacts_fresh c
//       LEFT JOIN story_fresh s ON s.destination = c.contact_id AND s.type = 'insurance' AND s.status != 'duplicate' AND s.status != 'cash' AND s.status != 'optout'
//       WHERE c.first_name IS NOT NULL 
//         AND c.last_name IS NOT NULL
//         AND TRIM(c.first_name) != ''
//         AND TRIM(c.last_name) != ''
//         AND (c.subtype != 'duplicate' OR c.subtype IS NULL) AND (c.type != 'duplicate' OR c.type IS NULL)
//     )
//     SELECT 
//       contact_id,
//       first_name_lower,
//       last_name_lower,
//       first_name,
//       last_name,
//       duplicate_count
//     FROM ranked_contacts
//     WHERE rn = 1
//   `;
  
//   const result = await db.query(query);
//   return result.rows;
// };

// // Function to get insurance_id and story details for a contact (NOW INCLUDES PRODUCT)
// // Function to get insurance_id and story details for a contact (NOW INCLUDES PRODUCT)
// const getInsuranceDataForContact = async (contactId) => {
//   const query = `
//     SELECT 
//       sf_insurance.story_id as insurance_id,
//       sf_insurance.origin as dme_contact_id,
//       sf_insurance.destination as patient_contact_id,
//       if_insurance.product as product
//     FROM story_fresh sf_insurance
//     LEFT JOIN insurance_fresh if_insurance ON if_insurance.insurance_id = sf_insurance.story_id
//     WHERE sf_insurance.destination = $1
//     AND sf_insurance.type = 'insurance' AND sf_insurance.status != 'duplicate'
//     LIMIT 1
//   `;
  
//   const result = await db.query(query, [contactId]);
//   return result.rows[0] || null;
// };

// // Function to parse PaymentDOS date and create timestamp
// const parsePaymentDate = (paymentDOS) => {
//   if (!paymentDOS) return null;
  
//   try {
//     const date = new Date(paymentDOS);
//     if (isNaN(date.getTime())) {
//       console.warn(`Invalid PaymentDOS date: ${paymentDOS}`);
//       return null;
//     }
//     return date;
//   } catch (error) {
//     console.warn(`Error parsing PaymentDOS: ${paymentDOS}`, error);
//     return null;
//   }
// };

// // Function to determine payment level (primary/secondary)
// const getPaymentLevel = (payorLevel) => {
//   if (!payorLevel) return 'primary';
  
//   const level = payorLevel.toString().toLowerCase().trim();
  
//   if (level.includes('secondary') || level.includes('second') || level === '2' || level === 'sec') {
//     return 'secondary';
//   }
  
//   return 'primary';
// };

// // Function to parse SaleType and normalize it
// const getSaleType = (saleType) => {
//   if (!saleType) return 'Rental';
  
//   const type = saleType.toString().toLowerCase().trim();
  
//   if (type.includes('rental') || type === 'rent') {
//     return 'Rental';
//   } else if (type.includes('purchase') || type === 'buy') {
//     return 'Purchase';
//   }
  
//   if (type === 'rental') return 'Rental';
//   if (type === 'purchase') return 'Purchase';
  
//   return 'Rental';
// };

// // Function to check if payment entry already exists for a specific month/year
// const checkExistingPaymentEntry = async (insuranceId, paymentDate) => {
//   const query = `
//     SELECT COUNT(*) as count
//     FROM interaction
//     WHERE to_id = $1
//     AND channel = 'fileUpload'
//     AND EXTRACT(YEAR FROM timestamp) = $2
//     AND EXTRACT(MONTH FROM timestamp) = $3
//   `;
  
//   const year = paymentDate.getFullYear();
//   const month = paymentDate.getMonth() + 1;
  
//   const result = await db.query(query, [insuranceId, year, month]);
//   return parseInt(result.rows[0].count) > 0;
// };

// // Main function to process payment data
// const processPaymentData = async (csvFilePath) => {
//   try {
//     console.log(`📖 Reading CSV file: ${csvFilePath}`);
    
//     // Read and parse CSV
//     const csvData = await readCsvFile(csvFilePath);
//     console.log(`✅ CSV parsed successfully. Found ${csvData.length} rows`);
    
//     // Validate required columns exist (now including ItemID)
//     const requiredColumns = ['FullName', 'TransType', 'Payment', 'PaymentDOS', 'PayorLevel', 'SaleType', 'ItemID'];
//     const availableColumns = Object.keys(csvData[0] || {});
//     const missingColumns = requiredColumns.filter(col => !availableColumns.includes(col));
    
//     if (missingColumns.length > 0) {
//       console.error('❌ Missing required columns:', missingColumns);
//       console.log('Available columns:', availableColumns);
//       process.exit(1);
//     }

//     const targetPatients = [
//       'MITCHUSSON PATSY'
//     ];

//     // Filter for payment records only
//     const paymentRecords = csvData.filter(row => 
//       row.TransType && row.TransType.trim().toLowerCase() === 'payment' && 
//       row.Payment && parseFloat(row.Payment) > 0
//     );
    
//     // Filter for payment records AND specific target patients
//     // const paymentRecords = csvData.filter(row => 
//     //   row.TransType && row.TransType.trim().toLowerCase() === 'payment' && 
//     //   row.Payment && parseFloat(row.Payment) > 0 &&
//     //   targetPatients.includes(row.FullName?.trim())
//     // );
    
//     console.log(`🔍 Found ${paymentRecords.length} payment records in CSV`);
    
//     // Get existing contacts from database
//     console.log('🔍 Fetching existing contacts from database...');
//     const existingContacts = await getExistingContacts();
//     console.log(`✅ Found ${existingContacts.length} existing contacts in database`);
    
//     // Create lookup map for existing contacts
//     const contactsMap = new Map();
//     const duplicateNamesList = []; // Track patients with duplicate names

//     existingContacts.forEach(contact => {
//       const cleanFirstName = (contact.first_name_lower || '').trim()
//         .replace(/["']/g, '')
//         .split(/\s+/)[0];
      
//       const lastNameFirst = (contact.last_name_lower || '').trim().split(/\s+/)[0];
      
//       const nameKey = `${cleanFirstName}|${lastNameFirst}`;
      
//       // Check if this person has duplicates in the database
//       if (contact.duplicate_count > 1) {
//         contactsMap.set(nameKey, { isDuplicate: true, contact });
//       } else {
//         contactsMap.set(nameKey, { isDuplicate: false, contact });
//       }
//     });
    
//     // Process payment records for existing patients
//     console.log('🔍 Processing payment records for existing patients...');
    
//     let processedCount = 0;
//     let errorCount = 0;
//     let skippedCount = 0;
//     let alreadyExistsCount = 0;
//     let productMismatchCount = 0;
    
//     const awsImageUrl = 'https://docs.google.com/spreadsheets/d/1Lw_KHNPn418DuBPeSNR-NpBu4ZO-aQmN2vBLwO9N4xw/edit?usp=sharing';
    
//     for (const row of paymentRecords) {
//       try {
//         // Parse patient name
//         const parsedName = parseFullName(row.FullName);
//         if (!parsedName.firstName || !parsedName.lastName) {
//           skippedCount++;
//           continue;
//         }
        
//         const nameKey = `${parsedName.firstName.toLowerCase().split(/\s+/)[0]}|${parsedName.lastName.toLowerCase().split(/\s+/)[0]}`;

//         const contactEntry = contactsMap.get(nameKey);

//         if (!contactEntry) {
//           console.log(`❌ SKIPPED: Patient not found in database`);
//           skippedCount++;
//           continue;
//         }

//         // Check if this patient has duplicate names in database
//         if (contactEntry.isDuplicate) {
//           console.log(`⚠️ DUPLICATE NAME DETECTED: ${row.FullName} has multiple entries in database`);
//           duplicateNamesList.push({
//             fullName: row.FullName,
//             firstName: parsedName.firstName,
//             lastName: parsedName.lastName,
//             itemID: row.ItemID,
//             payment: row.Payment,
//             paymentDOS: row.PaymentDOS
//           });
//           skippedCount++;
//           continue;
//         }

//         const existingContact = contactEntry.contact;
        
//         console.log(`Processing payment for ${row.FullName} (Contact ID: ${existingContact.contact_id})...`);
        
//         // Get insurance data for this contact (now includes product)
//         const insuranceData = await getInsuranceDataForContact(existingContact.contact_id);
//         if (!insuranceData) {
//           console.log(`  ❌ No insurance data found for contact ${existingContact.contact_id}`);
//           skippedCount++;
//           continue;
//         }

//         // Check if products match
//         const csvItemID = row.ItemID;
//         const dbProduct = insuranceData.product;
        
//         console.log(`  🔍 Product Check - CSV: "${csvItemID}" | DB: "${dbProduct}"`);
        
//         if (!productsMatch(csvItemID, dbProduct)) {
//           console.log(`  ❌ PRODUCT MISMATCH: CSV ItemID (${csvItemID}) does not match DB product (${dbProduct})`);
//           productMismatchCount++;
//           skippedCount++;
//           continue;
//         }
        
//         console.log(`  ✅ Product match confirmed`);
        
//         // Parse payment amount
//         const paymentAmount = parseFloat(row.Payment.toString().replace(/[$,]/g, ''));
//         if (isNaN(paymentAmount) || paymentAmount <= 0) {
//           console.log(`  ❌ Invalid payment amount: ${row.Payment}`);
//           skippedCount++;
//           continue;
//         }
        
//         // Parse payment date
//         const paymentDate = parsePaymentDate(row.PaymentDOS);
//         if (!paymentDate) {
//           console.log(`  ❌ Invalid payment date: ${row.PaymentDOS}`);
//           skippedCount++;
//           continue;
//         }
        
//         // Check if payment entry already exists for this month/year
//         const existingEntry = await checkExistingPaymentEntry(insuranceData.insurance_id, paymentDate);
//         if (existingEntry) {
//           const monthYear = `${paymentDate.getMonth() + 1}/${paymentDate.getFullYear()}`;
//           console.log(`  ⏭️ Payment entry already exists for ${row.FullName} in ${monthYear} - skipping`);
//           alreadyExistsCount++;
//           continue;
//         }
        
//         // Determine if primary or secondary
//         const paymentLevel = getPaymentLevel(row.PayorLevel);

//         // Rental vs purchase
//         const saleType = getSaleType(row.SaleType);
        
//         console.log(`  💰 Payment: $${paymentAmount} | Level: ${paymentLevel} | Sale Type: ${saleType} | Date: ${paymentDate.toISOString()}`);
        
//         // Use DME contact ID from insurance data
//         const dmeContactId = insuranceData.dme_contact_id;
        
//         // Update insurance_fresh table and insert into insurance log table
//         if (paymentLevel === 'primary') {
//           await ordersDBtools.updateInsuranceFreshWithEOBData(
//             insuranceData.insurance_id,
//             null,
//             null,
//             saleType,
//             paymentAmount
//           );
          
//           await ordersDBtools.insertInsuranceEOBLog(
//             insuranceData.insurance_id,
//             null,
//             null,
//             saleType,
//             paymentAmount,
//             awsImageUrl
//           );
          
//           console.log(`  ✅ Primary payment logged to insurance_fresh and insurance tables`);
//         } else {
//           await ordersDBtools.updateInsuranceFreshWithSecondaryEOBData(
//             insuranceData.insurance_id,
//             null,
//             null,
//             saleType,
//             paymentAmount,
//             awsImageUrl
//           );
          
//           await ordersDBtools.insertSecondaryInsuranceEOBLog(
//             insuranceData.insurance_id,
//             null,
//             null,
//             saleType,
//             paymentAmount,
//             awsImageUrl
//           );
          
//           console.log(`  ✅ Secondary payment logged to insurance_fresh and insurance tables`);
//         }
        
//         // Insert interaction record
//         const rawContent = paymentLevel === 'primary' ? null : 'secondary';
//         await ordersDBtools.insertEOBInteraction(
//           'fileUpload',
//           paymentDate,
//           paymentAmount,
//           dmeContactId,
//           insuranceData.insurance_id,
//           awsImageUrl,
//           rawContent
//         );
        
//         console.log(`  ✅ Interaction logged`);
        
//         processedCount++;
        
//         // Add small delay to avoid overwhelming the database
//         await new Promise(resolve => setTimeout(resolve, 100));
        
//       } catch (error) {
//         console.error(`❌ Error processing payment record for ${row.FullName}:`, error.message);
//         errorCount++;
//       }
//     }
    
//     // Final summary
//     console.log('\n=== PAYMENT PROCESSING COMPLETE ===');
//     console.log(`✅ Successfully processed: ${processedCount} payments`);
//     console.log(`📅 Already exists (skipped): ${alreadyExistsCount} payments`);
//     console.log(`🔄 Product mismatches (skipped): ${productMismatchCount} payments`);
//     console.log(`❌ Errors: ${errorCount}`);
//     console.log(`⏭️ Other skipped: ${skippedCount}`);
//     console.log(`📊 Total payment records in CSV: ${paymentRecords.length}`);
    
//     // Display patients with duplicate names that need manual handling
//     if (duplicateNamesList.length > 0) {
//       console.log('\n⚠️ === PATIENTS WITH DUPLICATE NAMES (MANUAL HANDLING REQUIRED) ===');
//       duplicateNamesList.forEach((patient, index) => {
//         console.log(`${index + 1}. ${patient.fullName} (${patient.firstName} ${patient.lastName})`);
//         console.log(`   ItemID: ${patient.itemID} | Payment: $${patient.payment} | Date: ${patient.paymentDOS}`);
//       });
//       console.log(`\nTotal patients with duplicate names: ${duplicateNamesList.length}`);
//     }
    
//   } catch (error) {
//     console.error('❌ Error in processPaymentData:', error.message);
//     throw error;
//   }
// };

// // Command line usage
// if (require.main === module) {
//   const csvFilePath = process.argv[2] || 'patient_data2025_4.csv';
  
//   console.log(`Starting payment data processing for: ${csvFilePath}\n`);
  
//   processPaymentData(csvFilePath)
//     .then(() => {
//       console.log('\n✅ Payment data processing completed successfully');
//       process.exit(0);
//     })
//     .catch((error) => {
//       console.error('\n❌ Payment data processing failed:', error.message);
//       process.exit(1);
//     });
// }

// module.exports = {
//   processPaymentData,
//   parseFullName,
//   normalizeProduct,
//   productsMatch,
//   getExistingContacts,
//   getInsuranceDataForContact,
//   parsePaymentDate,
//   getPaymentLevel,
//   getSaleType,
//   checkExistingPaymentEntry
// };

require('dotenv').config();
const db = require('./db');
const ordersDBtools = require('./ordersDBTools');
const fs = require('fs');
const Papa = require('papaparse');

console.log('💰 PAYMENT DATA PROCESSOR SCRIPT 💰');
console.log('📋 This script processes payment data for existing patients and adds to insurance/interaction tables\n');

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
      transformHeader: (header) => header.trim(),
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

// Function to get existing contacts from database
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
      LEFT JOIN story_fresh s ON s.destination = c.contact_id AND s.type = 'insurance' AND s.status != 'duplicate' AND s.status != 'cash' AND s.status != 'optout'
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

// Function to get insurance_id and story details for a contact
const getInsuranceDataForContact = async (contactId) => {
  const query = `
    SELECT 
      sf_insurance.story_id as insurance_id,
      sf_insurance.origin as dme_contact_id,
      sf_insurance.destination as patient_contact_id
    FROM story_fresh sf_insurance
    WHERE sf_insurance.destination = $1
    AND sf_insurance.type = 'insurance'
    LIMIT 1
  `;
  
  const result = await db.query(query, [contactId]);
  return result.rows[0] || null;
};

// Function to parse PaymentDOS date and create timestamp
const parsePaymentDate = (paymentDOS) => {
  if (!paymentDOS) return null;
  
  try {
    // PaymentDOS might be in various formats, try to parse it
    const date = new Date(paymentDOS);
    if (isNaN(date.getTime())) {
      console.warn(`Invalid PaymentDOS date: ${paymentDOS}`);
      return null;
    }
    return date;
  } catch (error) {
    console.warn(`Error parsing PaymentDOS: ${paymentDOS}`, error);
    return null;
  }
};

// Function to determine payment level (primary/secondary)
const getPaymentLevel = (payorLevel) => {
  if (!payorLevel) return 'primary';
  
  const level = payorLevel.toString().toLowerCase().trim();
  
  // Common patterns for secondary insurance
  if (level.includes('secondary') || level.includes('second') || level === '2' || level === 'sec') {
    return 'secondary';
  }
  
  return 'primary';
};

// Function to parse SaleType and normalize it
const getSaleType = (saleType) => {
  if (!saleType) return 'Rental';
  
  const type = saleType.toString().toLowerCase().trim();
  
  if (type.includes('rental') || type === 'rent') {
    return 'Rental';
  } else if (type.includes('purchase') || type === 'buy') {
    return 'Purchase';
  }
  
  // If it's already properly formatted, return as-is with proper case
  if (type === 'rental') return 'Rental';
  if (type === 'purchase') return 'Purchase';
  
  return 'Rental';
};

// Function to check if payment entry already exists for a specific month/year
const checkExistingPaymentEntry = async (insuranceId, paymentDate) => {
  const query = `
    SELECT COUNT(*) as count
    FROM interaction
    WHERE to_id = $1
    AND channel = 'fileUpload'
    AND EXTRACT(YEAR FROM timestamp) = $2
    AND EXTRACT(MONTH FROM timestamp) = $3
  `;
  
  const year = paymentDate.getFullYear();
  const month = paymentDate.getMonth() + 1; // JavaScript months are 0-based
  
  const result = await db.query(query, [insuranceId, year, month]);
  return parseInt(result.rows[0].count) > 0;
};

// Main function to process payment data
const processPaymentData = async (csvFilePath) => {
  try {
    console.log(`📖 Reading CSV file: ${csvFilePath}`);
    
    // Read and parse CSV
    const csvData = await readCsvFile(csvFilePath);
    console.log(`✅ CSV parsed successfully. Found ${csvData.length} rows`);
    
    // Validate required columns exist
    const requiredColumns = ['FullName', 'TransType', 'Payment', 'PaymentDOS', 'PayorLevel', 'SaleType'];
    const availableColumns = Object.keys(csvData[0] || {});
    const missingColumns = requiredColumns.filter(col => !availableColumns.includes(col));
    
    if (missingColumns.length > 0) {
      console.error('❌ Missing required columns:', missingColumns);
      console.log('Available columns:', availableColumns);
      process.exit(1);
    }

    // const targetPatients = [
    //   'MITCHUSSON PATSY'
    // ];
    
    // Filter for payment records only
    const paymentRecords = csvData.filter(row => 
      row.TransType && row.TransType.trim().toLowerCase() === 'payment' && 
      row.Payment && parseFloat(row.Payment) > 0
    );

    // Filter for payment records AND specific target patients
    // const paymentRecords = csvData.filter(row => 
    //   row.TransType && row.TransType.trim().toLowerCase() === 'payment' && 
    //   row.Payment && parseFloat(row.Payment) > 0 &&
    //   targetPatients.includes(row.FullName?.trim())
    // );
    
    console.log(`🔍 Found ${paymentRecords.length} payment records in CSV`);
    
    // Get existing contacts from database
    console.log('🔍 Fetching existing contacts from database...');
    const existingContacts = await getExistingContacts();
    console.log(`✅ Found ${existingContacts.length} existing contacts in database`);
    
    // Create lookup map for existing contacts - UPDATED VERSION
    const contactsMap = new Map();
    const contactsMapFlexible = new Map(); // New flexible map

    // existingContacts.forEach(contact => {
    //   const nameKey = `${contact.first_name_lower}|${contact.last_name_lower}`;
    //   contactsMap.set(nameKey, contact);
      
    //   // Also create a flexible version that strips common suffixes
    //   const flexibleLastName = contact.last_name_lower
    //     .replace(/\s+(jr|sr|iii|iv|ii)$/i, '') // Strip common suffixes
    //     .trim();
      
    //   const flexibleNameKey = `${contact.first_name_lower}|${flexibleLastName}`;
      
    //   // Only add to flexible map if it's different from the original
    //   if (flexibleNameKey !== nameKey) {
    //     contactsMapFlexible.set(flexibleNameKey, contact);
    //   }
    // });

    // existingContacts.forEach(contact => {
    //   const firstNameFirst = (contact.first_name_lower || '').trim().split(/\s+/)[0];
    //   const lastNameFirst  = (contact.last_name_lower || '').trim().split(/\s+/)[0];
    //   contactsMap.set(`${firstNameFirst}|${lastNameFirst}`, contact);
    // });

    existingContacts.forEach(contact => {
    // Clean the first name by removing quotes and taking only the first word
    const cleanFirstName = (contact.first_name_lower || '').trim()
      .replace(/["']/g, '') // Remove quotes
      .split(/\s+/)[0]; // Take first word only
    
    const lastNameFirst = (contact.last_name_lower || '').trim().split(/\s+/)[0];
    
    const nameKey = `${cleanFirstName}|${lastNameFirst}`;
    contactsMap.set(nameKey, contact);
    
    // Add debug logging to see what's being stored
    if (contact.first_name_lower.includes('john') && contact.last_name_lower.includes('jacobs')) {
      console.log(`DEBUG - Database contact: "${contact.first_name}" -> cleaned: "${cleanFirstName}"`);
      console.log(`DEBUG - Key created: "${nameKey}"`);
    }
  });
    
    // Process payment records for existing patients
    console.log('🔍 Processing payment records for existing patients...');
    
    let processedCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    let alreadyExistsCount = 0;
    
    const awsImageUrl = 'https://docs.google.com/spreadsheets/d/1I45HoFsT7dyO9MlvjtLyqxTwGDU7ff6-CEicchR0alQ/edit?usp=sharing';
    
    for (const row of paymentRecords) {
      try {
        // Parse patient name
        const parsedName = parseFullName(row.FullName);
        if (!parsedName.firstName || !parsedName.lastName) {
          skippedCount++;
          continue;
        }
        
        // const nameKey = `${parsedName.firstName.toLowerCase().trim()}|${parsedName.lastName.toLowerCase().trim()}`;
        const nameKey = `${parsedName.firstName.toLowerCase().split(/\s+/)[0]}|${parsedName.lastName.toLowerCase().split(/\s+/)[0]}`;

        // First try exact match
        let existingContact = contactsMap.get(nameKey);

        // If no exact match, try flexible match (strips suffixes from database names)
        if (!existingContact) {
          existingContact = contactsMapFlexible.get(nameKey);
        }

        console.log(`Contact found in database: ${existingContact ? `YES (ID: ${existingContact.contact_id})` : 'NO'}`);

        if (!existingContact) {
          console.log(`❌ SKIPPED: Patient not found in database`);
          continue;
        }
        
        console.log(`Processing payment for ${row.FullName} (Contact ID: ${existingContact.contact_id})...`);
        
        // Get insurance data for this contact
        const insuranceData = await getInsuranceDataForContact(existingContact.contact_id);
        if (!insuranceData) {
          console.log(`  ❌ No insurance data found for contact ${existingContact.contact_id}`);
          skippedCount++;
          continue;
        }
        
        // Parse payment amount
        const paymentAmount = parseFloat(row.Payment.toString().replace(/[$,]/g, ''));
        if (isNaN(paymentAmount) || paymentAmount <= 0) {
          console.log(`  ❌ Invalid payment amount: ${row.Payment}`);
          skippedCount++;
          continue;
        }
        
        // Parse payment date
        const paymentDate = parsePaymentDate(row.PaymentDOS);
        if (!paymentDate) {
          console.log(`  ❌ Invalid payment date: ${row.PaymentDOS}`);
          skippedCount++;
          continue;
        }
        
        // Check if payment entry already exists for this month/year
        const existingEntry = await checkExistingPaymentEntry(insuranceData.insurance_id, paymentDate);
        if (existingEntry) {
          const monthYear = `${paymentDate.getMonth() + 1}/${paymentDate.getFullYear()}`;
          console.log(`  ⏭️ Payment entry already exists for ${row.FullName} in ${monthYear} - skipping`);
          alreadyExistsCount++;
          continue;
        }
        
        // Determine if primary or secondary
        const paymentLevel = getPaymentLevel(row.PayorLevel);

        //rental vs purchase
        const saleType = getSaleType(row.SaleType);
        
        console.log(`  💰 Payment: $${paymentAmount} | Level: ${paymentLevel} | Sale Type: ${saleType} | Date: ${paymentDate.toISOString()}`);
        
        // Use DME contact ID from insurance data
        const dmeContactId = insuranceData.dme_contact_id;
        
        // Update insurance_fresh table and insert into insurance log table
        if (paymentLevel === 'primary') {
          // Update insurance_fresh table for primary payment
          await ordersDBtools.updateInsuranceFreshWithEOBData(
            insuranceData.insurance_id,    // insurance_id
            null,                         // copay_amount (NULL)
            null,                         // allowed_amount (NULL)
            saleType,                     // rental (from SaleType column)
            paymentAmount                 // amount_of_eob (the payment amount)
          );
          
          // Insert primary payment data into insurance log table
          await ordersDBtools.insertInsuranceEOBLog(
            insuranceData.insurance_id,    // insurance_id
            null,                         // copay_amount (NULL)
            null,                         // allowed_amount (NULL)
            saleType,                     // rental (from SaleType column)
            paymentAmount,                // amount_of_eob (the payment amount)
            awsImageUrl                   // eob_url
          );
          
          console.log(`  ✅ Primary payment logged to insurance_fresh and insurance tables`);
        } else {
          // Update insurance_fresh table for secondary payment
          await ordersDBtools.updateInsuranceFreshWithSecondaryEOBData(
            insuranceData.insurance_id,    // insurance_id
            null,                         // secondary_copay_amount (NULL)
            null,                         // secondary_allowed_amount (NULL)
            saleType,                     // secondary_rental (from SaleType column)
            paymentAmount,                // secondary_amount_of_eob
            awsImageUrl                   // secondary_eob
          );
          
          // Insert secondary payment data into insurance log table
          await ordersDBtools.insertSecondaryInsuranceEOBLog(
            insuranceData.insurance_id,    // insurance_id
            null,                         // secondary_copay_amount (NULL)
            null,                         // secondary_allowed_amount (NULL)
            saleType,                     // secondary_rental (from SaleType column)
            paymentAmount,                // secondary_amount_of_eob
            awsImageUrl                   // secondary_eob_url
          );
          
          console.log(`  ✅ Secondary payment logged to insurance_fresh and insurance tables`);
        }
        
        // Insert interaction record
        const rawContent = paymentLevel === 'primary' ? null : 'secondary';
        await ordersDBtools.insertEOBInteraction(
          'fileUpload',                   // channel (always 'fileUpload')
          paymentDate,                    // timestamp (using actual payment date)
          paymentAmount,                  // length (using payment amount)
          dmeContactId,                   // from_id (DME contact)
          insuranceData.insurance_id,     // to_id (insurance_id, not contact_id)
          awsImageUrl,                    // attachment
          rawContent                      // raw_content (null for primary, 'secondary' for secondary)
        );
        
        console.log(`  ✅ Interaction logged`);
        
        processedCount++;
        
        // Add small delay to avoid overwhelming the database
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        console.error(`❌ Error processing payment record for ${row.FullName}:`, error.message);
        errorCount++;
      }
    }
    
    // Final summary
    console.log('\n=== PAYMENT PROCESSING COMPLETE ===');
    console.log(`✅ Successfully processed: ${processedCount} payments`);
    console.log(`📅 Already exists (skipped): ${alreadyExistsCount} payments`);
    console.log(`❌ Errors: ${errorCount}`);
    console.log(`⏭️ Other skipped: ${skippedCount}`);
    console.log(`📊 Total payment records in CSV: ${paymentRecords.length}`);
    
  } catch (error) {
    console.error('❌ Error in processPaymentData:', error.message);
    throw error;
  }
};

// Command line usage
if (require.main === module) {
  const csvFilePath = process.argv[2] || 'patient_data2026_7.csv';
  
  console.log(`Starting payment data processing for: ${csvFilePath}\n`);
  
  processPaymentData(csvFilePath)
    .then(() => {
      console.log('\n✅ Payment data processing completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Payment data processing failed:', error.message);
      process.exit(1);
    });
}

module.exports = {
  processPaymentData,
  parseFullName,
  getExistingContacts,
  getInsuranceDataForContact,
  parsePaymentDate,
  getPaymentLevel,
  getSaleType,
  checkExistingPaymentEntry
};