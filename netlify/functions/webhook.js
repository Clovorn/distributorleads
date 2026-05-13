// netlify/functions/webhook.js
// Receives Jotform webhook POSTs and inserts leads into Supabase
// Deploy this file to: netlify/functions/webhook.js in your GitHub repo

const SB_URL = 'https://opnpyunbccifkdnbljsz.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9wbnB5dW5iY2NpZmtkbmJsanN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3NTAzODMsImV4cCI6MjA5MzMyNjM4M30.UPu8TcE7PoVV4SqzUVlTQIsy_sgszylY988iZlOfBlk';

// Map Jotform form IDs to program names
const FORM_PROGRAM_MAP = {
  '260045399064863': 'Java Select',
  '260696473895880': 'Sledd',
  // Add CoreMark and Farner-Bocken IDs here when you have them:
  // 'YOUR_COREMARK_FORM_ID': 'CoreMark',
  // 'YOUR_FARNER_BOCKEN_FORM_ID': 'Farner-Bocken',
};

const LEASING_INTERESTS = [
  'Leasing Equipment',
  'Financing Equipment',
  'Loaned Equipment Program',
  'Loaned Equipment Request',
  'Loaned Request',
];

// Extract a value from Jotform's answers object by keyword matching on field names
function getAnswer(answers, ...keywords) {
  for (const field of Object.values(answers)) {
    const name = (field.name || field.text || '').toLowerCase();
    if (keywords.some(kw => name.includes(kw.toLowerCase())) && field.answer) {
      const a = field.answer;
      if (typeof a === 'object') {
        if (a.first || a.last) return `${a.first || ''} ${a.last || ''}`.trim();
        return Object.values(a).filter(Boolean).join(', ');
      }
      return String(a).trim();
    }
  }
  return '';
}

// Parse Jotform's URL-encoded POST body
function parseFormBody(body) {
  const params = {};
  for (const pair of body.split('&')) {
    const [k, v] = pair.split('=').map(decodeURIComponent);
    params[k] = v;
  }
  return params;
}

exports.handler = async function (event) {
  // Handle preflight / health check
  if (event.httpMethod === 'GET') {
    return { statusCode: 200, body: 'Webhook ready' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    // Jotform sends URL-encoded form data
    let rawAnswers = {};
    let formId = '';
    let submissionId = '';

    const contentType = event.headers['content-type'] || '';

    if (contentType.includes('application/json')) {
      // Some Jotform webhook configs send JSON
      const body = JSON.parse(event.body || '{}');
      rawAnswers = body.rawRequest ? JSON.parse(body.rawRequest) : body;
      formId = String(body.formID || body.form_id || '');
      submissionId = String(body.submissionID || body.submission_id || '');
    } else {
      // Default: URL-encoded
      const params = parseFormBody(event.body || '');
      formId = params.formID || params.form_id || '';
      submissionId = params.submissionID || params.submission_id || '';

      // Jotform encodes answers as a JSON string in rawRequest
      if (params.rawRequest) {
        try { rawAnswers = JSON.parse(params.rawRequest); } catch (_) {}
      } else {
        rawAnswers = params;
      }
    }

    // Determine program from form ID
    const programSource = FORM_PROGRAM_MAP[formId] || 'Java Select';

    // Check for duplicate submission
    const checkRes = await fetch(
      `${SB_URL}/rest/v1/leads?jotform_submission_id=eq.${encodeURIComponent(submissionId)}&select=id`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    const existing = await checkRes.json();
    if (Array.isArray(existing) && existing.length > 0) {
      console.log('Duplicate submission, skipping:', submissionId);
      return { statusCode: 200, body: 'Duplicate — skipped' };
    }

    // Parse answers
    const gv = (...kws) => getAnswer(rawAnswers, ...kws);

    const name = (
      gv('customer full', 'customer name', 'full name') ||
      gv('store name', 'business name', 'dba') ||
      gv('doing business')
    ).trim();

    const interest = gv('interest', 'customer interest');
    const isLeasing = LEASING_INTERESTS.some(li =>
      interest.toLowerCase().includes(li.toLowerCase())
    );
    const route = isLeasing ? 'leasing' : 'sales';

    const lead = {
      jotform_submission_id: submissionId,
      program_source: programSource,
      customer_full_name: name,
      customer_first_name: gv('first name'),
      customer_last_name: gv('last name'),
      contact_email: gv('email', 'contact email'),
      phone: gv('phone', 'contact number'),
      contact_number: gv('phone', 'contact number'),
      legal_business_name: gv('legal business', 'legal name'),
      dba_name: gv('dba', 'store name', 'doing business') || name,
      store_address: gv('address', 'store address', 'location'),
      num_locations: gv('locations', 'num location', 'how many location'),
      customer_distributor_number: gv('distributor number', 'dist number', 'customer dist'),
      distributor_sales_rep: gv('dist rep', 'distributor sales rep', 'rep name'),
      distributor_rep_email: gv('rep email', 'distributor rep email'),
      distributor: gv('distributor name', 'which distributor'),
      distributor_warehouse: gv('warehouse', 'dist warehouse'),
      tradeshow_lead: gv('tradeshow', 'trade show'),
      which_program: gv('which program', 'program', 'coffee program'),
      customer_interest: interest,
      beverage_needs: gv('beverage', 'beverage needs'),
      notes: gv('notes', 'comments', 'additional'),
      route,
      current_step: 'new_lead',
      status: 'active',
      submission_date: new Date().toISOString(),
      jotform_answers: rawAnswers,
    };

    // Insert into Supabase
    const insertRes = await fetch(`${SB_URL}/rest/v1/leads`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(lead),
    });

    if (!insertRes.ok) {
      const err = await insertRes.text();
      console.error('Supabase insert error:', err);
      return { statusCode: 500, body: 'Insert failed: ' + err };
    }

    console.log('Lead inserted:', name, '|', programSource, '|', submissionId);
    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('Webhook error:', err);
    return { statusCode: 500, body: 'Error: ' + err.message };
  }
};
