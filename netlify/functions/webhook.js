// netlify/functions/webhook.js
// Receives Jotform webhook POSTs and inserts leads into Supabase

const SB_URL = 'https://opnpyunbccifkdnbljsz.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9wbnB5dW5iY2NpZmtkbmJsanN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3NTAzODMsImV4cCI6MjA5MzMyNjM4M30.UPu8TcE7PoVV4SqzUVlTQIsy_sgszylY988iZlOfBlk';

const FORM_PROGRAM_MAP = {
  '260045399064863': 'Java Select',
  '260696473895880': 'Sledd',
  // Add CoreMark and Farner-Bocken IDs here when you have them
};

const LEASING_INTERESTS = [
  'Leasing Equipment',
  'Financing Equipment',
  'Loaned Equipment Program',
  'Loaned Equipment Request',
  'Loaned Request',
];

// Jotform sends URL-encoded bodies. This correctly decodes them
// including the nested rawRequest JSON string.
function parseJotformBody(rawBody) {
  const params = {};
  const pairs = rawBody.split('&');
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const key = decodeURIComponent(pair.slice(0, eqIdx).replace(/\+/g, ' '));
    const val = decodeURIComponent(pair.slice(eqIdx + 1).replace(/\+/g, ' '));
    params[key] = val;
  }
  return params;
}

// Extract answer from Jotform's rawRequest answers object.
// Each field looks like: { name: "fieldName", text: "Label", answer: "value" | {first,last} }
function getAnswer(answers, ...keywords) {
  for (const field of Object.values(answers)) {
    const fieldName = (field.name || field.text || '').toLowerCase();
    const matches = keywords.some(kw => fieldName.includes(kw.toLowerCase()));
    if (matches && field.answer) {
      const a = field.answer;
      if (typeof a === 'object' && a !== null) {
        if (a.first !== undefined || a.last !== undefined) {
          return `${a.first || ''} ${a.last || ''}`.trim();
        }
        return Object.values(a).filter(Boolean).join(', ');
      }
      return String(a).trim();
    }
  }
  return '';
}

// Fallback: search the flat params for a matching key (q3_fieldName style)
function getFlatParam(params, ...keywords) {
  for (const [key, val] of Object.entries(params)) {
    const k = key.toLowerCase();
    if (keywords.some(kw => k.includes(kw.toLowerCase())) && val && val.trim()) {
      return val.trim();
    }
  }
  return '';
}

exports.handler = async function (event) {
  // Health check
  if (event.httpMethod === 'GET') {
    return { statusCode: 200, body: 'Webhook ready' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const body = event.body || '';
    const contentType = (event.headers['content-type'] || '').toLowerCase();

    let params = {};
    let answers = {};
    let formId = '';
    let submissionId = '';

    if (contentType.includes('application/json')) {
      const json = JSON.parse(body);
      formId = String(json.formID || json.form_id || '');
      submissionId = String(json.submissionID || json.submission_id || '');
      if (json.rawRequest) {
        try { answers = JSON.parse(json.rawRequest); } catch (_) { answers = json.rawRequest || {}; }
      } else {
        answers = json.answers || json;
      }
      params = json;
    } else {
      // Standard Jotform webhook: application/x-www-form-urlencoded
      // with a rawRequest field containing JSON-encoded answers
      params = parseJotformBody(body);
      formId = params.formID || params.form_id || '';
      submissionId = params.submissionID || params.submission_id || '';

      if (params.rawRequest) {
        try {
          answers = JSON.parse(params.rawRequest);
        } catch (e) {
          console.error('Failed to parse rawRequest:', e.message);
          answers = {};
        }
      }
    }

    console.log('Webhook received - formID:', formId, 'submissionID:', submissionId, 'answer fields:', Object.keys(answers).length);

    const programSource = FORM_PROGRAM_MAP[formId] || 'Java Select';

    // Skip duplicates
    if (submissionId) {
      const checkRes = await fetch(
        `${SB_URL}/rest/v1/leads?jotform_submission_id=eq.${encodeURIComponent(submissionId)}&select=id`,
        { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
      );
      const existing = await checkRes.json();
      if (Array.isArray(existing) && existing.length > 0) {
        console.log('Duplicate submission, skipping:', submissionId);
        return { statusCode: 200, body: 'Duplicate — skipped' };
      }
    }

    // Try answers object first, then flat params as fallback
    const gv = (...kws) => getAnswer(answers, ...kws) || getFlatParam(params, ...kws);

    const name = (
      gv('customer full', 'customer name', 'full name', 'customerfull') ||
      gv('store name', 'business name', 'dba name', 'storename') ||
      gv('doing business')
    ).trim();

    const interest = gv('interest', 'customer interest', 'customerinterest');
    const isLeasing = LEASING_INTERESTS.some(li =>
      interest.toLowerCase().includes(li.toLowerCase())
    );
    const route = isLeasing ? 'leasing' : 'sales';

    const lead = {
      jotform_submission_id: submissionId || null,
      program_source: programSource,
      customer_full_name: name,
      customer_first_name: gv('first name', 'firstname'),
      customer_last_name: gv('last name', 'lastname'),
      contact_email: gv('email', 'contact email', 'contactemail'),
      phone: gv('phone', 'contact number', 'contactnumber', 'phonenumber'),
      contact_number: gv('phone', 'contact number', 'contactnumber'),
      legal_business_name: gv('legal business', 'legal name', 'legalname', 'legalbusiness'),
      dba_name: gv('dba', 'store name', 'doing business', 'dbaname', 'storename') || name,
      store_address: gv('address', 'store address', 'storeaddress', 'location'),
      num_locations: gv('locations', 'num location', 'how many location', 'numlocations'),
      customer_distributor_number: gv('distributor number', 'dist number', 'customer dist', 'distributornumber'),
      distributor_sales_rep: gv('dist rep', 'distributor sales rep', 'rep name', 'distrep', 'salesrep'),
      distributor_rep_email: gv('rep email', 'distributor rep email', 'repemail'),
      distributor: gv('distributor name', 'which distributor', 'distributorname'),
      distributor_warehouse: gv('warehouse', 'dist warehouse', 'distributorwarehouse'),
      tradeshow_lead: gv('tradeshow', 'trade show'),
      which_program: gv('which program', 'program', 'coffee program', 'whichprogram'),
      customer_interest: interest,
      beverage_needs: gv('beverage', 'beverage needs', 'beverageneeds'),
      notes: gv('notes', 'comments', 'additional'),
      route,
      current_step: 'new_lead',
      status: 'active',
      submission_date: new Date().toISOString(),
      jotform_answers: answers,
    };

    console.log('Inserting lead:', lead.customer_full_name, '|', lead.contact_email, '|', programSource);

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
      console.error('Supabase insert error:', insertRes.status, err);
      return { statusCode: 500, body: 'Insert failed: ' + err };
    }

    console.log('Lead inserted successfully:', name);
    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('Webhook exception:', err.message, err.stack);
    return { statusCode: 500, body: 'Error: ' + err.message };
  }
};
