// netlify/functions/webhook.js
// Handles Jotform multipart/form-data webhooks → Supabase

const SB_URL = 'https://opnpyunbccifkdnbljsz.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9wbnB5dW5iY2NpZmtkbmJsanN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3NTAzODMsImV4cCI6MjA5MzMyNjM4M30.UPu8TcE7PoVV4SqzUVlTQIsy_sgszylY988iZlOfBlk';

const FORM_PROGRAM_MAP = {
  '260045399064863': 'Java Select',
  '260696473895880': 'Sledd',
  // Add CoreMark and Farner-Bocken IDs here when you have them
};

const LEASING_INTERESTS = [
  'Leasing Equipment', 'Financing Equipment',
  'Loaned Equipment Program', 'Loaned Equipment Request', 'Loaned Request',
];

// Parse multipart/form-data body — extracts named fields into a flat object
function parseMultipart(body, boundary) {
  const fields = {};
  // Split on boundary lines
  const parts = body.split('--' + boundary);
  for (const part of parts) {
    const match = part.match(/Content-Disposition: form-data; name="([^"]+)"\r\n\r\n([\s\S]*)/);
    if (match) {
      const key = match[1];
      // Value is everything after the double CRLF, strip trailing CRLF
      const val = match[2].replace(/\r\n$/, '');
      fields[key] = val;
    }
  }
  return fields;
}

// Jotform rawRequest is a flat JSON object with keys like "q19_customersFull"
// Values are either strings or objects like {first, last} or {addr_line1, city, state, postal}
function extractField(rr, ...keywords) {
  for (const [key, val] of Object.entries(rr)) {
    // Match against the camelCase part after qN_
    const fieldName = key.replace(/^q\d+_/, '').toLowerCase();
    if (keywords.some(kw => fieldName.includes(kw.toLowerCase()))) {
      if (!val || val === '' || (typeof val === 'object' && Object.values(val).every(v => !v))) {
        continue; // skip empty
      }
      if (typeof val === 'object') {
        // Name field: {first, last}
        if (val.first !== undefined || val.last !== undefined) {
          return `${val.first || ''} ${val.last || ''}`.trim();
        }
        // Address field: {addr_line1, city, state, postal}
        return Object.values(val).filter(Boolean).join(', ');
      }
      return String(val).trim();
    }
  }
  return '';
}

