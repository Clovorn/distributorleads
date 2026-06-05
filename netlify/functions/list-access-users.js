exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
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

  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };

  const normalizeRole = (r) => {
    const s = String(r || '').trim().toLowerCase();
    if (s === 'ronnoco_rep' || s === 'ronnoco rep' || s === 'rep') return 'sales_rep';
    if (s === 'sales rep') return 'sales_rep';
    return s;
  };

  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/access_users?select=id,auth_user_id,email,role,program_source,distributor_name,distributor_warehouse,sales_rep_name,director_name,rep_only,created_at,last_sign_in_at&order=email.asc&limit=5000`,
      { headers },
    );
    const rows = await res.json().catch(() => []);

    if (!res.ok) {
      const msg = Array.isArray(rows) ? 'unknown error' : (rows.message || rows.error || 'unknown error');
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: `Failed to read public.access_users: ${msg}`,
          hint: 'Run the provided SQL migration to create/access_users table, then refresh.',
        }),
      };
    }

    const users = (Array.isArray(rows) ? rows : []).map((u) => ({
      id: u.auth_user_id || u.id || '',
      user_id: u.auth_user_id || '',
      registry_id: u.id || '',
      email: u.email || '',
      role: normalizeRole(u.role || ''),
      program_source: u.program_source || '',
      distributor_name: u.distributor_name || '',
      distributor_warehouse: u.distributor_warehouse || '',
      sales_rep_name: u.sales_rep_name || '',
      director_name: u.director_name || '',
      rep_only: !!u.rep_only,
      created_at: u.created_at || null,
      last_sign_in_at: u.last_sign_in_at || null,
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, source: 'access_users_registry', count: users.length, users }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
