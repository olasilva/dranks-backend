# Admin Access

Admin passwords are managed by Supabase Auth. They cannot be displayed or recovered from this project because Supabase does not provide the original password after account creation.

## Create the first admin

Make sure the Supabase tables have been created by running `supabase/schema.sql` in the Supabase SQL Editor, and that `.env` contains the Supabase URL and service-role key. Then run:

```sh
npm run create-admin -- "Admin Name" admin@example.com Choose-A-Strong-Password
```

Use the email and password you chose to sign in at `/admin`. Store the password in a password manager; avoid committing it or putting it in a project file.

## Forgotten password

Reset the account password using Supabase's Authentication user management for the project, or create a new admin account with a different email using the command above. The old password cannot be recovered.
