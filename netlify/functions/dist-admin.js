// Admin-only: create / reset / list distributor Supabase Auth accounts and their company mapping.
// Requires server-side env vars (set in Netlify dashboard, never in the browser):
//   SUPABASE_URL          e.g. https://opnpyunbccifkdnbljsz.supabase.co
//   SUPABASE_SERVICE_KEY  the service_role key (Settings → API → service_role)
//   DIST_ADMIN_SECRET     a shared secret the internal app sends to authorize these calls
//
// The service key bypasses RLS, so this endpoint is gated behind DIST_ADMIN_SECRET.

const { createClient } = require('@supabase/supabase-js');

const COMPANIES = ['HT Hackney', 'Sledd', 'CoreMark'];

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'POST only' }) };

  const URL = process.env.SUPABASE_URL;
  const SERVICE = process.env.SUPABASE_SERVICE_KEY;
  const ADMIN_SECRET = process.env.DIST_ADMIN_SECRET;
  if (!URL || !SERVICE || !ADMIN_SECRET) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Server not configured (missing env vars).' }) };
  }
  if ((event.headers['x-admin-secret'] || '') !== ADMIN_SECRET) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Bad JSON' }) }; }
  const { action } = body;
  const admin = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });

  try {
    if (action === 'list') {
      const { data, error } = await admin
        .from('distributor_accounts')
        .select('user_id, distributor_company, display_name, created_at')
        .order('distributor_company');
      if (error) throw error;
      // join emails from auth
      const out = [];
      for (const r of data) {
        const { data: u } = await admin.auth.admin.getUserById(r.user_id);
        out.push({ ...r, email: u?.user?.email || '', last_sign_in_at: u?.user?.last_sign_in_at || null });
      }
      return { statusCode: 200, headers: cors, body: JSON.stringify({ users: out }) };
    }

    if (action === 'create') {
      const { email, password, company, display_name } = body;
      if (!email || !password || !COMPANIES.includes(company)) {
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'email, password, and a valid company are required.' }) };
      }
      if (String(password).length < 8) {
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Password must be at least 8 characters.' }) };
      }
      // create (or fetch existing) auth user
      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
      });
      let userId = created?.user?.id;
      if (cErr) {
        // if already exists, find them and update the password
        const { data: list } = await admin.auth.admin.listUsers();
        const existing = list?.users?.find(u => (u.email || '').toLowerCase() === email.toLowerCase());
        if (!existing) throw cErr;
        userId = existing.id;
        await admin.auth.admin.updateUserById(userId, { password });
      }
      // upsert the company mapping
      const { error: mErr } = await admin
        .from('distributor_accounts')
        .upsert({ user_id: userId, distributor_company: company, display_name: display_name || email }, { onConflict: 'user_id' });
      if (mErr) throw mErr;
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, user_id: userId, email, company }) };
    }

    if (action === 'setpw') {
      const { user_id, password } = body;
      if (!user_id || String(password || '').length < 8) {
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'user_id and an 8+ char password required.' }) };
      }
      const { error } = await admin.auth.admin.updateUserById(user_id, { password });
      if (error) throw error;
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
    }

    if (action === 'delete') {
      const { user_id } = body;
      if (!user_id) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'user_id required.' }) };
      await admin.from('distributor_accounts').delete().eq('user_id', user_id);
      const { error } = await admin.auth.admin.deleteUser(user_id);
      if (error) throw error;
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Unknown action.' }) };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message || String(err) }) };
  }
};
