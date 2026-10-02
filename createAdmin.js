// Usage: npm run create-admin -- "Full Name" admin@email.com Password123
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const usage = 'Usage: npm run create-admin -- "Full Name" email password';

async function main() {
	const args = process.argv.slice(2);
	const [name, rawEmail, password] = args;
	const email = rawEmail?.trim().toLowerCase();
	if (
		args.length !== 3 || !name?.trim() || !email || !password ||
		email === 'your_new_email@example.com' ||
		['YOUR_NEW_STRONG_PASSWORD', 'CHOOSE-A-NEW-PASSWORD'].includes(password.toUpperCase())
	) {
		console.error(`${usage}\nReplace the example email and password with your own values.`);
		process.exitCode = 1;
		return;
	}
	if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
		console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env first.');
		process.exitCode = 1;
		return;
	}

	const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
	const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
	if (error) {
		const duplicate = error.code === 'email_exists' || error.message.toLowerCase().includes('already registered');
		if (!duplicate) {
			console.error(error.message);
			process.exitCode = 1;
			return;
		}

		const { data: profile, error: lookupError } = await db
			.from('profiles').select('id, role').eq('email', email).maybeSingle();
		if (lookupError) {
			console.error(lookupError.message);
			process.exitCode = 1;
			return;
		}
		if (profile?.role && profile.role !== 'admin') {
			console.error('This email belongs to a non-admin account; no changes were made.');
			process.exitCode = 1;
			return;
		}

		let userId = profile?.id;
		if (!userId) {
			let page = 1;
			let authUser;
			while (!authUser) {
				const { data: users, error: usersError } = await db.auth.admin.listUsers({ page, perPage: 1000 });
				if (usersError) {
					console.error(usersError.message);
					process.exitCode = 1;
					return;
				}
				authUser = users.users.find((user) => user.email?.toLowerCase() === email);
				if (authUser || users.users.length < 1000) break;
				page += 1;
			}
			if (!authUser) {
				console.error('The Auth user could not be found; no changes were made.');
				process.exitCode = 1;
				return;
			}
			userId = authUser.id;
		}

		const { error: passwordError } = await db.auth.admin.updateUserById(userId, {
			password,
			email_confirm: true,
		});
		if (passwordError) {
			console.error(passwordError.message);
			process.exitCode = 1;
			return;
		}
		const profileQuery = profile
			? db.from('profiles').update({ full_name: name.trim(), email }).eq('id', userId)
			: db.from('profiles').insert({ id: userId, full_name: name.trim(), email, role: 'admin' });
		const { error: profileError } = await profileQuery;
		if (profileError) {
			console.error(profileError.message);
			process.exitCode = 1;
			return;
		}
		console.log(profile
			? `Existing admin password updated: ${email}`
			: `Admin profile created for existing Auth user: ${email}`);
		return;
	}

	const { error: profileError } = await db.from('profiles').insert({
		id: data.user.id,
		full_name: name.trim(),
		email,
		role: 'admin',
	});
	if (profileError) {
		await db.auth.admin.deleteUser(data.user.id);
		console.error(profileError.message);
		process.exitCode = 1;
		return;
	}
	console.log(`Admin created: ${email}`);
}

main().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
