// netlify/functions/send-email.js
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'RESEND_API_KEY not configured' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { to, subject, body, from_name, from_email } = payload;
  if (!to || !subject || !body) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields: to, subject, body' }) };
  }

  // from_email must be a verified domain in Resend
  // Falls back to onboarding@resend.dev for testing
  const fromAddress = from_email
    ? `${from_name || 'Ronnoco Portal'} <${from_email}>`
    : 'Ronnoco Portal <onboarding@resend.dev>';

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddress,
        to: Array.isArray(to) ? to : [to],
        subject,
        text: body,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      return { statusCode: res.status, body: JSON.stringify({ error: data.message || 'Resend error', detail: data }) };
    }
    return { statusCode: 200, body: JSON.stringify({ success: true, id: data.id }) };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
