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

  const requestedUserId = String(payload.user_id || '').trim();
  const registryId = String(payload.registry_id || '').trim();
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

  if (!email) return { statusCode: 400, body: JSON.stringify({ error: 'email is required' }) };
  if (!registryRole) return { statusCode: 400, body: JSON.stringify({ error: 'role is required' }) };
  if (!['admin', 'director', 'sales_rep', 'distributor'].includes(registryRole)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid role' }) };
  }
  if (registryRole === 'distributor' && !program_source) {
    return { statusCode: 400, body: JSON.stringify({ error: 'program_source is required for distributor role' }) };
  }
  if (password && password.length < 8) {
    return { statusCode: 400, body: JSON.stringify({ error: 'password must be at least 8 characters when provided' }) };
  }

  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    // Resolve auth user id from payload or registry by email.
    let authUserId = requestedUserId;
    if (!authUserId) {
      const lookup = await fetch(`${SB_URL}/rest/v1/access_users?select=id,auth_user_id,email&email=eq.${encodeURIComponent(email)}&limit=1`, { headers });
      const rows = await lookup.json().catch(() => []);
      if (lookup.ok && Array.isArray(rows) && rows[0]) authUserId = rows[0].auth_user_id || '';
    }

    if (authUserId) {
      const authBody = {
        email,
        user_metadata: {
          role: authRole,
          ...(program_source ? { program_source } : {}),
          ...(distributor_name ? { distributor_name } : {}),
          ...(distributor_warehouse ? { distributor_warehouse } : {}),
          ...(sales_rep_name ? { sales_rep_name } : {}),
          ...(director_name ? { director_name } : {}),
          rep_only,
        },
        app_metadata: { role: authRole },
      };
      if (password) authBody.password = password;

      const authRes = await fetch(`${SB_URL}/auth/v1/admin/users/${encodeURIComponent(authUserId)}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(authBody),
      });
      const authOut = await authRes.json().catch(() => ({}));
      if (!authRes.ok) {
        return {
          statusCode: authRes.status,
          body: JSON.stringify({ error: authOut.msg || authOut.message || 'Failed to update auth user', detail: authOut }),
        };
      }
    }

    const regRow = {
      ...(authUserId ? { auth_user_id: authUserId } : {}),
      email,
      role: registryRole,
      program_source: program_source || null,
      distributor_name: distributor_name || null,
      distributor_warehouse: distributor_warehouse || null,
      sales_rep_name: sales_rep_name || null,
      director_name: director_name || null,
      rep_only,
    };

    // Update existing registry row by id (preferred) or email. If missing, upsert by email.
    let regRes;
    if (registryId) {
      regRes = await fetch(`${SB_URL}/rest/v1/access_users?id=eq.${encodeURIComponent(registryId)}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify(regRow),
      });
    } else {
      regRes = await fetch(`${SB_URL}/rest/v1/access_users?email=eq.${encodeURIComponent(email)}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify(regRow),
      });
    }

    let regOut = await regRes.json().catch(() => []);
    if (regRes.ok && Array.isArray(regOut) && regOut.length) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          user_id: authUserId || regOut[0].auth_user_id || '',
          registry_id: regOut[0].id || null,
          email,
          role: registryRole,
        }),
      };
    }

    const upsertRes = await fetch(`${SB_URL}/rest/v1/access_users?on_conflict=email`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(regRow),
    });
    regOut = await upsertRes.json().catch(() => []);
    if (!upsertRes.ok) {
      const msg = Array.isArray(regOut) ? 'unknown error' : (regOut.message || regOut.error || 'unknown error');
      return { statusCode: 500, body: JSON.stringify({ error: `Failed to update access_users: ${msg}` }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        user_id: authUserId || (regOut[0] && regOut[0].auth_user_id) || '',
        registry_id: (regOut[0] && regOut[0].id) || null,
        email,
        role: registryRole,
      }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
