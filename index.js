const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Live API Keys & Credentials loaded securely via Environment Variables
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';

// Evolution API Configuration
const BASE_URL = process.env.EVOLUTION_BASE_URL || 'http://2.24.128.226:8080';
const INSTANCE = process.env.EVOLUTION_INSTANCE || 'DriveGetLive';
const INSTANCE_KEY = process.env.EVOLUTION_APIKEY || '';

// CheckCarDetails API Config
const CHECKCARDETAILS_API_KEY = process.env.CHECKCARDETAILS_API_KEY || '8e84326912c0f579f11bf3ec21edf08d';
const CHECKCARDETAILS_BASE_URL = 'https://api.checkcardetails.co.uk/vehicledata';

// Primary Lines
const SUPPORT_PHONE = '+44 7988 599 326';
const DIRECTOR_PHONE = process.env.DIRECTOR_PHONE || '447490347577';

// Memory Stores
const customerMemory = new Map();
const answeredMessageIds = new Set();
let isWhatsAppInitialized = false;

// Persistent Sent History Log
const SENT_LOG_FILE = path.join(__dirname, 'sent_leads_log.json');
let sentLog = new Set();

if (fs.existsSync(SENT_LOG_FILE)) {
  try {
    const raw = fs.readFileSync(SENT_LOG_FILE, 'utf8');
    sentLog = new Set(JSON.parse(raw));
  } catch (e) {
    sentLog = new Set();
  }
}

function recordSentContact(key) {
  sentLog.add(key);
  try {
    fs.writeFileSync(SENT_LOG_FILE, JSON.stringify(Array.from(sentLog), null, 2));
  } catch (e) {}
}

// -------------------------------------------------------------
// OFFICIAL DRIVRI PRICING TABLES
// -------------------------------------------------------------
const PRICING_VAN_RENTAL = {
  small: { name: 'Small Van (SWB)', hourly: 18, dailyCap8h: 108 },
  medium: { name: 'Medium Van (MWB)', hourly: 24, dailyCap8h: 144 },
  large: { name: 'Large Van (LWB)', hourly: 28, dailyCap8h: 168 },
  luton: { name: 'Luton Van', hourly: 32, dailyCap8h: 192 },
  refrigerated: { name: 'Refrigerated Van', hourly: 42, dailyCap8h: 252 }
};

const PRICING_DRIVER_HIRE = {
  B: { name: 'Category B (Standard Car / Small Van up to 3.5t)', hourly: 25 },
  C1: { name: 'Category C1 (Medium Goods 3.5t–7.5t)', hourly: 32 },
  C: { name: 'Category C (Large Goods over 7.5t)', hourly: 28 },
  D1: { name: 'Category D1 (Minibus)', hourly: 34 },
  'C+E': { name: 'Category C+E (LGV with Trailer)', hourly: 30 }
};

const INSURANCE_PRODUCTS = {
  goods_in_transit: { name: 'Goods in Transit (£10m cover)', hourly: 2.50, dailyCap: 20 },
  hire_reward: { name: 'Hire & Reward (Paid Courier Work)', hourly: 3.00, dailyCap: 25 },
  public_liability: { name: 'Public Liability (£5m cover)', hourly: 1.50, dailyCap: 12 },
  comprehensive_hire: { name: 'Comprehensive Self-Drive Cover', hourly: 3.50, dailyCap: 28 },
  personal_effects: { name: 'Personal Effects Cover (£25,000)', hourly: 1.20, dailyCap: 9 }
};

// -------------------------------------------------------------
// HTTP HEALTH CHECK ENDPOINTS FOR RENDER.COM
// -------------------------------------------------------------
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'online',
    service: 'Drivri 24/7 WhatsApp AI Concierge & Outbound Lead Engine',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', healthy: true });
});

// EVOLUTION API REQUEST HELPER
function requestEvolution(urlPath, method = 'POST', data = {}) {
  return new Promise((resolve) => {
    try {
      const url = new URL(urlPath, BASE_URL);
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: method,
        timeout: 10000,
        headers: {
          'apikey': INSTANCE_KEY,
          'Content-Type': 'application/json'
        }
      };

      if (data) {
        options.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(data));
      }

      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(body) });
          } catch (e) {
            resolve({ status: res.statusCode, body: body });
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ status: 504, body: {} });
      });

      req.on('error', err => resolve({ status: 500, error: err.message }));
      if (data) req.write(JSON.stringify(data));
      req.end();
    } catch (err) {
      resolve({ status: 500, error: err.message });
    }
  });
}

function sendText(targetJid, text) {
  return requestEvolution(`/message/sendText/${INSTANCE}`, 'POST', {
    number: targetJid,
    text: text
  });
}

