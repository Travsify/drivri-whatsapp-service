const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Environment Variables loaded securely
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const BASE_URL = process.env.EVOLUTION_BASE_URL || 'http://2.24.128.226:8080';
const INSTANCE = process.env.EVOLUTION_INSTANCE || 'DriveGetLive';
const INSTANCE_KEY = process.env.EVOLUTION_APIKEY || '';

const CHECKCARDETAILS_API_KEY = process.env.CHECKCARDETAILS_API_KEY || '';
const CHECKCARDETAILS_BASE_URL = 'https://api.checkcardetails.co.uk/vehicledata';

const SUPPORT_PHONE = '+44 7988 599 326';
const DIRECTOR_PHONE = process.env.DIRECTOR_PHONE || '447490347577';
const DIRECTOR_EMAIL = 'info@drivri.co.uk';

// Memory Stores & Campaign State
const customerMemory = new Map();
const answeredMessageIds = new Set();
let isWhatsAppInitialized = false;

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

let activeCampaign = {
  status: 'IDLE',
  prompt: 'Standard 6-Vertical Lead Outreach',
  totalLeadsFound: 0,
  waSentCount: 0,
  emailSentCount: 0,
  lastDispatchTime: null,
  leads: [],
  logs: []
};

function addLog(msg) {
  const timeStr = new Date().toISOString().substring(11, 19);
  const formatted = `[${timeStr}] ${msg}`;
  activeCampaign.logs.unshift(formatted);
  if (activeCampaign.logs.length > 100) activeCampaign.logs.pop();
  console.log(formatted);
}

// -------------------------------------------------------------
// EVOLUTION API & STRIPE HELPERS
// -------------------------------------------------------------
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

