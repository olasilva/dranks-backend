# Boutique Inventory: Backend (Node.js + Supabase)

1. Supabase: create a project, open SQL Editor, run `supabase/schema.sql`.
   Copy the Project URL, `anon` key and `service_role` key (Settings > API).
2. Setup:
```
npm install
npm run create-admin -- "Your Name" you@email.com YourPassword
npm run dev              # http://localhost:5000
```
3. Keep the service-role key secret; it only ever lives in this server's `.env`.
4. Deploying: set `CLIENT_URL` to your frontend's address (comma-separate several).

Main endpoints: `/api/auth/login`, `/api/staff`, `/api/logins`, `/api/stats`, `/api/products`, `/api/sales`, `/api/reports`.
