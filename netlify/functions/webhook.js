// netlify/functions/webhook.js
// Universal Jotform → Supabase webhook
// Works across ALL your Jotforms by matching field names by keyword,
// not by question number (which differs per form).

const SB_URL = 'https://opnpyunbccifkdnbljsz.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9wbnB5dW5iY2NpZmtkbmJsanN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3NTAzODMsImV4cCI6MjA5MzMyNjM4M30.UPu8TcE7PoVV4SqzUVlTQIsy_sgszylY988iZlOfBlk';

const FORM_PROGRAM_MAP = {
  '260045399064863': 'Java Select',
  '260696473895880': 'Sledd',
  // Add CoreMark and Farner-Bocken IDs here when you have them:
  // 'COREMARK_FORM_ID': 'CoreMark',
  // 'FARNER_BOCKEN_FORM_ID': 'Farner-Bocken',
};

const LEASING_INTERESTS = [
  'Leasing Equipment', 'Financing Equipment',
  'Loaned Equipment Program', 'Loaned Equipment Request', 'Loaned Request',
];

// Parse multipart/form-data — Jotform's actual POST format
function parseMultipart(body, boundary) {
  const fields = {};
  const parts = body.split('--' + boundary);
  for (const part of parts) {
    const match = part.match(/Content-Disposition: form-data; name="([^"]+)"\r\n\r\n([\s\S]*)/);
    if (match) {
      fields[match[1]] = match[2].replace(/\r\n$/, '');
    }
  }
  return fields;
}

