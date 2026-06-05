// netlify/functions/submit-lead.js
// Public lead submission — accepts form fields + optional base64 photos.
// Uploads photos to Supabase Storage, stores URLs in jotform_answers.

const SB_URL = 'https://opnpyunbccifkdnbljsz.supabase.co';
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY || 'eyJhbG…fBlk';
const BUCKET  = 'lead-photos';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type':                 'application/json',
};

const LEASING_INTERESTS = [
  'Leasing Equipment', 'Financing Equipment',
  'Loaned Equipment Program', 'Loaned Equipment Request', 'Loaned Request',
];

// Upload a single base64-encoded image to Supabase Storage.
// Returns the public URL or null on failure.
async function uploadPhoto(base64Data, mimeType, filename) {
  try {
    const binary = Buffer.from(base64Data, 'base64');
    const res = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${filename}`, {
      method:  'POST',
      headers: {
        apikey:          SB_KEY,
        Authorization:   `Bearer ${SB_KEY}`,
        'Content-Type':  mimeType || 'image/jpeg',
        'x-upsert':      'true',
      },
      body: binary,
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('Photo upload failed:', res.status, err);
      return null;
    }
    return `${SB_URL}/storage/v1/object/public/${BUCKET}/${filename}`;
  } catch (e) {
    console.error('Photo upload exception:', e.message);
    return null;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  // ── Required field validation ────────────────────────────────────────────
  const dba       = (body.dba_name          || '').trim();
  const warehouse = (body.distributor_warehouse || '').trim();
  const program   = (body.which_program     || '').trim();
  const interest  = (body.customer_interest || '').trim();
  const repName   = (body.distributor_sales_rep || '').trim();

  if (!repName)   return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Your name is required.' }) };
  if (!dba)       return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Business / DBA name is required.' }) };
  if (!warehouse) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Warehouse is required.' }) };
  if (!program)   return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Program is required.' }) };
  if (!interest)  return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Equipment interest is required.' }) };

  // ── Upload photos ────────────────────────────────────────────────────────
  const photoUrls = {};
  const photos = Array.isArray(body.photos) ? body.photos.slice(0, 4) : [];
  const ts = Date.now();

  for (const photo of photos) {
    if (!photo.data) continue;
    const label    = (photo.label || 'photo').replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const ext      = (photo.mimeType || 'image/jpeg').includes('png') ? 'png' : 'jpg';
    const filename = `${ts}-${label}.${ext}`;
    const url = await uploadPhoto(photo.data, photo.mimeType || 'image/jpeg', filename);
    if (url) photoUrls[photo.label || label] = url;
  }

  // ── Build lead record ────────────────────────────────────────────────────
  const isLeasing = LEASING_INTERESTS.some(l =>
    interest.toLowerCase().includes(l.toLowerCase())
  );

  const firstName = (body.customer_first_name || '').trim();
  const lastName  = (body.customer_last_name  || '').trim();
  const fullName  = [firstName, lastName].filter(Boolean).join(' ');

  const jotformAnswers = Object.keys(photoUrls).length > 0
    ? { photo_urls: photoUrls }
    : null;

  const rec = {
    jotform_submission_id:       'dist-' + ts,
    program_source:              body.program_source || program || null,
    distributor_company:         body.distributor_company       || null,
    distributor:                 body.distributor_company       || null,
    distributor_warehouse:       warehouse                      || null,
    distributor_sales_rep:       repName                        || null,
    distributor_rep_email:       body.distributor_rep_email     || null,
    customer_distributor_number: body.customer_distributor_number || null,
    dba_name:                    dba,
    legal_business_name:         body.legal_business_name       || null,
    customer_full_name:          fullName                       || null,
    customer_first_name:         firstName                      || null,
    customer_last_name:          lastName                       || null,
    contact_email:               body.contact_email             || null,
    phone:                       body.phone                     || null,
    contact_number:              body.phone                     || null,
    store_address:               body.store_address             || null,
    num_locations:               body.num_locations             || null,
    which_program:               program                        || null,
    customer_interest:           interest                       || null,
    beverage_needs:              body.beverage_needs            || null,
    notes:                       body.notes                     || null,
    tradeshow_lead:              body.tradeshow_lead ? 'Yes' : 'No',
    jotform_answers:             jotformAnswers,
    route:                       isLeasing ? 'leasing' : 'sales',
    current_step:                'lead_received',
    status:                      'active',
    submission_date:             new Date().toISOString(),
  };

  const res = await fetch(`${SB_URL}/rest/v1/leads`, {
    method:  'POST',
    headers: {
      apikey:         SB_KEY,
      Authorization:  `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer:         'return=minimal',
    },
    body: JSON.stringify(rec),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Supabase insert error:', res.status, err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Failed to save lead. Please try again.' }) };
  }

  const photoCount = Object.keys(photoUrls).length;
  console.log(`Lead submitted: ${dba} | ${body.distributor_company} | ${program} | ${photoCount} photo(s)`);
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, photos: photoCount }) };
};
