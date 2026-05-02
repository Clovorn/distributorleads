exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, body: 'Webhook endpoint ready' };
  }
  try {
    const params = new URLSearchParams(event.body);
    const formID = params.get('formID');
    const submissionID = params.get('submissionID');
    const rawRequest = params.get('rawRequest');

    if (formID && formID !== '260154983685872') {
      return { statusCode: 200, body: 'Ignored - wrong form' };
    }

    const submission = rawRequest ? JSON.parse(rawRequest) : {};

    const SB_URL = 'https://hvmlmequwjxvrmgpltec.supabase.co';
    const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh2bWxtZXF1d2p4dnJtZ3BsdGVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0ODEyNzMsImV4cCI6MjA5MzA1NzI3M30.bT56CL9oK9HcRBQTry3G5kBqbseuGDaxKvqyDkCczHM';

    const checkRes = await fetch(`${SB_URL}/rest/v1/deals?jotform_submission_id=eq.${submissionID}&select=id`, {
      headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
    });
    const existing = await checkRes.json();
    if (existing && existing.length > 0) {
      return { statusCode: 200, body: 'Already exists' };
    }

    const get = (name) => {
      const val = submission[name];
      if (!val) return '';
      if (typeof val === 'string') return val.trim();
      if (typeof val === 'object') return Object.values(val).filter(Boolean).join(', ').trim();
      return '';
    };

    const contactName = get('typeA13');
    const nameParts = contactName.split(' ').filter(Boolean);

    const deal = {
      jotform_submission_id: submissionID || Date.now().toString(),
      first_name: nameParts[0] || 'Customer',
      last_name: nameParts.slice(1).join(' ') || '',
      email: get('contactsEmail'),
      phone: get('typeA12'),
      store_name: get('typeA15'),
      store_phone: get('typeA16'),
      legal_business_name: get('legalBusiness'),
      address: [submission['address_addr_line1'], submission['address_city'], submission['address_state'], submission['address_postal']].filter(Boolean).join(', '),
      sales_rep: get('ronnocoSales108'),
      rom: get('selectThe'),
      chain_store: get('chainStore') || 'No',
      purchase_type: get('pickWhich') || 'Equipment Lease',
      total_eq_cost: get('totalEq'),
      parent_distributor: get('parentDistributor'),
      target_install_date: get('targetInstall'),
      graphics_package: get('pickA'),
      emergency_install: get('emergencyInstall') || 'No',
      notes: get('pleaseGive'),
      coffee_program: get('coffeeProgram139'),
      sub_group: get('subGroup'),
      customer_account: get('customerAccount'),
      deal_type: get('pickWhich') || 'Equipment Lease',
      current_step: 'submitted',
      phase: 'leasing',
      jotform_answers: submission,
      raw_csv: {},
    };

    const insertRes = await fetch(`${SB_URL}/rest/v1/deals`, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(deal),
    });

    if (insertRes.ok) {
      return { statusCode: 200, body: 'Success' };
    } else {
      const err = await insertRes.text();
      return { statusCode: 500, body: 'Insert failed: ' + err };
    }
  } catch (err) {
    return { statusCode: 500, body: 'Error: ' + err.message };
  }
};