// STRIPE CHECKOUT SESSION GENERATOR
function createStripeCheckoutSession(serviceName, amountPence, customerEmail, customerName, description = null) {
  return new Promise((resolve) => {
    if (!STRIPE_SECRET_KEY) {
      return resolve({ success: false, error: 'Stripe secret key missing' });
    }
    const postData = querystring.stringify({
      'mode': 'payment',
      'payment_method_types[0]': 'card',
      'line_items[0][price_data][currency]': 'gbp',
      'line_items[0][price_data][unit_amount]': Math.round(amountPence),
      'line_items[0][price_data][product_data][name]': serviceName,
      'line_items[0][price_data][product_data][description]': description || `Drivri Logistics Reservation for ${customerName || 'Valued Customer'} (Includes 20% UK VAT)`,
      'line_items[0][quantity]': '1',
      'customer_email': (customerEmail && customerEmail.includes('@')) ? customerEmail : undefined,
      'success_url': 'https://drivri.co.uk/booking-success?session_id={CHECKOUT_SESSION_ID}',
      'cancel_url': 'https://drivri.co.uk/booking-cancel'
    });

    const options = {
      hostname: 'api.stripe.com',
      port: 443,
      path: '/v1/checkout/sessions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode === 200 && parsed.url) {
            resolve({ success: true, url: parsed.url, sessionId: parsed.id });
          } else {
            resolve({ success: false, error: parsed.error ? parsed.error.message : body });
          }
        } catch (e) {
          resolve({ success: false, error: e.message });
        }
      });
    });

    req.on('error', err => resolve({ success: false, error: err.message }));
    req.write(postData);
    req.end();
  });
}

