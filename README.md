# Boutique Inventory: Backend (Node.js + Supabase)

1. Create a Supabase project, then run `supabase/schema.sql` in SQL Editor.
	For an existing database, run `supabase/migrations/20261005_staff_activity_and_customer_receipts.sql` instead to add customer names, activity history, and backfill existing sales.
2. For local development, copy `.env.example` to `.env` and fill in the project URL, anon key, and service-role key from Supabase Settings > API. Keep `.env` private; never commit it.
3. Setup locally:
```
npm install
npm run create-admin -- "Your Name" you@email.com YourPassword
npm run dev              # http://localhost:5000
```
4. Deploy the backend as a separate Vercel project with this repository as its root. Vercel detects the Express app in `index.js`; no build command or output directory is needed.
5. Add these Vercel environment variables for Production (and Preview if used): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CLIENT_URL`, `TIMEZONE`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, and `STAFF_LOGIN_URL`. Set `GMAIL_USER` to the Gmail sending account and `GMAIL_APP_PASSWORD` to its Google App Password. Keep the App Password private. Set `STAFF_LOGIN_URL` to the frontend login URL. Do not add `PORT` on Vercel.
6. In the separate Vercel frontend project, set `VITE_API_URL` to the deployed backend origin with no trailing slash, then redeploy the frontend.

The service-role key was previously present in the tracked `.env.example`. Replace/rotate it in Supabase before deploying, and never reuse that exposed key. Supabase handles persistent data; Vercel functions are stateless and should not store application data locally.

Main endpoints: `/api/auth/login`, `/api/staff`, `/api/logins`, `/api/activity` (admin only), `/api/stats`, `/api/products`, `/api/sales`, `/api/reports`.

When an admin creates a staff account, the backend sends a plain-text welcome email through Gmail SMTP with the login address, initial password, and login URL. The password is sent only in the email body and is not written to activity logs or returned by the API. Email is not an encrypted channel, so use a temporary password and reset it after the first sign-in. If email delivery is not configured or fails, staff creation still succeeds and the admin screen reports the delivery status.
