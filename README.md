# Boutique Inventory: Backend (Node.js + Supabase)

1. Create a Supabase project, then run `supabase/schema.sql` in SQL Editor.
2. For local development, copy `.env.example` to `.env` and fill in the project URL, anon key, and service-role key from Supabase Settings > API. Keep `.env` private; never commit it.
3. Setup locally:
```
npm install
npm run create-admin -- "Your Name" you@email.com YourPassword
npm run dev              # http://localhost:5000
```
4. Deploy the backend as a separate Vercel project with this repository as its root. Vercel detects the Express app in `index.js`; no build command or output directory is needed.
5. Add these Vercel environment variables for Production (and Preview if used): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CLIENT_URL`, and `TIMEZONE`. Set `CLIENT_URL` to the exact frontend origin, such as `https://your-store.vercel.app`; comma-separate additional trusted origins. Do not add `PORT` on Vercel.
6. In the separate Vercel frontend project, set `VITE_API_URL` to the deployed backend origin with no trailing slash, then redeploy the frontend.

The service-role key was previously present in the tracked `.env.example`. Replace/rotate it in Supabase before deploying, and never reuse that exposed key. Supabase handles persistent data; Vercel functions are stateless and should not store application data locally.

Main endpoints: `/api/auth/login`, `/api/staff`, `/api/logins`, `/api/stats`, `/api/products`, `/api/sales`, `/api/reports`.
