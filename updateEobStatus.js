require('dotenv').config();
const db = require('./db');
const ordersDBtools = require('./ordersDBTools');
const fs = require('fs');
const Papa = require('papaparse');

console.log('📄 STORY STATUS PROCESSOR SCRIPT 📄');
console.log('📋 This script updates story_fresh/story tables based on insurance status for existing patients\n');

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

    const firstNameParts = firstAndMiddle.split(/\s+/);
    const firstName = firstNameParts[0] || '';

    const lastNameParts = fullLastName.split(/\s+/);
    const lastName = lastNameParts[0] || '';

    return { lastName, firstName, fullLastName };
  } else {
    const lastNameParts = trimmed.split(/\s+/);
    const lastName = lastNameParts[0] || '';

    return { lastName, firstName: '', fullLastName: trimmed };
  }
};

// Function to parse PaymentDOS date into a Date (or null if invalid/missing).
// Mirrors the parsing used in the payment processor script.
const parsePaymentDate = (paymentDOS) => {
  if (!paymentDOS) return null;
  try {
    const date = new Date(paymentDOS);
    if (isNaN(date.getTime())) {
      console.warn(`Invalid PaymentDOS date: ${paymentDOS}`);
      return null;
    }
    return date;
  } catch (error) {
    console.warn(`Error parsing PaymentDOS: ${paymentDOS}`, error.message);
    return null;
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
      },
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
            CASE WHEN s.story_id IS NOT NULL THEN 0 ELSE 1 END,
            CASE 
              WHEN s.status IN ('EOB', 'submitted', 'readyToBill') THEN 0 
              ELSE 1 
            END,
            c.contact_id
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

const getInsuranceDataForContact = async (contactId) => {
  const query = `
    WITH ranked_insurance AS (
      SELECT 
        sf_insurance.story_id as insurance_id,
        sf_insurance.origin as dme_contact_id,
        sf_insurance.destination as patient_contact_id,
        sf_insurance.status as insurance_status,
        ROW_NUMBER() OVER (
          ORDER BY 
            CASE 
              WHEN sf_insurance.status IN ('EOB', 'submitted', 'readyToBill') THEN 0 
              ELSE 1 
            END,
            sf_insurance.story_id -- Tie breaker for consistency
        ) as rn
      FROM story_fresh sf_insurance
      WHERE sf_insurance.destination = $1
        AND sf_insurance.type = 'insurance'
        AND sf_insurance.status != 'duplicate'
        AND sf_insurance.status != 'cash'
        AND sf_insurance.status != 'optout'
    )
    SELECT 
      insurance_id,
      dme_contact_id,
      patient_contact_id,
      insurance_status
    FROM ranked_insurance
    WHERE rn = 1
  `;

  const result = await db.query(query, [contactId]);
  return result.rows[0] || null;
};

// Determine what action a record would trigger, WITHOUT writing to the database.
// Returns one of:
//   { action: 'updateAndLog' }      -> submitted/readyToBill: story_fresh update + story log insert
//   { action: 'logOnly' }           -> other status, no existing EOB log: story log insert
//   { action: 'skipAlreadyEOB' }    -> status already EOB: nothing to do
//   { action: 'skipLogExists' }     -> other status but EOB log already exists: nothing to do
const planActionForRecord = async (insuranceData) => {
  const currentStatus = (insuranceData.insurance_status || '').trim();
  const statusLower = currentStatus.toLowerCase();

  if (statusLower === 'eob') {
    return { action: 'skipAlreadyEOB', currentStatus };
  }

  if (statusLower === 'submitted' || statusLower === 'readytobill') {
    return { action: 'updateAndLog', currentStatus };
  }

  // returned / returning / any other status — depends on whether an EOB log exists
  const eobLogExists = await ordersDBtools.checkExistingEOBStoryLog(insuranceData.insurance_id);
  if (eobLogExists) {
    return { action: 'skipLogExists', currentStatus };
  }
  return { action: 'logOnly', currentStatus };
};

// Resolve a CSV payment record to a matched contact + insurance + planned action.
// Returns a result object describing the outcome (matched or a skip reason).
const resolveRecord = async (row, contactsMap) => {
  const parsedName = parseFullName(row.FullName);
  if (!parsedName.firstName || !parsedName.lastName) {
    return { matched: false, reason: 'unparseableName', fullName: row.FullName };
  }

  const nameKey = `${parsedName.firstName.toLowerCase().split(/\s+/)[0]}|${parsedName.lastName
    .toLowerCase()
    .split(/\s+/)[0]}`;

  const existingContact = contactsMap.get(nameKey);
  if (!existingContact) {
    return { matched: false, reason: 'notFound', fullName: row.FullName };
  }

  const insuranceData = await getInsuranceDataForContact(existingContact.contact_id);
  if (!insuranceData) {
    return {
      matched: false,
      reason: 'noInsurance',
      fullName: row.FullName,
      contactId: existingContact.contact_id,
    };
  }

  const plan = await planActionForRecord(insuranceData);

  return {
    matched: true,
    fullName: row.FullName,
    contactId: existingContact.contact_id,
    insuranceId: insuranceData.insurance_id,
    dmeContactId: insuranceData.dme_contact_id,
    patientContactId: insuranceData.patient_contact_id,
    currentStatus: plan.currentStatus,
    action: plan.action,
    paymentDate: parsePaymentDate(row.PaymentDOS), // used as created_at on story writes
    paymentDOSRaw: row.PaymentDOS || '',
  };
};

// Human-readable description of a planned action
const describeAction = (action) => {
  switch (action) {
    case 'updateAndLog':
      return 'WILL UPDATE story_fresh -> EOB + INSERT story log';
    case 'logOnly':
      return 'WILL INSERT EOB story log';
    case 'skipAlreadyEOB':
      return 'no action (already EOB)';
    case 'skipLogExists':
      return 'no action (EOB log already exists)';
    default:
      return action;
  }
};

// Build the list of records to be processed and print/export a preview report.
// Performs only READ queries — no writes.
const previewStoryStatus = async (csvFilePath, { exportCsv = true } = {}) => {
  console.log(`📖 Reading CSV file: ${csvFilePath}`);

  const csvData = await readCsvFile(csvFilePath);
  console.log(`✅ CSV parsed successfully. Found ${csvData.length} rows`);

  const requiredColumns = ['FullName', 'TransType', 'Payment', 'PaymentDOS'];
  const availableColumns = Object.keys(csvData[0] || {});
  const missingColumns = requiredColumns.filter((col) => !availableColumns.includes(col));

  if (missingColumns.length > 0) {
    console.error('❌ Missing required columns:', missingColumns);
    console.log('Available columns:', availableColumns);
    process.exit(1);
  }

  const paymentRecords = csvData.filter(
    (row) =>
      row.TransType &&
      row.TransType.trim().toLowerCase() === 'payment' &&
      row.Payment &&
      parseFloat(row.Payment) > 0
  );
  console.log(`🔍 Found ${paymentRecords.length} payment records in CSV`);

  console.log('🔍 Fetching existing contacts from database...');
  const existingContacts = await getExistingContacts();
  console.log(`✅ Found ${existingContacts.length} existing contacts in database`);

  const contactsMap = new Map();
  existingContacts.forEach((contact) => {
    const cleanFirstName = (contact.first_name_lower || '')
      .trim()
      .replace(/["']/g, '')
      .split(/\s+/)[0];
    const lastNameFirst = (contact.last_name_lower || '').trim().split(/\s+/)[0];
    const nameKey = `${cleanFirstName}|${lastNameFirst}`;
    contactsMap.set(nameKey, contact);
  });

  console.log('🔍 Analyzing which records would be updated (no writes)...\n');

  const willUpdate = [];     // records that would change the DB (updateAndLog | logOnly)
  const willSkip = [];       // matched but no action (skipAlreadyEOB | skipLogExists)
  const notMatched = [];     // unmatched / no insurance / unparseable
  const duplicateRows = [];  // matched rows for a story_id already handled this run

  // Track every story_id we've already accounted for so each story is
  // processed AT MOST ONCE, regardless of how many payment rows reference it.
  // (One patient/story can appear in many CSV payment rows.)
  const seenStoryIds = new Set();

  for (const row of paymentRecords) {
    try {
      const result = await resolveRecord(row, contactsMap);

      if (!result.matched) {
        notMatched.push(result);
        continue;
      }

      // Skip any story we've already seen this run — first occurrence wins.
      if (seenStoryIds.has(result.insuranceId)) {
        duplicateRows.push(result);
        continue;
      }
      seenStoryIds.add(result.insuranceId);

      if (result.action === 'updateAndLog' || result.action === 'logOnly') {
        willUpdate.push(result);
      } else {
        willSkip.push(result);
      }
    } catch (error) {
      console.error(`❌ Error analyzing record for ${row.FullName}:`, error.message);
      notMatched.push({ matched: false, reason: 'error', fullName: row.FullName, error: error.message });
    }
  }

  // Print the list of patients that WILL be updated
  console.log('=== PATIENTS THAT WILL BE UPDATED ===');
  if (willUpdate.length === 0) {
    console.log('(none)');
  } else {
    willUpdate.forEach((r, i) => {
      console.log(
        `${i + 1}. ${r.fullName} | Contact ${r.contactId} | Story ${r.insuranceId} | ` +
          `Status: ${r.currentStatus} | ${describeAction(r.action)}`
      );
    });
  }

  console.log('\n=== PREVIEW SUMMARY ===');
  console.log(`✅ Will be updated: ${willUpdate.length}`);
  console.log(`   ↳ story_fresh update + log (submitted/readyToBill): ${willUpdate.filter((r) => r.action === 'updateAndLog').length}`);
  console.log(`   ↳ log insert only (other status): ${willUpdate.filter((r) => r.action === 'logOnly').length}`);
  console.log(`⏭️ Matched but no action: ${willSkip.length}`);
  console.log(`   ↳ already EOB: ${willSkip.filter((r) => r.action === 'skipAlreadyEOB').length}`);
  console.log(`   ↳ EOB log already exists: ${willSkip.filter((r) => r.action === 'skipLogExists').length}`);
  console.log(`❌ Not matched / no insurance: ${notMatched.length}`);
  console.log(`🔁 Duplicate rows skipped (same story already handled): ${duplicateRows.length}`);
  console.log(`📊 Total payment records in CSV: ${paymentRecords.length}`);
  console.log(`🧾 Unique stories handled: ${seenStoryIds.size}`);

  // Optionally write the full preview to a CSV for review
  if (exportCsv) {
    const reportRows = [
      ...willUpdate.map((r) => ({
        full_name: r.fullName,
        contact_id: r.contactId,
        story_id: r.insuranceId,
        current_status: r.currentStatus,
        planned_action: r.action,
        action_description: describeAction(r.action),
        payment_dos: r.paymentDOSRaw,
        created_at_used: r.paymentDate ? r.paymentDate.toISOString() : 'NOW()',
      })),
      ...willSkip.map((r) => ({
        full_name: r.fullName,
        contact_id: r.contactId,
        story_id: r.insuranceId,
        current_status: r.currentStatus,
        planned_action: r.action,
        action_description: describeAction(r.action),
      })),
      ...notMatched.map((r) => ({
        full_name: r.fullName,
        contact_id: r.contactId || '',
        story_id: '',
        current_status: '',
        planned_action: r.reason,
        action_description: r.error || '',
      })),
      ...duplicateRows.map((r) => ({
        full_name: r.fullName,
        contact_id: r.contactId,
        story_id: r.insuranceId,
        current_status: r.currentStatus,
        planned_action: 'duplicateRow',
        action_description: 'skipped — story already handled this run',
      })),
    ];

    const outPath = `story_status_preview_${Date.now()}.csv`;
    fs.writeFileSync(outPath, Papa.unparse(reportRows));
    console.log(`\n📝 Full preview written to: ${outPath}`);
  }

  return { willUpdate, willSkip, notMatched, duplicateRows, paymentRecords };
};

// Main function to process story status updates (performs writes).
// Accepts an optional pre-computed plan from previewStoryStatus so we don't
// re-query; if not provided, it computes the plan first.
const processStoryStatus = async (csvFilePath, precomputed = null) => {
  try {
    const plan = precomputed || (await previewStoryStatus(csvFilePath, { exportCsv: false }));
    const { willUpdate } = plan;

    console.log('\n🔧 Applying updates to the database...');

    let processedCount = 0;
    let errorCount = 0;

    for (const r of willUpdate) {
      try {
        if (r.action === 'updateAndLog') {
          await ordersDBtools.updateStoryFreshToEOB(r.insuranceId, r.paymentDate);
          await ordersDBtools.insertStoryEOBLog(r.insuranceId, r.patientContactId, r.dmeContactId, r.paymentDate);
          console.log(`  ✅ ${r.fullName}: story_fresh -> EOB + log inserted (was ${r.currentStatus}, dated ${r.paymentDOSRaw || 'NOW'})`);
        } else if (r.action === 'logOnly') {
          // Re-check at write time in case state changed since the preview
          const eobLogExists = await ordersDBtools.checkExistingEOBStoryLog(r.insuranceId);
          if (eobLogExists) {
            console.log(`  ⏭️ ${r.fullName}: EOB story log now exists — skipping`);
            continue;
          }
          await ordersDBtools.insertStoryEOBLog(r.insuranceId, r.patientContactId, r.dmeContactId, r.paymentDate);
          console.log(`  ✅ ${r.fullName}: EOB story log inserted (was ${r.currentStatus}, dated ${r.paymentDOSRaw || 'NOW'})`);
        }

        processedCount++;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`❌ Error updating ${r.fullName}:`, error.message);
        errorCount++;
      }
    }

    console.log('\n=== STORY STATUS PROCESSING COMPLETE ===');
    console.log(`✅ Story records changed: ${processedCount}`);
    console.log(`❌ Errors: ${errorCount}`);
  } catch (error) {
    console.error('❌ Error in processStoryStatus:', error.message);
    throw error;
  }
};

// Command line usage
//   node processStoryStatus.js <csv>            -> PREVIEW only (default, safe)
//   node processStoryStatus.js <csv> --apply    -> preview then apply updates
if (require.main === module) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const csvFilePath = args.find((a) => !a.startsWith('--')) || 'patient_data2026_25.csv';

  if (!apply) {
    console.log(`DRY RUN — previewing story status updates for: ${csvFilePath}`);
    console.log('(no database writes; re-run with --apply to commit)\n');

    previewStoryStatus(csvFilePath)
      .then(() => {
        console.log('\n✅ Preview completed. Re-run with --apply to commit changes.');
        process.exit(0);
      })
      .catch((error) => {
        console.error('\n❌ Preview failed:', error.message);
        process.exit(1);
      });
  } else {
    console.log(`APPLY MODE — story status processing for: ${csvFilePath}\n`);

    previewStoryStatus(csvFilePath, { exportCsv: false })
      .then((plan) => processStoryStatus(csvFilePath, plan))
      .then(() => {
        console.log('\n✅ Story status processing completed successfully');
        process.exit(0);
      })
      .catch((error) => {
        console.error('\n❌ Story status processing failed:', error.message);
        process.exit(1);
      });
  }
}

module.exports = {
  previewStoryStatus,
  processStoryStatus,
  planActionForRecord,
  resolveRecord,
  parseFullName,
  getExistingContacts,
  getInsuranceDataForContact,
};