// RESEND API EMAIL DISPATCHER
function sendBookingConfirmationEmail(customerEmail, customerName, serviceName, bookingDetails, financialBreakdown, complyCubeStatus = null, stripePaymentUrl = null, stripeZeroDepositUrl = null) {
  return new Promise((resolve) => {
    if (!RESEND_API_KEY) {
      return resolve({ status: 400, error: 'Resend API key missing' });
    }
    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; background-color: #ffffff;">
        <div style="background-color: #0d1b2a; color: #ffffff; padding: 24px; text-align: center;">
          <h1 style="margin: 0; font-size: 24px;">Drivri Logistics & Fleet Solutions</h1>
          <p style="margin: 4px 0 0 0; color: #00b4d8; font-size: 14px;">Official Invoice & Reservation Summary</p>
        </div>
        <div style="padding: 24px; color: #333333; line-height: 1.6;">
          <p>Dear <strong>${customerName}</strong>,</p>
          <p>Thank you for choosing Drivri! Your reservation request for <strong>${serviceName}</strong> has been processed by our automated dispatch desk.</p>
          
          <div style="background-color: #f8f9fa; border-left: 4px solid #00b4d8; padding: 16px; margin: 20px 0; border-radius: 4px;">
            <h3 style="margin-top: 0; color: #0d1b2a;">Customer & Booking Telemetry</h3>
            <p style="margin: 4px 0;"><strong>Customer Name:</strong> ${customerName}</p>
            <p style="margin: 4px 0;"><strong>Email Address:</strong> ${customerEmail}</p>
            <p style="margin: 4px 0;"><strong>Service Reserved:</strong> ${serviceName}</p>
            <p style="margin: 4px 0;"><strong>Reservation Details:</strong> ${bookingDetails}</p>
            <p style="margin: 4px 0; color: #0288d1;"><strong>Included Daily Mileage:</strong> 200 Miles included daily (£0.60/mile on excess miles)</p>
            ${complyCubeStatus ? `<p style="margin: 4px 0; color: #1976d2;"><strong>Identity & DVLA Check:</strong> ${complyCubeStatus}</p>` : ''}
            <p style="margin: 4px 0; color: #d90429;"><strong>Booking Terms:</strong> Van daily rate is capped at 8 hours max. Driver hourly rate applies continuously for all hours worked.</p>
          </div>

          <div style="background-color: #ffffff; border: 1px solid #e0e0e0; padding: 16px; margin: 20px 0; border-radius: 4px;">
            <h3 style="margin-top: 0; color: #0d1b2a;">Itemized Financial & Tax Breakdown</h3>
            <p style="margin: 4px 0;"><strong>Rental & Driver Subtotal:</strong> ${financialBreakdown.subtotal}</p>
            <p style="margin: 4px 0;"><strong>Selected Insurance Product:</strong> ${financialBreakdown.insurance}</p>
            <p style="margin: 4px 0;"><strong>UK VAT (20%):</strong> ${financialBreakdown.vat}</p>
            <hr style="border: 0; border-top: 1px solid #eeeeee; margin: 12px 0;">
            ${financialBreakdown.depositPolicy ? `<p style="margin: 4px 0;"><strong>Option 1 (Standard Refundable Security Deposit):</strong> ${financialBreakdown.depositPolicy}</p>` : ''}
            ${financialBreakdown.zeroDepositPolicy ? `<p style="margin: 4px 0;"><strong>Option 2 (Zero Security Deposit Option):</strong> ${financialBreakdown.zeroDepositPolicy}</p>` : ''}
            <p style="margin: 8px 0 0 0; font-size: 16px; color: #0d1b2a;"><strong>Net Payable Total:</strong> <strong>${financialBreakdown.totalAmount || 'As Quoted'}</strong></p>
          </div>

          ${stripePaymentUrl ? `
          <div style="text-align: center; margin: 30px 0;">
            <a href="${stripePaymentUrl}" style="background-color: #00b4d8; color: #ffffff; padding: 16px 28px; font-size: 15px; font-weight: bold; text-decoration: none; border-radius: 6px; display: inline-block; margin-bottom: 12px;">💳 Option 1: Pay Rental + Standard Refundable Deposit</a>
            ${stripeZeroDepositUrl ? `<br><a href="${stripeZeroDepositUrl}" style="background-color: #1976d2; color: #ffffff; padding: 14px 24px; font-size: 14px; font-weight: bold; text-decoration: none; border-radius: 6px; display: inline-block;">🛡️ Option 2: Pay Rental + 25% Zero-Deposit Waiver Fee</a>` : ''}
            <p style="font-size: 12px; color: #666666; margin-top: 8px;">Supports Credit/Debit Cards, Apple Pay & Google Pay (256-bit SSL Encrypted)</p>
          </div>
          ` : ''}

          <div style="background-color: #e3f2fd; border-left: 4px solid #1976d2; padding: 16px; margin: 20px 0;">
            <h4 style="margin: 0 0 8px 0; color: #0d47a1;">Driver & Vehicle Regulations</h4>
            <p style="margin: 0; font-size: 13px;">• All self-drive hirers must complete ComplyCube ID & DVLA Check.<br>• Daily van rental includes 200 miles allowance (£0.60/mile excess charge).<br>• Driver hourly rate continues to apply for all hours worked exceeding 8 hours.<br>• All prices are subject to 20% UK VAT under Road Transport Laws.</p>
          </div>

          <div style="font-size: 12px; color: #666666; border-top: 1px solid #eeeeee; padding-top: 16px; margin-top: 24px;">
            <p style="margin: 4px 0;">Drivri Logistics Limited | Website: <a href="https://drivri.co.uk" style="color: #00b4d8;">drivri.co.uk</a> | 24/7 Support Line: ${SUPPORT_PHONE}</p>
          </div>
        </div>
      </div>
    `;

    const data = JSON.stringify({
      from: 'Drivri Logistics <info@drivri.co.uk>',
      to: [customerEmail],
      subject: `Drivri Booking Invoice & Payment Link - ${serviceName}`,
      html: htmlContent
    });

    const req = https.request({
      hostname: 'api.resend.com',
      port: 443,
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });

    req.on('error', (e) => resolve({ status: 500, error: e.message }));
    req.write(data);
    req.end();
  });
}

// INBOUND POLLING LOOP WITH SILENT RETRY
async function pollInboundMessages() {
  try {
    const res = await requestEvolution(`/chat/findMessages/${INSTANCE}`, 'POST', { page: 1, limit: 15 });
    if (res.status !== 200 || !res.body || !res.body.messages || !Array.isArray(res.body.messages.records)) return;

    const records = res.body.messages.records;

    if (!isWhatsAppInitialized) {
      for (const r of records) {
        if (r.key && r.key.id) answeredMessageIds.add(r.key.id);
      }
      isWhatsAppInitialized = true;
      console.log(`[HUMAN AI CONCIERGE INITIALIZED] Listening for customer chats 24/7...`);
      return;
    }

    for (const record of records) {
      if (!record.key || record.key.fromMe) continue;

      const msgId = record.key.id;
      if (answeredMessageIds.has(msgId)) continue;
      
      answeredMessageIds.add(msgId);

      const targetJid = record.key.remoteJid || record.key.remoteJidAlt || '';
      if (!targetJid || targetJid.includes('@g.us')) continue;

      let incomingText = record.message?.conversation || record.message?.extendedTextMessage?.text || 'Hello';
      console.log(`[INCOMING MESSAGE] JID: ${targetJid} | Text: "${incomingText}"`);

      // Natural Human Greeting Response
      await sendText(targetJid, `Hello! Welcome to Drivri Logistics. I'm your 24/7 Concierge. How can I assist you today with Van Hire, Drivers, Couriers, Warehousing, or Customs Clearance?`);
    }
  } catch (err) {
    // Silent handling for socket timeouts
  }
}

// Start Background Loop & Listen on Port
app.listen(PORT, () => {
  console.log("==================================================");
  console.log(`DRIVRI 24/7 SERVICE SERVER RUNNING ON PORT ${PORT}`);
  console.log(`Health Check: GET http://localhost:${PORT}/health`);
  console.log("Stripe Payments & Resend Email Auto-Invoicing Active");
  console.log("==================================================");

  setInterval(pollInboundMessages, 4000);
});
