require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');

const orders_db_credentials = JSON.parse(
  fs.readFileSync('game_db_credentials.json')
);

const pool = new Pool({
  host: orders_db_credentials.host,
  user: orders_db_credentials.user,
  database: orders_db_credentials.database,
  password: orders_db_credentials.password,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected PG pool error:', err);
});

/**
 * Update insurance_fresh with PRIMARY EOB data.
 * @param {number} insurance_id
 * @param {number|null} copay_amount
 * @param {number|null} allowed_amount
 * @param {string} rental - 'Rental' or 'Purchase'
 * @param {number} amount_of_eob
 */
async function updateInsuranceFreshWithEOBData(
  insurance_id,
  copay_amount,
  allowed_amount,
  rental,
  amount_of_eob
) {
  const text = `
    UPDATE insurance_fresh
    SET
      copay_amount   = $2,
      allowed_amount = $3,
      rental         = $4,
      amount_of_eob  = $5,
      created_at     = NOW()
    WHERE insurance_id = $1
  `;
  return pool.query(text, [insurance_id, copay_amount, allowed_amount, rental, amount_of_eob]);
}

/**
 * Update insurance_fresh with SECONDARY EOB data.
 * @param {number} insurance_id
 * @param {number|null} secondary_copay_amount
 * @param {number|null} secondary_allowed_amount
 * @param {string} secondary_rental - 'Rental' or 'Purchase'
 * @param {number} secondary_amount_of_eob
 * @param {string} secondary_eob - EOB document URL
 */
async function updateInsuranceFreshWithSecondaryEOBData(
  insurance_id,
  secondary_copay_amount,
  secondary_allowed_amount,
  secondary_rental,
  secondary_amount_of_eob,
  secondary_eob
) {
  const text = `
    UPDATE insurance_fresh
    SET
      secondary_copay_amount   = $2,
      secondary_allowed_amount = $3,
      secondary_rental         = $4,
      secondary_amount_of_eob  = $5,
      secondary_eob            = $6,
      created_at               = NOW()
    WHERE insurance_id = $1
  `;
  return pool.query(text, [
    insurance_id,
    secondary_copay_amount,
    secondary_allowed_amount,
    secondary_rental,
    secondary_amount_of_eob,
    secondary_eob,
  ]);
}

/**
 * Insert a PRIMARY EOB log row into the insurance table.
 * @param {number} insurance_id
 * @param {number|null} copay_amount
 * @param {number|null} allowed_amount
 * @param {string} rental
 * @param {number} amount_of_eob
 * @param {string} eob_url
 */
async function insertInsuranceEOBLog(
  insurance_id,
  copay_amount,
  allowed_amount,
  rental,
  amount_of_eob,
  eob_url
) {
  const text = `
    INSERT INTO insurance (
      insurance_id,
      copay_amount,
      allowed_amount,
      rental,
      amount_of_eob,
      eob,
      created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
  `;
  return pool.query(text, [
    insurance_id,
    copay_amount,
    allowed_amount,
    rental,
    amount_of_eob,
    eob_url,
  ]);
}

/**
 * Insert a SECONDARY EOB log row into the insurance table.
 * @param {number} insurance_id
 * @param {number|null} secondary_copay_amount
 * @param {number|null} secondary_allowed_amount
 * @param {string} secondary_rental
 * @param {number} secondary_amount_of_eob
 * @param {string} secondary_eob_url
 */
async function insertSecondaryInsuranceEOBLog(
  insurance_id,
  secondary_copay_amount,
  secondary_allowed_amount,
  secondary_rental,
  secondary_amount_of_eob,
  secondary_eob_url
) {
  const text = `
    INSERT INTO insurance (
      insurance_id,
      secondary_copay_amount,
      secondary_allowed_amount,
      secondary_rental,
      secondary_amount_of_eob,
      secondary_eob,
      created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
  `;
  return pool.query(text, [
    insurance_id,
    secondary_copay_amount,
    secondary_allowed_amount,
    secondary_rental,
    secondary_amount_of_eob,
    secondary_eob_url,
  ]);
}

/**
 * Insert an EOB interaction record into the interaction table.
 * @param {string} channel        - e.g. 'fileUpload'
 * @param {Date}   timestamp      - actual payment date from CSV
 * @param {number} length         - payment amount (stored in the length column)
 * @param {number} from_id        - DME contact ID (origin on the insurance story)
 * @param {number} to_id          - insurance_id (story_id of the insurance story)
 * @param {string} attachment     - spreadsheet / EOB document URL
 * @param {string|null} raw_content - null for primary, 'secondary' for secondary
 */
async function insertEOBInteraction(
  channel,
  timestamp,
  length,
  from_id,
  to_id,
  attachment,
  raw_content = null
) {
  const text = `
    INSERT INTO interaction (
      channel,
      timestamp,
      length,
      from_id,
      to_id,
      attachment,
      raw_content
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `;
  return pool.query(text, [channel, timestamp, length, from_id, to_id, attachment, raw_content]);
}

/**
 * Check whether a story log row already exists for this story with EOB status.
 * @param {number} story_id
 * @returns {Promise<boolean>}
 */
async function checkExistingEOBStoryLog(story_id) {
  const text = `
    SELECT COUNT(*) AS count
    FROM story
    WHERE story_id = $1
    AND status = 'EOB'
  `;
  const result = await pool.query(text, [story_id]);
  return parseInt(result.rows[0].count, 10) > 0;
}

/**
 * Update story_fresh status to EOB for a given story.
 * @param {number} story_id
 * @param {Date|string|null} created_at - timestamp to set (defaults to NOW() if null)
 */
async function updateStoryFreshToEOB(story_id, created_at = null) {
  const text = `
    UPDATE story_fresh
    SET
      status     = 'EOB',
      created_at = COALESCE($2, NOW()),
      username   = 'service@motusnova.com'
    WHERE story_id = $1
  `;
  return pool.query(text, [story_id, created_at]);
}

/**
 * Insert a story log row with EOB status.
 * @param {number} story_id
 * @param {number} destination - patient contact ID
 * @param {number} origin      - DME contact ID
 * @param {Date|string|null} created_at - timestamp to set (defaults to NOW() if null)
 */
async function insertStoryEOBLog(story_id, destination, origin, created_at = null) {
  const text = `
    INSERT INTO story (
      story_id,
      type,
      status,
      destination,
      origin,
      created_at,
      username
    )
    VALUES ($1, 'insurance', 'EOB', $2, $3, COALESCE($4, NOW()), 'service@motusnova.com')
  `;
  return pool.query(text, [story_id, destination, origin, created_at]);
}

module.exports = {
  updateInsuranceFreshWithEOBData,
  updateInsuranceFreshWithSecondaryEOBData,
  insertInsuranceEOBLog,
  insertSecondaryInsuranceEOBLog,
  insertEOBInteraction,
  checkExistingEOBStoryLog,
  updateStoryFreshToEOB,
  insertStoryEOBLog,
};