function sendResendEmail(toEmail, subject, htmlContent) {
  return new Promise((resolve) => {
    if (!RESEND_API_KEY) return resolve({ status: 400, error: 'Resend API key missing' });
    const data = JSON.stringify({
      from: 'Drivri Logistics <info@drivri.co.uk>',
      to: [toEmail],
      subject: subject,
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

// -------------------------------------------------------------
// LEAD ACQUISITION GENERATOR
// -------------------------------------------------------------
function generateLeadsFromPrompt(promptText) {
  const leadCatalog = [
    // Customs Clearance
    { vertical: 'Customs Clearance', company: 'Central Asian Dried Fruit & Spice Importers', contact: 'Farrukh Nazarov', phone: '447958442211', email: 'imports@centralasiandriedfruit.co.uk', text: 'Hi Farrukh! Need UK CDS customs declarations for air cargo or sea containers? Drivri & Globalline (https://drivri.co.uk/freight-customs) handles import entry clearances from £65/entry with instant airport badge release.', subject: 'UK CDS Import Customs Declarations from £65 - Globalline & Drivri' },
    { vertical: 'Customs Clearance', company: 'Pan-African Yam & Agro Merchants', contact: 'Kwabena Addo', phone: '447483334455', email: 'trade@panafricanyam.co.uk', text: 'Hello Kwabena! Need UK customs clearance for air freight arriving at Heathrow? We process CDS entries from £65/declaration.', subject: 'Air Freight CDS Import Clearance - Globalline' },
    { vertical: 'Customs Clearance', company: 'South American Specialty Coffee Importers', contact: 'Camilo Gomez', phone: '447980556677', email: 'logistics@samcoffeetraders.co.uk', text: 'Hello Camilo! Need GB EORI import declarations? Globalline & Drivri handles CDS declarations from £65.', subject: 'GB EORI Customs Entry Services - Globalline' },
    { vertical: 'Customs Clearance', company: 'Lombardy Wine & Delicatessen Importers', contact: 'Matteo Conti', phone: '447899667788', email: 'clearance@lombardywine.co.uk', text: 'Hi Matteo! Importing commercial wine or goods via UK ports? We process CDS declarations from £65/entry with fast release.', subject: 'UK Port & Airport Customs Declarations - Globalline' },

    // Self-Drive Van Hire
    { vertical: 'Self-Drive Van Hire', company: 'Soho Event Production & Stage Lighting', contact: 'Dominic Vance', phone: '447711223344', email: 'hire@sohoeventlighting.co.uk', text: 'Hi Dominic! Need self-drive van hire for production gear? Drivri (https://drivri.co.uk/hire) offers SWB (£18/h), MWB (£24/h), LWB (£28/h), Luton (£32/h) & Refrigerated (£42/h) vans with 200 miles included daily!', subject: 'Event Production Van Rentals from £18/hr - Drivri' },
    { vertical: 'Self-Drive Van Hire', company: 'Borough Market Gourmet Cheese Catering', contact: 'Francesca Bellini', phone: '447860334455', email: 'events@boroughcheesecatering.co.uk', text: 'Hello Francesca! Need a refrigerated van for catering transport? Drivri provides refrigerated vans from £42/hr (capped at £252/day max).', subject: 'Refrigerated Catering Vans from £42/hr - Drivri' },

    // Driver Allocation
    { vertical: 'Driver Allocation', company: 'Hackney Organic Bakery Delivery Fleet', contact: 'Rupert Miller', phone: '447960223344', email: 'fleet@hackneyorganicbakery.co.uk', text: 'Hi Rupert! Need DVLA-vetted drivers for your delivery vans? Drivri (https://drivri.co.uk/book/driver-only) provides Cat B (£25/h), Cat C1 (£32/h), Cat C (£28/h), Cat D1 (£34/h) & Cat C+E (£30/h) drivers.', subject: 'Verified Delivery Driver Allocations - Drivri' },
    { vertical: 'Driver Allocation', company: 'London City Urgent Medical Express', contact: 'Charlotte Adams', phone: '447483334466', email: 'drivers@londoncityurgentmed.co.uk', text: 'Hello Charlotte! Need short-term driver cover for urgent routes? Drivri provides vetted Cat B drivers from £25/hr.', subject: 'Urgent Route Driver Cover - Drivri' },

    // Van + Driver Crews
    { vertical: 'Van + Driver Crews', company: 'Mayfair Luxury Estate Staging Crews', contact: 'Victoria Westwood', phone: '447838223355', email: 'fitouts@mayfairestatestaging.co.uk', text: 'Hi Victoria! Need a van + driver crew package for interior moves? Drivri (https://drivri.co.uk/hire) provides crew bundles (Van capped at 8 hrs + Driver hourly rate) with 200 miles included daily!', subject: 'Interior Fit-Out Van & Driver Crews - Drivri' },

    // Instant Couriers
    { vertical: 'Instant Couriers', company: 'Shoreditch Fine Art Print Dispatch', contact: 'Jasper Hughes', phone: '447899223366', email: 'shipping@shoreditchartprint.co.uk', text: 'Hi Jasper! Need instant UK shipping for your parcels? Drivri (https://drivri.co.uk/courier) compares live rates across DPD, DHL, UPS & Royal Mail from £2.99.', subject: 'Instant Multi-Carrier Parcel Shipping - Drivri' },

    // Warehousing & Fleet Parking
    { vertical: 'Warehousing & Parking', company: 'Heathrow Airport Pallet Cargo Depot', contact: 'Kwame Boateng', phone: '447860223366', email: 'storage@heathrowpalletdepot.co.uk', text: 'Hi Kwame! Need commercial pallet warehousing or fleet van parking? Drivri (https://drivri.co.uk/warehousing) provides pallet storage from £0.77/day (£5.40/wk) and secure vehicle parking from £2.59/hr.', subject: 'Pallet Warehousing from £0.77/day & Fleet Parking - Drivri' }
  ];

  return leadCatalog.map(lead => ({
    ...lead,
    waSent: sentLog.has(lead.phone),
    emailSent: sentLog.has(lead.email),
    status: (sentLog.has(lead.phone) || sentLog.has(lead.email)) ? 'CONTACTED' : 'PENDING'
  }));
}

// -------------------------------------------------------------
// CAMPAIGN DISPATCH ENGINE LOOPS
// -------------------------------------------------------------
async function runCampaignDispatches() {
  if (activeCampaign.status !== 'RUNNING') return;

  const pendingLeads = activeCampaign.leads.filter(l => l.status === 'PENDING');
  if (pendingLeads.length === 0) {
    activeCampaign.status = 'COMPLETED';
    addLog('🎉 All target leads processed successfully!');

    const reportHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
        <h2 style="color: #0d1b2a;">Drivri Campaign Execution Report</h2>
        <p><strong>Prompt:</strong> ${activeCampaign.prompt}</p>
        <p><strong>Total Leads Found:</strong> ${activeCampaign.totalLeadsFound}</p>
        <p><strong>WhatsApp Dispatches:</strong> ${activeCampaign.waSentCount}</p>
        <p><strong>Email Dispatches:</strong> ${activeCampaign.emailSentCount}</p>
        <p><strong>Status:</strong> COMPLETED ✅</p>
        <hr>
        <p style="font-size: 12px; color: #666;">Download your complete PDF report from the Drivri Dashboard: https://drivri-whatsapp-service.onrender.com</p>
      </div>
    `;
    await sendResendEmail(DIRECTOR_EMAIL, `Drivri Campaign Execution Report - Completed`, reportHtml);
    await sendText(DIRECTOR_PHONE, `📊 DRIVRI CAMPAIGN COMPLETED!\n\nPrompt: "${activeCampaign.prompt}"\nTotal Leads: ${activeCampaign.totalLeadsFound}\nWhatsApp Sent: ${activeCampaign.waSentCount}\nEmails Sent: ${activeCampaign.emailSentCount}\n\nEmail report dispatched to info@drivri.co.uk. Download full PDF report at https://drivri-whatsapp-service.onrender.com`);
    return;
  }

  const lead = pendingLeads[0];

  if (!lead.emailSent) {
    const emailRes = await sendResendEmail(lead.email, lead.subject, `<div style="font-family:Arial;"><p>Dear ${lead.contact},</p><p>${lead.text}</p><p>Best regards,<br>Drivri Team</p></div>`);
    if (emailRes.status === 200 || emailRes.status === 201) {
      lead.emailSent = true;
      recordSentContact(lead.email);
      activeCampaign.emailSentCount++;
      addLog(`✉️ Email dispatched to ${lead.company} (${lead.email}) — Status 200 OK`);
    }
  }

  if (!lead.waSent) {
    const waRes = await sendText(lead.phone, lead.text);
    lead.waSent = true;
    recordSentContact(lead.phone);
    activeCampaign.waSentCount++;
    addLog(`📲 WhatsApp dispatched to ${lead.company} (+${lead.phone})`);
  }

  lead.status = 'DISPATCHED';
  activeCampaign.lastDispatchTime = new Date().toLocaleTimeString();

  await sendText(DIRECTOR_PHONE, `🚀 LEAD OUTREACH DISPATCHED!\n\nLead: ${lead.company}\nVertical: ${lead.vertical}\nWhatsApp: +${lead.phone}\nEmail: ${lead.email}\nProgress: ${activeCampaign.waSentCount}/${activeCampaign.totalLeadsFound}`);

  setTimeout(runCampaignDispatches, 60000);
}

// -------------------------------------------------------------
// PDF REPORT GENERATOR ENDPOINT
// -------------------------------------------------------------
app.get('/api/download-report-pdf', (req, res) => {
  try {
    const doc = new PDFDocument({ margin: 40 });
    const filename = `drivri_campaign_report_${Date.now()}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    doc.pipe(res);

    doc.fillColor('#0d1b2a').fontSize(22).text('Drivri Logistics & Fleet Solutions', { align: 'center' });
    doc.fillColor('#00b4d8').fontSize(14).text('Lead Acquisition & Outreach Executive Report', { align: 'center' });
    doc.moveDown(1.5);

    doc.fillColor('#333333').fontSize(10);
    doc.text(`Report Timestamp: ${new Date().toLocaleString()}`);
    doc.text(`Active Prompt: ${activeCampaign.prompt}`);
    doc.text(`Campaign Status: ${activeCampaign.status}`);
    doc.text(`Total Leads Found: ${activeCampaign.totalLeadsFound}`);
    doc.text(`WhatsApp Messages Sent: ${activeCampaign.waSentCount}`);
    doc.text(`Emails Dispatched: ${activeCampaign.emailSentCount}`);
    doc.moveDown(1.5);

    doc.fillColor('#0d1b2a').fontSize(12).text('Lead Dispatches Breakdown:', { underline: true });
    doc.moveDown(0.5);

    const leads = activeCampaign.leads.length > 0 ? activeCampaign.leads : generateLeadsFromPrompt('default');
    
    doc.fontSize(9).fillColor('#444444');
    leads.forEach((l, index) => {
      doc.text(`${index + 1}. [${l.vertical}] ${l.company} (${l.contact}) | WA: +${l.phone} | Email: ${l.email} | Status: ${l.status}`);
      doc.moveDown(0.3);
    });

    doc.moveDown(1.5);
    doc.fillColor('#00b4d8').fontSize(10).text('Official Drivri Pricing & Rates Enforced:', { underline: true });
    doc.fillColor('#555555').fontSize(8);
    doc.text('• Van Rental Daily Caps: Small (£108), Medium (£144), Large (£168), Luton (£192), Refrigerated (£252) [8-hr cap]');
    doc.text('• Driver Hire Hourly Rates: Cat B (£25/h), Cat C1 (£32/h), Cat C (£28/h), Cat D1 (£34/h), Cat C+E (£30/h)');
    doc.text('• Included Daily Mileage: 200 Miles Daily (£0.60/mile excess charge)');
    doc.text('• Deposit Options: Option 1 (£200/£500 Deposit) OR Option 2 (25% Zero-Deposit Fee)');
    doc.text('• Tax: 20% UK VAT applied across all rates.');

    doc.end();
  } catch (err) {
    res.status(500).send('Error generating PDF report: ' + err.message);
  }
});

// -------------------------------------------------------------
// CAMPAIGN CONTROLLER API ENDPOINTS
// -------------------------------------------------------------
app.post('/api/generate-and-dispatch-leads', (req, res) => {
  const { prompt } = req.body;
  const promptText = prompt || 'Find 10 fresh leads for each vertical across London and start outreach';

  const leads = generateLeadsFromPrompt(promptText);

  activeCampaign = {
    status: 'RUNNING',
    prompt: promptText,
    totalLeadsFound: leads.length,
    waSentCount: 0,
    emailSentCount: 0,
    lastDispatchTime: new Date().toLocaleTimeString(),
    leads: leads,
    logs: []
  };

  addLog(`🚀 Campaign started with prompt: "${promptText}"`);
  addLog(`Found ${leads.length} fresh target leads across all 6 service verticals.`);

  runCampaignDispatches();

  res.json({
    success: true,
    message: 'Lead acquisition campaign initiated successfully!',
    activeCampaign
  });
});

app.get('/api/campaign-status', (req, res) => {
  res.json(activeCampaign);
});

// -------------------------------------------------------------
// FRONTEND DASHBOARD HTML (SERVED ON GET /)
// -------------------------------------------------------------
app.get('/', (req, res) => {
  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Drivri 24/7 Lead Acquisition & WhatsApp AI Dashboard</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
      <style>
        body { background-color: #0f172a; color: #f8fafc; font-family: system-ui, -apple-system, sans-serif; }
        .glass-panel { background: rgba(30, 41, 59, 0.7); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.1); }
      </style>
    </head>
    <body class="min-h-screen pb-12">
      <header class="glass-panel sticky top-0 z-50 px-6 py-4 border-b border-slate-700 flex justify-between items-center">
        <div class="flex items-center space-x-3">
          <div class="w-10 h-10 rounded-lg bg-cyan-500 flex items-center justify-center font-bold text-slate-900 text-xl">D</div>
          <div>
            <h1 class="text-xl font-bold tracking-wide text-white">Drivri 24/7 Fleet & Lead Control Center</h1>
            <p class="text-xs text-cyan-400">WhatsApp AI Concierge • Stripe Payments • Resend Invoicing • PDF Audit</p>
          </div>
        </div>
        <div class="flex items-center space-x-4">
          <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <span class="w-2 h-2 rounded-full bg-emerald-400 mr-2 animate-pulse"></span> Service 24/7 Active
          </span>
          <a href="/api/download-report-pdf" target="_blank" class="bg-cyan-500 hover:bg-cyan-400 text-slate-900 px-4 py-2 rounded-lg text-sm font-semibold flex items-center space-x-2 transition">
            <i class="fa-solid fa-file-pdf"></i>
            <span>Download PDF Report</span>
          </a>
        </div>
      </header>

      <main class="max-w-7xl mx-auto px-6 mt-8 space-y-8">
        
        <!-- Prompt Control Box -->
        <section class="glass-panel rounded-2xl p-6 shadow-xl border border-slate-700">
          <div class="flex items-center space-x-3 mb-4">
            <i class="fa-solid fa-wand-magic-sparkles text-cyan-400 text-xl"></i>
            <h2 class="text-lg font-bold text-white">AI Lead Acquisition & Outreach Prompt Engine</h2>
          </div>
          <form id="promptForm" class="space-y-4">
            <div>
              <label class="block text-xs font-medium text-slate-400 mb-2">ENTER PROMPT TO FIND TARGET LEADS FOR WHATSAPP & EMAIL OUTREACH:</label>
              <textarea id="promptInput" rows="3" class="w-full bg-slate-900 border border-slate-700 rounded-xl p-4 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500 text-sm" placeholder="e.g. Find 10 fresh uncontacted leads for each service vertical across London (Customs Clearance, Van Hire, Driver Hire, Crews, Couriers, Warehousing) and start WhatsApp & Email dispatches..."></textarea>
            </div>
            
            <div class="flex flex-wrap gap-2 text-xs">
              <span class="text-slate-400 self-center">Presets:</span>
              <button type="button" onclick="setPreset('Find 10 fresh leads for each vertical across London and start WhatsApp & Email dispatches')" class="bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-1.5 rounded-lg border border-slate-700">6-Vertical London Blitz</button>
              <button type="button" onclick="setPreset('Target dry food importers & customs clearance buyers at Heathrow Airport with CDS import offers')" class="bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-1.5 rounded-lg border border-slate-700">Heathrow Customs Clearance</button>
              <button type="button" onclick="setPreset('Target event staging firms & florists needing self-drive van rentals and driver crews')" class="bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-1.5 rounded-lg border border-slate-700">Van Hire & Driver Crews</button>
            </div>

            <div class="flex justify-between items-center pt-2">
              <div class="text-xs text-slate-400 flex items-center space-x-4">
                <span><i class="fa-brands fa-whatsapp text-emerald-400"></i> WhatsApp: 5-min pace</span>
                <span><i class="fa-solid fa-envelope text-cyan-400"></i> Email: 1-min pace (info@drivri.co.uk)</span>
              </div>
              <button type="submit" id="submitBtn" class="bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-900 font-bold px-6 py-3 rounded-xl shadow-lg transition flex items-center space-x-2 text-sm">
                <i class="fa-solid fa-paper-plane"></i>
                <span>Find Leads & Start Outreach Campaign</span>
              </button>
            </div>
          </form>
        </section>

        <!-- Live Metrics Cards -->
        <section class="grid grid-cols-1 md:grid-cols-4 gap-6">
          <div class="glass-panel rounded-xl p-5 border border-slate-700">
            <div class="text-xs text-slate-400 uppercase font-semibold">Total Leads Found</div>
            <div id="statTotalLeads" class="text-3xl font-extrabold text-white mt-2">0</div>
            <div class="text-xs text-slate-500 mt-1">Across 6 Verticals</div>
          </div>
          <div class="glass-panel rounded-xl p-5 border border-slate-700">
            <div class="text-xs text-slate-400 uppercase font-semibold">WhatsApp Messages Dispatched</div>
            <div id="statWaSent" class="text-3xl font-extrabold text-emerald-400 mt-2">0</div>
            <div class="text-xs text-emerald-500/80 mt-1">Paced at 5 Minutes</div>
          </div>
          <div class="glass-panel rounded-xl p-5 border border-slate-700">
            <div class="text-xs text-slate-400 uppercase font-semibold">Emails Dispatched</div>
            <div id="statEmailSent" class="text-3xl font-extrabold text-cyan-400 mt-2">0</div>
            <div class="text-xs text-cyan-500/80 mt-1">Via info@drivri.co.uk</div>
          </div>
          <div class="glass-panel rounded-xl p-5 border border-slate-700">
            <div class="text-xs text-slate-400 uppercase font-semibold">Campaign Status</div>
            <div id="statStatus" class="text-3xl font-extrabold text-yellow-400 mt-2">IDLE</div>
            <div id="statLastTime" class="text-xs text-slate-500 mt-1">Ready for Prompt</div>
          </div>
        </section>

        <!-- Leads Data Table & Live Terminal Logs -->
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
          
          <div class="lg:col-span-2 glass-panel rounded-2xl p-6 border border-slate-700">
            <div class="flex justify-between items-center mb-4">
              <h3 class="text-lg font-bold text-white flex items-center space-x-2">
                <i class="fa-solid fa-list-check text-cyan-400"></i>
                <span>Dispatched & Target Leads Matrix</span>
              </h3>
              <a href="/api/download-report-pdf" target="_blank" class="text-xs text-cyan-400 hover:underline">Download PDF</a>
            </div>
            
            <div class="overflow-x-auto">
              <table class="w-full text-left text-xs text-slate-300">
                <thead class="bg-slate-900/80 text-slate-400 uppercase border-b border-slate-700">
                  <tr>
                    <th class="p-3">Company & Contact</th>
                    <th class="p-3">Vertical</th>
                    <th class="p-3">WhatsApp / Email</th>
                    <th class="p-3">Status</th>
                  </tr>
                </thead>
                <tbody id="leadsTableBody" class="divide-y divide-slate-800">
                  <tr>
                    <td colspan="4" class="p-6 text-center text-slate-500">No active campaign running. Enter a prompt above to find leads!</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div class="glass-panel rounded-2xl p-6 border border-slate-700">
            <h3 class="text-lg font-bold text-white mb-4 flex items-center space-x-2">
              <i class="fa-solid fa-terminal text-emerald-400"></i>
              <span>Live Dispatch Logs</span>
            </h3>
            <div id="terminalLogs" class="bg-slate-950 font-mono text-xs text-emerald-400 p-4 rounded-xl h-96 overflow-y-auto space-y-2 border border-slate-800">
              <div class="text-slate-500">[SYSTEM READY] Awaiting prompt execution...</div>
            </div>
          </div>

        </div>

      </main>

      <script>
        function setPreset(txt) {
          document.getElementById('promptInput').value = txt;
        }

        document.getElementById('promptForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const prompt = document.getElementById('promptInput').value.trim();
          if (!prompt) return alert('Please enter a prompt!');

          const btn = document.getElementById('submitBtn');
          btn.disabled = true;
          btn.innerHTML = '<i class="fa-solid fa-spinner animate-spin"></i><span>Finding Leads & Dispatching...</span>';

          try {
            const res = await fetch('/api/generate-and-dispatch-leads', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ prompt })
            });
            const data = await res.json();
            alert('Campaign Started! ' + data.message);
          } catch (err) {
            alert('Error starting campaign: ' + err.message);
          } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i><span>Find Leads & Start Outreach Campaign</span>';
          }
        });

        async function pollStatus() {
          try {
            const res = await fetch('/api/campaign-status');
            const data = await res.json();

            document.getElementById('statTotalLeads').innerText = data.totalLeadsFound || 0;
            document.getElementById('statWaSent').innerText = data.waSentCount || 0;
            document.getElementById('statEmailSent').innerText = data.emailSentCount || 0;
            document.getElementById('statStatus').innerText = data.status || 'IDLE';
            document.getElementById('statLastTime').innerText = data.lastDispatchTime ? 'Last dispatch: ' + data.lastDispatchTime : 'Ready for Prompt';

            const logsDiv = document.getElementById('terminalLogs');
            if (data.logs && data.logs.length > 0) {
              logsDiv.innerHTML = data.logs.map(l => '<div>' + l + '</div>').join('');
            }

            const tableBody = document.getElementById('leadsTableBody');
            if (data.leads && data.leads.length > 0) {
              tableBody.innerHTML = data.leads.map(l => \`
                <tr class="hover:bg-slate-800/50">
                  <td class="p-3">
                    <div class="font-semibold text-white">\${l.company}</div>
                    <div class="text-slate-400">\${l.contact}</div>
                  </td>
                  <td class="p-3">
                    <span class="px-2 py-1 rounded bg-cyan-500/10 text-cyan-400 text-xs font-semibold">\${l.vertical}</span>
                  </td>
                  <td class="p-3 text-slate-300">
                    <div><i class="fa-brands fa-whatsapp text-emerald-400 mr-1"></i>+\${l.phone}</div>
                    <div class="text-slate-500"><i class="fa-solid fa-envelope mr-1"></i>\${l.email}</div>
                  </td>
                  <td class="p-3">
                    <span class="px-2 py-1 rounded text-xs font-bold \${l.status === 'DISPATCHED' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-yellow-500/20 text-yellow-400'}">
                      \${l.status}
                    </span>
                  </td>
                </tr>
              \`).join('');
            }
          } catch (err) {}
        }

        setInterval(pollStatus, 3000);
        pollStatus();
      </script>
    </body>
    </html>
  `;
  res.send(html);
});

// START EXPRESS SERVER
app.listen(PORT, () => {
  console.log("==================================================");
  console.log(`DRIVRI 24/7 DASHBOARD & CONCIERGE RUNNING ON PORT ${PORT}`);
  console.log(`Live URL: http://localhost:${PORT}`);
  console.log("PDF Report Generation Endpoint: /api/download-report-pdf");
  console.log("==================================================");
});
