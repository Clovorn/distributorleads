exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const SB_URL = process.env.SUPABASE_URL || 'https://opnpyunbccifkdnbljsz.supabase.co';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!SERVICE_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SERVICE_KEY not configured.' }),
    };
  }

  let payload = {};
  try { payload = JSON.parse(event.body || '{}'); }
  catch (_e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const email = String(payload.email || '').trim().toLowerCase();
  const password = String(payload.password || '').trim();
  const incomingRole = String(payload.role || '').trim().toLowerCase();
  const registryRole = incomingRole === 'ronnoco_rep' ? 'sales_rep' : incomingRole;
  const authRole = registryRole === 'sales_rep' ? 'ronnoco_rep' : registryRole;

  const program_source = String(payload.program_source || '').trim();
  const distributor_name = String(payload.distributor_name || '').trim();
  const distributor_warehouse = String(payload.distributor_warehouse || '').trim();
  const sales_rep_name = String(payload.sales_rep_name || '').trim();
  const director_name = String(payload.director_name || '').trim();
  const rep_only = !!payload.rep_only;

  if (!email || !password || !registryRole) {
    return { statusCode: 400, body: JSON.stringify({ error: 'email, password, and role are required' }) };
  }
  if (password.length < 8) {
    return { statusCode: 400, body: JSON.stringify({ error: 'password must be at least 8 characters' }) };
  }
  if (!['admin', 'director', 'sales_rep', 'distributor'].includes(registryRole)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid role' }) };
  }
  if (registryRole === 'distributor' && !program_source) {
    return { statusCode: 400, body: JSON.stringify({ error: 'program_source is required for distributor role' }) };
  }

  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };

  const user_metadata = {
    role: authRole,
    ...(program_source ? { program_source } : {}),
    ...(distributor_name ? { distributor_name } : {}),
    ...(distributor_warehouse ? { distributor_warehouse } : {}),
    ...(sales_rep_name ? { sales_rep_name } : {}),
    ...(director_name ? { director_name } : {}),
    rep_only,
  };

  try {
    const authRes = await fetch(`${SB_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata,
        app_metadata: { role: authRole },
      }),
    });
    const authBody = await authRes.json().catch(() => ({}));

    if (!authRes.ok) {
      return {
        statusCode: authRes.status,
        body: JSON.stringify({ error: authBody.msg || authBody.message || 'Failed to create auth user', detail: authBody }),
      };
    }

    const authUserId = authBody.id || '';
    const regRow = {
      auth_user_id: authUserId || null,
      email,
      role: registryRole,
      program_source: program_source || null,
      distributor_name: distributor_name || null,
      distributor_warehouse: distributor_warehouse || null,
      sales_rep_name: sales_rep_name || null,
      director_name: director_name || null,
      rep_only,
      last_sign_in_at: authBody.last_sign_in_at || null,
    };

    const regRes = await fetch(`${SB_URL}/rest/v1/access_users?on_conflict=email`, {
      method: 'POST',
      headers: {
        ...headers,
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify(regRow),
    });
    const regBody = await regRes.json().catch(() => ([]));

    if (!regRes.ok) {
      const msg = Array.isArray(regBody) ? 'unknown error' : (regBody.message || regBody.error || 'unknown error');
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          warning: `Auth user created, but access_users upsert failed: ${msg}`,
          user_id: authUserId,
          email,
          role: registryRole,
        }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        user_id: authUserId,
        registry_id: (Array.isArray(regBody) && regBody[0] && regBody[0].id) ? regBody[0].id : null,
        email,
        role: registryRole,
      }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
