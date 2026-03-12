const express = require('express');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');
const { Resend } = require('resend');

const app = express();

const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET || '';
const PADDLE_API_KEY = process.env.PADDLE_API_KEY || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const PORT = parseInt(process.env.LICENSE_PORT, 10) || 4100;
const MAX_ACTIVATIONS = 2;
const FROM_EMAIL = 'PicTinder <license@pictinder.com>';
const DOWNLOAD_URL_MAC = 'https://pictinder.com/downloads/PicTinder.dmg';
const DOWNLOAD_URL_WIN = 'https://pictinder.com/downloads/PicTinder-Setup.exe';

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const db = new Database(path.join(__dirname, 'licenses.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS licenses (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    license_key   TEXT    UNIQUE NOT NULL,
    email         TEXT    NOT NULL,
    transaction_id TEXT   UNIQUE NOT NULL,
    product_id    TEXT,
    created_at    TEXT    DEFAULT (datetime('now')),
    status        TEXT    DEFAULT 'active'
  );
  CREATE TABLE IF NOT EXISTS activations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    license_id    INTEGER NOT NULL,
    machine_id    TEXT    NOT NULL,
    activated_at  TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (license_id) REFERENCES licenses(id),
    UNIQUE(license_id, machine_id)
  );
`);

const stmts = {
  findByTxn:       db.prepare('SELECT * FROM licenses WHERE transaction_id = ?'),
  findByEmail:     db.prepare("SELECT * FROM licenses WHERE LOWER(email) = LOWER(?) AND status = 'active' ORDER BY created_at DESC LIMIT 1"),
  findByKey:       db.prepare('SELECT * FROM licenses WHERE license_key = ? AND LOWER(email) = LOWER(?) AND status = ?'),
  findByKeyAny:    db.prepare('SELECT * FROM licenses WHERE license_key = ? AND LOWER(email) = LOWER(?)'),
  insertLicense:   db.prepare('INSERT INTO licenses (license_key, email, transaction_id, product_id) VALUES (?, ?, ?, ?)'),
  getActivations:  db.prepare('SELECT * FROM activations WHERE license_id = ?'),
  findActivation:  db.prepare('SELECT * FROM activations WHERE license_id = ? AND machine_id = ?'),
  insertActivation: db.prepare('INSERT INTO activations (license_id, machine_id) VALUES (?, ?)'),
  deleteActivation: db.prepare('DELETE FROM activations WHERE license_id = ? AND machine_id = ?'),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateLicenseKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const segments = [];
  for (let i = 0; i < 4; i++) {
    let seg = '';
    const bytes = crypto.randomBytes(4);
    for (let j = 0; j < 4; j++) seg += chars[bytes[j] % chars.length];
    segments.push(seg);
  }
  return segments.join('-');
}

function verifyPaddleSignature(rawBody, signatureHeader) {
  if (!PADDLE_WEBHOOK_SECRET) return true;
  try {
    const parts = {};
    signatureHeader.split(';').forEach((p) => {
      const idx = p.indexOf('=');
      if (idx > -1) parts[p.slice(0, idx)] = p.slice(idx + 1);
    });
    const ts = parts.ts;
    const h1 = parts.h1;
    if (!ts || !h1) return false;
    const payload = `${ts}:${rawBody}`;
    const expected = crypto.createHmac('sha256', PADDLE_WEBHOOK_SECRET).update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(h1, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

function extractEmail(txnData) {
  return (
    txnData.customer?.email ||
    txnData.billing_details?.email ||
    txnData.checkout?.customer_email ||
    ''
  );
}

async function fetchCustomerEmail(customerId) {
  if (!PADDLE_API_KEY || !customerId) return '';
  try {
    const res = await fetch(`https://api.paddle.com/customers/${customerId}`, {
      headers: { Authorization: `Bearer ${PADDLE_API_KEY}` },
    });
    if (!res.ok) {
      console.error(`[paddle-api] Failed to fetch customer ${customerId}: ${res.status}`);
      return '';
    }
    const json = await res.json();
    return json.data?.email || '';
  } catch (err) {
    console.error(`[paddle-api] Error fetching customer ${customerId}:`, err.message);
    return '';
  }
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

async function sendLicenseEmail(email, licenseKey) {
  if (!resend) {
    console.warn('[email] RESEND_API_KEY not set — skipping email delivery');
    return;
  }
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: 'Your PicTinder Pro License Key',
      html: buildLicenseEmailHtml(email, licenseKey),
    });
    console.log(`[email] License email sent to ${email}`);
  } catch (err) {
    console.error(`[email] Failed to send to ${email}:`, err.message || err);
  }
}

