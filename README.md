# 🚀 Drivri 24/7 WhatsApp AI Concierge & Lead Engine — Render Deployment Guide

This standalone Node.js web service hosts the **Drivri 24/7 WhatsApp AI Concierge**, **Stripe Payment Link Generator**, **Resend API HTML Invoice Dispatcher**, and **Outbound Lead Engine**. 

By deploying this service to [Render.com](https://render.com), your WhatsApp Concierge and lead acquisition will stay online **24 hours a day, 7 days a week**, even when your personal computer is turned off!

---

## 🛠️ Step-by-Step Deployment Instructions:

### Option A: Direct Render Web Service Deployment

1. **Push to GitHub:**
   Commit and push this repository to your GitHub account:
   ```bash
   git add .
   git commit -m "Update service for Render deployment"
   git push origin main
   ```

2. **Log in to Render.com:**
   Go to [https://dashboard.render.com](https://dashboard.render.com) and log in (or create a free account).

3. **Create a New Web Service:**
   - Click **New +** -> Select **Web Service**.
   - Connect your GitHub repository `Travsify/drivri-whatsapp-service`.
   - Environment: `Node`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Health Check Path: `/health`

4. **Configure Environment Variables:**
   Under **Environment Variables**, add the following keys:
   - `PORT`: `10000`
   - `STRIPE_SECRET_KEY`: *(Your Stripe Live Secret Key)*
   - `RESEND_API_KEY`: *(Your Resend API Key)*
   - `EVOLUTION_BASE_URL`: `http://2.24.128.226:8080`
   - `EVOLUTION_INSTANCE`: `DriveGetLive`
   - `EVOLUTION_APIKEY`: `DC905640-4263-4DFA-9959-26B47F5425D0`
   - `DIRECTOR_PHONE`: `447490347577`

5. **Deploy Service:**
   Click **Create Web Service**. Render will build and launch your application.

---

## ⚡ Features Active 24/7 on Render:

- **24/7 WhatsApp AI Concierge:** Auto-responds to incoming customer chats & calls.
- **In-Chat & Email Stripe Payments:** Generates live Stripe Checkout URLs for instant booking payment.
- **Auto Pro-Forma Email Invoices:** Dispatches HTML invoices via Resend API (`info@drivri.co.uk`).
- **200 Miles Daily Allowance & Capping Rules:** Enforces 8-hr van cap, continuous driver hourly rates, and 200 miles included daily.
- **Director Outcome Alerts:** Sends real-time updates to Director WhatsApp (`447490347577`).