exports.handler = async function (event) {
  if (event.httpMethod === 'GET') return { statusCode: 200, body: 'Webhook ready' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  try {
    const contentType = event.headers['content-type'] || '';
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf-8')
      : (event.body || '');

    let formId = '';
    let submissionId = '';
    let rr = {}; // rawRequest — the actual form answers

    if (contentType.includes('multipart/form-data')) {
      // Extract boundary from content-type header
      const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
      if (!boundaryMatch) {
        return { statusCode: 400, body: 'No boundary in multipart' };
      }
      const boundary = boundaryMatch[1];
      const fields = parseMultipart(rawBody, boundary);

      formId = fields.formID || fields.form_id || '';
      submissionId = fields.submissionID || fields.submission_id || '';

      // rawRequest is a JSON string with the actual form field values
      if (fields.rawRequest) {
        try { rr = JSON.parse(fields.rawRequest); } catch (e) {
          console.error('rawRequest parse error:', e.message);
        }
      }
    } else if (contentType.includes('application/json')) {
      const json = JSON.parse(rawBody);
      formId = String(json.formID || json.form_id || '');
      submissionId = String(json.submissionID || json.submission_id || '');
      if (json.rawRequest) {
        try { rr = JSON.parse(json.rawRequest); } catch (_) { rr = json.rawRequest || {}; }
      } else {
        rr = json;
      }
    } else {
      // URL-encoded fallback
      const params = {};
      for (const pair of rawBody.split('&')) {
        const eq = pair.indexOf('=');
        if (eq === -1) continue;
        params[decodeURIComponent(pair.slice(0, eq).replace(/\+/g, ' '))] =
          decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
      }
      formId = params.formID || '';
      submissionId = params.submissionID || '';
      if (params.rawRequest) {
        try { rr = JSON.parse(params.rawRequest); } catch (_) {}
      }
    }

    console.log('Webhook — formID:', formId, 'submissionID:', submissionId, 'rr keys:', Object.keys(rr).length);

    const programSource = FORM_PROGRAM_MAP[formId] || 'Java Select';

    // Deduplicate by submissionID
    if (submissionId) {
      const chk = await fetch(
        `${SB_URL}/rest/v1/leads?jotform_submission_id=eq.${encodeURIComponent(submissionId)}&select=id`,
        { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
      );
      const existing = await chk.json();
      if (Array.isArray(existing) && existing.length > 0) {
        console.log('Duplicate, skipping:', submissionId);
        return { statusCode: 200, body: 'Duplicate — skipped' };
      }
    }

    const f = (...kws) => extractField(rr, ...kws);

    // Map exact field names from your Jotform (confirmed from live submission):
    // q3_distributorSales       → distributor sales rep
    // q38_tradeshowLead         → tradeshow
    // q13_phoneNumber           → phone {full}
    // q37_distributorWarehouse37 / q29_distributorWarehouse → warehouse
    // q28_distributor           → distributor
    // q31_whichProgram          → which program
    // q36_isCustomer            → customer interest (leasing/buying/etc)
    // q19_customersFull         → customer name {first, last}
    // q6_contactEmail           → email
    // q7_contactName7           → phone number (contact)
    // q8_storeName8             → legal name / state filed
    // q16_whatIs                → DBA / store name
    // q34_customersDistributor  → customer distributor number
    // q32_numberOf              → number of locations
    // q5_storeLocation          → address {addr_line1, city, state, postal}
    // q35_uniqueId              → unique ID (used as jotform_submission_id fallback)
    // q9_hthRep9                → HTH/internal rep
    // q30_pleaseProvide         → notes/beverage needs

    const name = f('customersfull', 'customerfull', 'customerName', 'fullname');
    const interest = f('isCustomer', 'interest', 'customerInterest');
    const isLeasing = LEASING_INTERESTS.some(li => interest.toLowerCase().includes(li.toLowerCase()));

    // Address object
    const addrObj = rr.q5_storeLocation || {};
    const address = [addrObj.addr_line1, addrObj.addr_line2, addrObj.city, addrObj.state, addrObj.postal]
      .filter(Boolean).join(', ');

    // Phone: q13 is {full:""}, q7 is the contact number string
    const phone = f('phoneNumber', 'contactName7', 'phone', 'contactnumber') ||
      (rr.q13_phoneNumber && rr.q13_phoneNumber.full) || '';

    const lead = {
      jotform_submission_id: submissionId || f('uniqueId') || null,
      program_source: programSource,
      customer_full_name: name,
      customer_first_name: (rr.q19_customersFull && rr.q19_customersFull.first) || '',
      customer_last_name: (rr.q19_customersFull && rr.q19_customersFull.last) || '',
      contact_email: f('contactEmail', 'email'),
      phone: phone,
      contact_number: f('contactName7', 'phone', 'contactnumber'),
      legal_business_name: f('storeName8', 'legalname', 'legal'),
      dba_name: f('whatIs', 'dbaname', 'storename', 'doingbusiness') || name,
      store_address: address || f('storeLocation', 'address', 'location'),
      num_locations: f('numberOf', 'locations', 'numlocations'),
      customer_distributor_number: f('customersDistributor', 'distributornumber', 'distnum'),
      distributor_sales_rep: f('distributorSales', 'distrep', 'salesrep', 'repname'),
      distributor_rep_email: f('repEmail', 'distrepemail'),
      distributor: f('distributor', 'distributorname'),
      distributor_warehouse: f('distributorWarehouse', 'warehouse'),
      tradeshow_lead: f('tradeshowLead', 'tradeshow'),
      which_program: f('whichProgram', 'program'),
      customer_interest: interest,
      beverage_needs: f('pleaseProvide', 'beverage', 'beverageneeds', 'typeA'),
      notes: f('pleaseProvide', 'notes', 'comments'),
      route: isLeasing ? 'leasing' : 'sales',
      current_step: 'new_lead',
      status: 'active',
      submission_date: new Date().toISOString(),
      jotform_answers: rr,
    };

    console.log('Inserting:', lead.customer_full_name, '|', lead.contact_email, '|', programSource);

    const ins = await fetch(`${SB_URL}/rest/v1/leads`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(lead),
    });

    if (!ins.ok) {
      const err = await ins.text();
      console.error('Insert failed:', ins.status, err);
      return { statusCode: 500, body: 'Insert failed: ' + err };
    }

    console.log('Lead inserted successfully');
    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('Webhook error:', err.message, err.stack);
    return { statusCode: 500, body: 'Error: ' + err.message };
  }
};