function buildLicenseEmailHtml(email, licenseKey) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);">
        <!-- Header -->
        <tr>
          <td style="background:#1d1d1f;padding:28px 32px;text-align:center;">
            <h1 style="margin:0;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.02em;">PicTinder</h1>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px;">
            <h2 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#1d1d1f;">Thank you for your purchase!</h2>
            <p style="margin:0 0 24px;font-size:15px;color:#6e6e73;line-height:1.5;">Your PicTinder Pro license is ready. Here are your activation details — keep this email safe.</p>

            <!-- License key box -->
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7;border:1px solid #e8e8ed;border-radius:12px;margin-bottom:24px;">
              <tr><td style="padding:20px 24px;">
                <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#86868b;margin-bottom:6px;">License Key</div>
                <div style="font-size:24px;font-weight:700;font-family:'SF Mono',Menlo,Monaco,Consolas,monospace;letter-spacing:0.06em;color:#1d1d1f;">${licenseKey}</div>
                <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#86868b;margin-top:16px;margin-bottom:4px;">Registered Email</div>
                <div style="font-size:14px;color:#1d1d1f;">${email}</div>
              </td></tr>
            </table>

            <!-- Steps -->
            <h3 style="margin:0 0 12px;font-size:15px;font-weight:600;color:#1d1d1f;">How to activate</h3>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:6px 0;vertical-align:top;width:28px;">
                  <div style="width:22px;height:22px;background:#0071e3;color:#fff;border-radius:50%;font-size:12px;font-weight:700;text-align:center;line-height:22px;">1</div>
                </td>
                <td style="padding:6px 0 6px 8px;font-size:14px;color:#444;line-height:1.4;">Download PicTinder for your platform using the buttons below</td>
              </tr>
              <tr>
                <td style="padding:6px 0;vertical-align:top;width:28px;">
                  <div style="width:22px;height:22px;background:#0071e3;color:#fff;border-radius:50%;font-size:12px;font-weight:700;text-align:center;line-height:22px;">2</div>
                </td>
                <td style="padding:6px 0 6px 8px;font-size:14px;color:#444;line-height:1.4;">Open the app &mdash; you'll see an activation screen</td>
              </tr>
              <tr>
                <td style="padding:6px 0;vertical-align:top;width:28px;">
                  <div style="width:22px;height:22px;background:#0071e3;color:#fff;border-radius:50%;font-size:12px;font-weight:700;text-align:center;line-height:22px;">3</div>
                </td>
                <td style="padding:6px 0 6px 8px;font-size:14px;color:#444;line-height:1.4;">Enter your email and the license key above to unlock</td>
              </tr>
            </table>

            <!-- Download buttons -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;">
              <tr><td align="center" style="padding-bottom:10px;">
                <a href="${DOWNLOAD_URL_MAC}" style="display:inline-block;background:#0071e3;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:10px;">Download for macOS</a>
              </td></tr>
              <tr><td align="center">
                <a href="${DOWNLOAD_URL_WIN}" style="display:inline-block;background:#1d1d1f;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:10px;">Download for Windows</a>
              </td></tr>
            </table>

            <p style="margin:24px 0 0;font-size:12px;color:#86868b;line-height:1.5;">Your license works on up to 2 computers (Mac or PC). If you need to move it to a new machine, deactivate the old one first from the app settings.</p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:20px 32px;background:#fafafa;border-top:1px solid #e8e8ed;">
            <p style="margin:0;font-size:12px;color:#86868b;text-align:center;line-height:1.5;">
              Need help? Reply to this email or contact <a href="mailto:admin@pictinder.com" style="color:#0071e3;text-decoration:none;">admin@pictinder.com</a><br>
              <a href="https://pictinder.com/recover.html" style="color:#0071e3;text-decoration:none;">Recover your license key</a> &middot;
              <a href="https://pictinder.com/refund.html" style="color:#0071e3;text-decoration:none;">Refund policy</a>
            </p>
            <p style="margin:12px 0 0;font-size:11px;color:#aeaeb2;text-align:center;">&copy; 2026 Natural Inc. All rights reserved.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Middleware — raw body for webhook, JSON for everything else
// ---------------------------------------------------------------------------