// Search rawRequest for a field whose camelCase name contains any of the keywords.
// rawRequest keys look like: q19_customersFull, q6_contactEmail, q36_isCustomer
// We strip the qN_ prefix and do case-insensitive keyword matching.
function find(rr, ...keywords) {
  // Build a searchable index: strippedName → value
  for (const [key, val] of Object.entries(rr)) {
    // Strip leading qN_ prefix (e.g. "q19_" → "")
    const name = key.replace(/^q\d+_/, '').toLowerCase();

    if (keywords.some(kw => name.includes(kw.toLowerCase()))) {
      // Skip empty values
      if (val === null || val === undefined || val === '') continue;
      if (typeof val === 'object') {
        // Empty object check
        const vals = Object.values(val).filter(v => v && v !== '');
        if (vals.length === 0) continue;
        // Name field: {first, last}
        if ('first' in val || 'last' in val) {
          return `${val.first || ''} ${val.last || ''}`.trim();
        }
        // Address field: {addr_line1, addr_line2, city, state, postal}
        if ('addr_line1' in val || 'city' in val) {
          return [val.addr_line1, val.addr_line2, val.city, val.state, val.postal]
            .filter(Boolean).join(', ');
        }
        // Phone field: {full: "..."}
        if ('full' in val) return val.full || '';
        // Generic object — join values
        return vals.join(', ');
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

    // Netlify base64-encodes multipart bodies
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf-8')
      : (event.body || '');

    let formId = '';
    let submissionId = '';
    let rr = {};  // The flat rawRequest object with all form answers

    if (contentType.includes('multipart/form-data')) {
      const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
      if (!boundaryMatch) return { statusCode: 400, body: 'No multipart boundary' };

      const fields = parseMultipart(rawBody, boundaryMatch[1]);
      formId = fields.formID || fields.form_id || '';
      submissionId = fields.submissionID || fields.submission_id || '';

      if (fields.rawRequest) {
        try { rr = JSON.parse(fields.rawRequest); }
        catch (e) { console.error('rawRequest parse failed:', e.message); }
      }

    } else if (contentType.includes('application/json')) {
      const json = JSON.parse(rawBody);
      formId = String(json.formID || json.form_id || '');
      submissionId = String(json.submissionID || json.submission_id || '');
      if (json.rawRequest) {
        try { rr = JSON.parse(json.rawRequest); } catch (_) { rr = json.rawRequest || {}; }
      } else {
        rr = json.answers || json;
      }

    } else {
      // URL-encoded fallback
      const params = {};
      for (const pair of rawBody.split('&')) {
        const eq = pair.indexOf('=');
        if (eq < 0) continue;
        params[decodeURIComponent(pair.slice(0, eq).replace(/\+/g, ' '))] =
          decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
      }
      formId = params.formID || '';
      submissionId = params.submissionID || '';
      if (params.rawRequest) {
        try { rr = JSON.parse(params.rawRequest); } catch (_) {}
      }
    }

    console.log('formID:', formId, '| submissionID:', submissionId, '| rr fields:', Object.keys(rr).length);

    const programSource = FORM_PROGRAM_MAP[formId] || 'Java Select';

    // Deduplicate
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

    // ── Field extraction using keyword matching ──────────────────────────────
    // Keywords are matched against the camelCase field name after stripping qN_
    // All your Jotforms use consistent naming conventions so this works universally.

    const name = find(rr, 'customersfull', 'customerfull', 'customername', 'fullname');

    const interest = find(rr, 'iscustomer', 'customerinterest', 'interest');

    const isLeasing = LEASING_INTERESTS.some(li =>
      interest.toLowerCase().includes(li.toLowerCase())
    );

    // Phone: prefer the dedicated phone field; fall back to contactName (which holds phone on some forms)
    const phoneRaw = rr[Object.keys(rr).find(k => /^q\d+_phoneNumber$/i.test(k))] || {};
    const phone = (typeof phoneRaw === 'object' ? phoneRaw.full : phoneRaw) ||
      find(rr, 'contactname', 'phonenumber', 'phone') || '';

    // Address object handling
    const addrKey = Object.keys(rr).find(k => /storelocation|address/i.test(k.replace(/^q\d+_/, '')));
    const addrObj = addrKey ? rr[addrKey] : {};
    const address = typeof addrObj === 'object'
      ? [addrObj.addr_line1, addrObj.addr_line2, addrObj.city, addrObj.state, addrObj.postal].filter(Boolean).join(', ')
      : String(addrObj || '');

    const lead = {
      jotform_submission_id: submissionId || find(rr, 'uniqueid', 'uniqueId') || null,
      program_source: programSource,
      customer_full_name: name,
      customer_first_name: (() => {
        const f = rr[Object.keys(rr).find(k => /customersfull|customerfull/i.test(k.replace(/^q\d+_/, '')))];
        return (f && typeof f === 'object' && f.first) ? f.first : '';
      })(),
      customer_last_name: (() => {
        const f = rr[Object.keys(rr).find(k => /customersfull|customerfull/i.test(k.replace(/^q\d+_/, '')))];
        return (f && typeof f === 'object' && f.last) ? f.last : '';
      })(),
      contact_email: find(rr, 'contactemail', 'email'),
      phone: phone,
      contact_number: phone,
      legal_business_name: find(rr, 'storename8', 'legalname', 'legalbusiness', 'legalname'),
      dba_name: find(rr, 'whatis', 'dbaname', 'doingbusiness', 'storename') || name,
      store_address: address || find(rr, 'storelocation', 'address'),
      num_locations: find(rr, 'numberof', 'numlocations', 'locations'),
      customer_distributor_number: find(rr, 'customersdistributor', 'distributornumber', 'distnum', 'customerdist'),
      distributor_sales_rep: find(rr, 'distributorsales', 'distrep', 'salesrep', 'repname'),
      distributor_rep_email: find(rr, 'repemail', 'distrepemail', 'distributorrepemail'),
      distributor: find(rr, 'distributor'),
      distributor_warehouse: find(rr, 'distributorwarehouse', 'warehouse'),
      tradeshow_lead: find(rr, 'tradeshowlead', 'tradeshow'),
      which_program: find(rr, 'whichprogram', 'program'),
      customer_interest: interest,
      beverage_needs: find(rr, 'pleaseprovide', 'beverage', 'beverageneeds', 'typea'),
      notes: find(rr, 'pleaseprovide', 'notes', 'comments', 'additional'),
      route: isLeasing ? 'leasing' : 'sales',
      current_step: 'new_lead',
      status: 'active',
      submission_date: new Date().toISOString(),
      jotform_answers: rr,
    };

    console.log('Inserting lead:', lead.customer_full_name, '|', lead.contact_email, '|', programSource, '|', lead.route);

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
      console.error('Supabase insert error:', ins.status, err);
      return { statusCode: 500, body: 'Insert failed: ' + err };
    }

    console.log('Lead inserted successfully');
    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('Webhook exception:', err.message);
    return { statusCode: 500, body: 'Error: ' + err.message };
  }
};
