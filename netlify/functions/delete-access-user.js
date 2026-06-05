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

  const userId = String(payload.user_id || '').trim();
  const registryId = String(payload.registry_id || '').trim();
  const email = String(payload.email || '').trim().toLowerCase();
  if (!userId && !registryId && !email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'user_id, registry_id, or email is required' }) };
  }

  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    // Gather matching registry rows first so we can delete auth users by id when present.
    let q = `${SB_URL}/rest/v1/access_users?select=id,auth_user_id,email`;
    if (registryId) {
      q += `&id=eq.${encodeURIComponent(registryId)}`;
    } else if (userId) {
      q += `&auth_user_id=eq.${encodeURIComponent(userId)}`;
    } else {
      q += `&email=eq.${encodeURIComponent(email)}`;
    }

    const regLookupRes = await fetch(q, { headers });
    const regRows = await regLookupRes.json().catch(() => []);
    const matchedRows = Array.isArray(regRows) ? regRows : [];

    const authIds = new Set();
    if (userId) authIds.add(userId);
    matchedRows.forEach((r) => { if (r.auth_user_id) authIds.add(r.auth_user_id); });

    let deletedAuthUsers = 0;
    for (const authUserId of authIds) {
      const delAuth = await fetch(`${SB_URL}/auth/v1/admin/users/${encodeURIComponent(authUserId)}`, {
        method: 'DELETE',
        headers,
      });
      const authBody = await delAuth.json().catch(() => ({}));
      if (delAuth.ok) deletedAuthUsers += 1;
      if (!delAuth.ok && delAuth.status !== 404) {
        return {
          statusCode: delAuth.status,
          body: JSON.stringify({ error: authBody.msg || authBody.message || 'Failed to delete auth user', detail: authBody }),
        };
      }
    }

    // Remove registry rows.
    let deletedRegistryRows = 0;
    const delHeaders = { ...headers, Prefer: 'return=representation' };
    if (registryId) {
      const del = await fetch(`${SB_URL}/rest/v1/access_users?id=eq.${encodeURIComponent(registryId)}`, {
        method: 'DELETE',
        headers: delHeaders,
      });
      const out = await del.json().catch(() => []);
      if (Array.isArray(out)) deletedRegistryRows += out.length;
    } else if (userId) {
      const del = await fetch(`${SB_URL}/rest/v1/access_users?auth_user_id=eq.${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        headers: delHeaders,
      });
      const out = await del.json().catch(() => []);
      if (Array.isArray(out)) deletedRegistryRows += out.length;
    }
    if (email) {
      const del = await fetch(`${SB_URL}/rest/v1/access_users?email=eq.${encodeURIComponent(email)}`, {
        method: 'DELETE',
        headers: delHeaders,
      });
      const out = await del.json().catch(() => []);
      if (Array.isArray(out)) deletedRegistryRows += out.length;
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        deleted_auth_users: deletedAuthUsers,
        deleted_registry_rows: deletedRegistryRows,
      }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