app.post('/paddle-webhook', express.raw({ type: '*/*' }));
app.use(express.json());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Paddle webhook — creates licenses on successful transactions
app.post('/paddle-webhook', async (req, res) => {
  const rawBody = req.body.toString('utf-8');
  const sig = req.headers['paddle-signature'];

  if (sig && !verifyPaddleSignature(rawBody, sig)) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  let event;
  try { event = JSON.parse(rawBody); } catch { return res.status(400).json({ error: 'Bad JSON' }); }

  if (event.event_type === 'transaction.completed') {
    const txn = event.data;
    const transactionId = txn.id;
    let email = extractEmail(txn);
    const productId = txn.items?.[0]?.price?.product_id || '';

    if (!email && txn.customer_id) {
      email = await fetchCustomerEmail(txn.customer_id);
    }

    if (!stmts.findByTxn.get(transactionId)) {
      const key = generateLicenseKey();
      stmts.insertLicense.run(key, email, transactionId, productId);
      console.log(`[license] Created ${key} for ${email} (txn ${transactionId})`);

      if (email) {
        sendLicenseEmail(email, key).catch((err) => {
          console.error('[email] Async send failed:', err);
        });
      }
    }
  }

  res.json({ ok: true });
});

// Lookup license by Paddle transaction ID (used by success page after checkout)
app.get('/license/by-transaction/:txnId', (req, res) => {
  const row = stmts.findByTxn.get(req.params.txnId);
  if (!row) return res.status(404).json({ error: 'not_ready' });
  res.json({ licenseKey: row.license_key, email: row.email, status: row.status });
});

// Activate — registers a machine against a license (called from the Electron app)
app.post('/license/activate', (req, res) => {
  const { email, licenseKey, machineId } = req.body || {};
  if (!email || !licenseKey || !machineId) {
    return res.status(400).json({ valid: false, error: 'Missing email, licenseKey, or machineId' });
  }

  const license = stmts.findByKey.get(licenseKey.toUpperCase().trim(), email.trim(), 'active');
  if (!license) {
    return res.status(401).json({ valid: false, error: 'Invalid license key or email address' });
  }

  const existing = stmts.findActivation.get(license.id, machineId);
  if (existing) {
    return res.json({ valid: true, message: 'Already activated on this machine' });
  }

  const activations = stmts.getActivations.all(license.id);
  if (activations.length >= MAX_ACTIVATIONS) {
    return res.status(403).json({
      valid: false,
      error: `License already activated on ${MAX_ACTIVATIONS} machines. Deactivate one first.`,
      activationCount: activations.length,
      maxActivations: MAX_ACTIVATIONS,
    });
  }

  stmts.insertActivation.run(license.id, machineId);
  console.log(`[license] Activated ${licenseKey} on machine ${machineId.slice(0, 8)}…`);
  res.json({ valid: true, message: 'License activated successfully' });
});

// Verify — lightweight check that a license + machine is valid (periodic app check)
app.post('/license/verify', (req, res) => {
  const { email, licenseKey, machineId } = req.body || {};
  if (!email || !licenseKey || !machineId) {
    return res.status(400).json({ valid: false });
  }

  const license = stmts.findByKey.get(licenseKey.toUpperCase().trim(), email.trim(), 'active');
  if (!license) return res.status(401).json({ valid: false, error: 'Invalid or revoked license' });

  const activation = stmts.findActivation.get(license.id, machineId);
  if (!activation) return res.status(401).json({ valid: false, error: 'Not activated on this machine' });

  res.json({ valid: true });
});

// Deactivate — removes a machine so the seat can be used elsewhere
app.post('/license/deactivate', (req, res) => {
  const { email, licenseKey, machineId } = req.body || {};
  if (!email || !licenseKey || !machineId) {
    return res.status(400).json({ ok: false });
  }

  const license = stmts.findByKeyAny.get(licenseKey.toUpperCase().trim(), email.trim());
  if (!license) return res.status(401).json({ ok: false, error: 'Invalid license' });

  stmts.deleteActivation.run(license.id, machineId);
  res.json({ ok: true, message: 'Machine deactivated' });
});

// Recover — look up license by email (for the website recovery page)
app.get('/license/recover', (req, res) => {
  const email = (req.query.email || '').trim();
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const row = stmts.findByEmail.get(email.toLowerCase());
  if (!row) return res.status(404).json({ error: 'No license found for this email' });

  res.json({ licenseKey: row.license_key, email: row.email, status: row.status });
});

// Health check
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, '127.0.0.1', () => {
  console.log(`PicTinder license server listening on 127.0.0.1:${PORT}`);
  if (resend) console.log('[email] Resend configured — license emails enabled');
  else console.warn('[email] RESEND_API_KEY not set — license emails disabled');
});
