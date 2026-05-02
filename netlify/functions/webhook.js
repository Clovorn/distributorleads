exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 200, body: 'Webhook ready' };
  try {
    const params = new URLSearchParams(event.body);
    const formID = params.get('formID');
    const submissionID = params.get('submissionID');
    const rawRequest = params.get('rawRequest');
    if (formID && formID !== '260045399064863') return { statusCode: 200, body: 'Wrong form' };
    const s = rawRequest ? JSON.parse(rawRequest) : {};
    const get = (name) => {
      const val = s[name];
      if (!val) return '';
      if (typeof val === 'string') return val.trim();
      if (typeof val === 'object') return Object.values(val).filter(Boolean).join(', ').trim();
      return '';
    };
    const SB_URL = 'https://opnpyunbccifkdnbljsz.supabase.co';
    const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9wbnB5dW5iY2NpZmtkbmJsanN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3NTAzODMsImV4cCI6MjA5MzMyNjM4M30.UPu8TcE7PoVV4SqzUVlTQIsy_sgszylY988iZlOfBlk';
    const checkRes = await fetch(`${SB_URL}/rest/v1/leads?jotform_submission_id=eq.${submissionID}&select=id`, {
      headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
    });
    const existing = await checkRes.json();
    const fullName = get('customersFull');
    const nameParts = fullName.trim().split(' ');
    const interest = get('isCustomer');
    const route = ['Leasing Equipment','Financing Equipment'].includes(interest) ? 'leasing' : 'sales';
    const lead = {
      jotform_submission_id: submissionID,
      customer_full_name: fullName,
      customer_first_name: nameParts[0] || '',
      customer_last_name: nameParts.slice(1).join(' ') || '',
      contact_email: get('contactEmail'),
      contact_number: get('contactName7'),
      phone: get('phoneNumber'),
      legal_business_name: get('storeName8'),
      dba_name: get('whatIs'),
      store_address: [s['storeLocation_addr_line1'],s['storeLocation_city'],s['storeLocation_state'],s['storeLocation_zip']].filter(Boolean).join(', '),
      distributor_sales_rep: get('distributorSales'),
      distributor_rep_email: get('hthRep9'),
      distributor: get('distributor'),
      distributor_warehouse: get('distributorWarehouse37') || get('distributorWarehouse'),
      tradeshow_lead: get('tradeshowLead'),
      num_locations: get('numberOf'),
      customer_distributor_number: get('customersDistributor'),
      which_program: get('whichProgram'),
      customer_interest: interest,
      beverage_needs: get('pleaseProvide'),
      notes: get('typeA'),
      route, current_step: 'new_lead', status: 'active',
      jotform_answers: s, raw_csv: {},
    };
    const method = existing && existing.length > 0 ? 'PATCH' : 'POST';
    const url = existing && existing.length > 0
      ? `${SB_URL}/rest/v1/leads?jotform_submission_id=eq.${submissionID}`
      : `${SB_URL}/rest/v1/leads`;
    await fetch(url, {
      method,
      headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify(lead),
    });
    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    return { statusCode: 500, body: err.message };
  }
};
