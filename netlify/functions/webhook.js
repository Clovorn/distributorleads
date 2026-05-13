// netlify/functions/webhook.js
// DIAGNOSTIC VERSION — logs raw Jotform POST body to Supabase so we can see exactly what's sent

const SB_URL = 'https://opnpyunbccifkdnbljsz.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9wbnB5dW5iY2NpZmtkbmJsanN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3NTAzODMsImV4cCI6MjA5MzMyNjM4M30.UPu8TcE7PoVV4SqzUVlTQIsy_sgszylY988iZlOfBlk';

const FORM_PROGRAM_MAP = {
  '260045399064863': 'Java Select',
  '260696473895880': 'Sledd',
};

const LEASING_INTERESTS = [
  'Leasing Equipment', 'Financing Equipment',
  'Loaned Equipment Program', 'Loaned Equipment Request', 'Loaned Request',
];

function parseUrlEncoded(rawBody) {
  const params = {};
  for (const pair of rawBody.split('&')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const key = decodeURIComponent(pair.slice(0, eqIdx).replace(/\+/g, ' '));
    const val = decodeURIComponent(pair.slice(eqIdx + 1).replace(/\+/g, ' '));
    params[key] = val;
  }
  return params;
}

function getAnswer(answers, ...keywords) {
  for (const field of Object.values(answers)) {
    const fieldName = (field.name || field.text || '').toLowerCase();
    if (keywords.some(kw => fieldName.includes(kw.toLowerCase())) && field.answer) {
      const a = field.answer;
      if (typeof a === 'object' && a !== null) {
        if (a.first !== undefined || a.last !== undefined)
          return `${a.first || ''} ${a.last || ''}`.trim();
        return Object.values(a).filter(Boolean).join(', ');
      }
      return String(a).trim();
    }
  }
  return '';
}

function getFlatParam(params, ...keywords) {
  for (const [key, val] of Object.entries(params)) {
    if (keywords.some(kw => key.toLowerCase().includes(kw.toLowerCase())) && val && String(val).trim())
      return String(val).trim();
  }
  return '';
}

exports.handler = async function (event) {
  if (event.httpMethod === 'GET') return { statusCode: 200, body: 'Webhook ready' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const rawBody = event.body || '';
  const contentType = (event.headers['content-type'] || '').toLowerCase();

  let params = {};
  let answers = {};
  let formId = '';
  let submissionId = '';

  try {
    if (contentType.includes('application/json')) {
      const json = JSON.parse(rawBody);
      formId = String(json.formID || json.form_id || '');
      submissionId = String(json.submissionID || json.submission_id || '');
      if (json.rawRequest) {
        try { answers = JSON.parse(json.rawRequest); } catch (_) { answers = {}; }
      } else {
        answers = json.answers || {};
      }
      params = json;
    } else {
      params = parseUrlEncoded(rawBody);
      formId = params.formID || params.form_id || '';
      submissionId = params.submissionID || params.submission_id || '';
      if (params.rawRequest) {
        try { answers = JSON.parse(params.rawRequest); } catch (_) { answers = {}; }
      }
    }

    // LOG the raw body to Supabase so we can inspect it
    await fetch(`${SB_URL}/rest/v1/webhook_log`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        content_type: contentType,
        raw_body: rawBody.slice(0, 8000), // cap at 8KB
        parsed_params: params,
        form_id: formId,
        submission_id: submissionId,
      }),
    });

    const programSource = FORM_PROGRAM_MAP[formId] || 'Java Select';

    // Skip duplicates
    if (submissionId) {
      const checkRes = await fetch(
        `${SB_URL}/rest/v1/leads?jotform_submission_id=eq.${encodeURIComponent(submissionId)}&select=id`,
        { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
      );
      const existing = await checkRes.json();
      if (Array.isArray(existing) && existing.length > 0)
        return { statusCode: 200, body: 'Duplicate — skipped' };
    }

    const gv = (...kws) => getAnswer(answers, ...kws) || getFlatParam(params, ...kws);

    const name = (
      gv('customer full', 'customer name', 'full name', 'customerfull') ||
      gv('store name', 'business name', 'dba name', 'storename') ||
      gv('doing business')
    ).trim();

    const interest = gv('interest', 'customer interest', 'customerinterest');
    const route = LEASING_INTERESTS.some(li => interest.toLowerCase().includes(li.toLowerCase()))
      ? 'leasing' : 'sales';

    const lead = {
      jotform_submission_id: submissionId || null,
      program_source: programSource,
      customer_full_name: name,
      customer_first_name: gv('first name', 'firstname'),
      customer_last_name: gv('last name', 'lastname'),
      contact_email: gv('email', 'contact email', 'contactemail'),
      phone: gv('phone', 'contact number', 'contactnumber', 'phonenumber'),
      contact_number: gv('phone', 'contact number', 'contactnumber'),
      legal_business_name: gv('legal business', 'legal name', 'legalname'),
      dba_name: gv('dba', 'store name', 'doing business', 'dbaname', 'storename') || name,
      store_address: gv('address', 'store address', 'storeaddress', 'location'),
      num_locations: gv('locations', 'num location', 'how many location', 'numlocations'),
      customer_distributor_number: gv('distributor number', 'dist number', 'customer dist'),
      distributor_sales_rep: gv('dist rep', 'distributor sales rep', 'rep name', 'distrep'),
      distributor_rep_email: gv('rep email', 'distributor rep email', 'repemail'),
      distributor: gv('distributor name', 'which distributor', 'distributorname'),
      distributor_warehouse: gv('warehouse', 'dist warehouse'),
      tradeshow_lead: gv('tradeshow', 'trade show'),
      which_program: gv('which program', 'program', 'coffee program', 'whichprogram'),
      customer_interest: interest,
      beverage_needs: gv('beverage', 'beverage needs'),
      notes: gv('notes', 'comments', 'additional'),
      route,
      current_step: 'new_lead',
      status: 'active',
      submission_date: new Date().toISOString(),
      jotform_answers: answers,
    };

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
      return { statusCode: 500, body: 'Insert failed: ' + err };
    }

    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    // Log the error too
    try {
      await fetch(`${SB_URL}/rest/v1/webhook_log`, {
        method: 'POST',
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ content_type: contentType, raw_body: 'ERROR: ' + err.message + '\n\nBODY: ' + rawBody.slice(0, 4000), form_id: '', submission_id: '' }),
      });
    } catch (_) {}
    return { statusCode: 500, body: 'Error: ' + err.message };
  }
};
