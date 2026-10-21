import { issuer } from "@openauthjs/openauth";
import {
	CloudflareStorage,
	type CloudflareStorageOptions,
} from "@openauthjs/openauth/storage/cloudflare";
import { PasswordProvider } from "@openauthjs/openauth/provider/password";
import { PasswordUI } from "@openauthjs/openauth/ui/password";
import { createSubjects } from "@openauthjs/openauth/subject";
import { object, string } from "valibot";
import { Hono } from "hono";
import { cors } from "hono/cors";

export { Authentication } from "./authentication/authentication";

const subjects = createSubjects({
	user: object({
		id: string(),
		email: string(),
	}),
});

const app = new Hono();
app.use('*', cors());

app.get('/users', async (c) => {
	const users = await c.env.DATA_DB.prepare(
		`SELECT id, email, username, yourname, date_of_birth, created_at FROM user`
	).all();
	return c.json({ success: true, users: users.results });
});

app.get('/users/online', async (c) => {
	const id = c.env.DATA_DO.idFromName('default');
	const stub = c.env.DATA_DO.get(id);
	return stub.fetch(c.req.raw);
});

app.all('/ws', async (c) => {
	const id = c.env.DATA_DO.idFromName('default');
	const stub = c.env.DATA_DO.get(id);
	return stub.fetch(c.req.raw);
});

app.get('/chats', async (c) => {
	const authHeader = c.req.header("Authorization");
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return c.json({ success: false, error: "Unauthorized" }, 401);
	}
	const token = authHeader.replace("Bearer ", "");
	const payload = JSON.parse(atob(token.split(".")[1]));
	const userId = payload.properties?.id || payload.sub;

	const id = c.env.DATA_DO.idFromName('default');
	const stub = c.env.DATA_DO.get(id);
	
	const newHeaders = new Headers(c.req.raw.headers);
	newHeaders.set("X-User-Id", userId);
	
	const newRequest = new Request(c.req.raw.url, {
		method: c.req.method,
		headers: newHeaders,
		body: c.req.raw.body
	});

	return stub.fetch(newRequest);
});

app.post('/chats', async (c) => {
	const authHeader = c.req.header("Authorization");
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return c.json({ success: false, error: "Unauthorized" }, 401);
	}
	const token = authHeader.replace("Bearer ", "");
	const payload = JSON.parse(atob(token.split(".")[1]));
	const userId = payload.properties?.id || payload.sub;

	const id = c.env.DATA_DO.idFromName('default');
	const stub = c.env.DATA_DO.get(id);
	
	const newHeaders = new Headers(c.req.raw.headers);
	newHeaders.set("X-User-Id", userId);
	
	const newRequest = new Request(c.req.raw.url, {
		method: c.req.method,
		headers: newHeaders,
		body: c.req.raw.body
	});

	return stub.fetch(newRequest);
});

app.get('/settings', async (c) => {
	const authHeader = c.req.header("Authorization");
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return c.json({ success: false, error: "Unauthorized" }, 401);
	}

	const token = authHeader.replace("Bearer ", "");
	
	try {
		const payloadBase64 = token.split(".")[1];
		const payload = JSON.parse(atob(payloadBase64));
		const userId = payload.properties?.id || payload.sub;

		if (!userId) {
			return c.json({ success: false, error: "Invalid token" }, 401);
		}

		const user = await c.env.DATA_DB.prepare(
			`SELECT username, yourname, date_of_birth FROM user WHERE id = ?`
		).bind(userId).first();

		if (!user) {
			return c.json({ success: false, error: "User not found" }, 404);
		}

		return c.json({ success: true, user });
	} catch (error) {
		console.error("Settings fetch error:", error);
		return c.json({ success: false, error: "Failed to fetch settings" }, 500);
	}
});

app.post('/settings', async (c) => {
	const authHeader = c.req.header("Authorization");
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return c.json({ success: false, error: "Unauthorized" }, 401);
	}

	const token = authHeader.replace("Bearer ", "");
	
	try {
		const payloadBase64 = token.split(".")[1];
		const payload = JSON.parse(atob(payloadBase64));
		const userId = payload.properties?.id || payload.sub;

		if (!userId) {
			return c.json({ success: false, error: "Invalid token" }, 401);
		}

		const { username, yourname, date_of_birth } = await c.req.json();
		
		if (!username || !yourname || !date_of_birth) {
			return c.json({ success: false, error: "All fields are required" }, 400);
		}

		const usernameRegex = /^[A-Za-z0-9_]{1,14}$/;
		if (!usernameRegex.test(username)) {
			return c.json({ success: false, error: "Username must be 1-14 characters, only A-Z, 0-9, and underscore" }, 400);
		}

		await c.env.DATA_DB.prepare(
			`UPDATE user SET username = ?, yourname = ?, date_of_birth = ? WHERE id = ?`
		).bind(username, yourname, date_of_birth, userId).run();

		return c.json({ success: true });
	} catch (error) {
		console.error("Settings update error:", error);
		return c.json({ success: false, error: "Failed to update settings" }, 500);
	}
});

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname.startsWith('/users') || url.pathname === '/ws' || url.pathname === '/settings' || url.pathname.startsWith('/chats')) {
			return app.fetch(request, env, ctx);
		}

		if (url.pathname === "/") {
			url.searchParams.set("redirect_uri", url.origin + "/callback");
			url.searchParams.set("client_id", "your-client-id");
			url.searchParams.set("response_type", "code");
			url.pathname = "/authorize";
			return Response.redirect(url.toString());
		} else if (url.pathname === "/callback") {
			return Response.json({
				message: "OAuth flow complete!",
				params: Object.fromEntries(url.searchParams.entries()),
			});
		}

		return issuer({
			storage: CloudflareStorage({
				namespace: env.DATA_KV as CloudflareStorageOptions["namespace"],
			}),
			subjects,
			providers: {
				password: PasswordProvider(
					PasswordUI({
						sendCode: async (email, code) => {
							console.log(`Sending code ${code} to ${email}`);
						},
						copy: {
							input_code: "Code (check Worker logs)",
						},
					}),
				),
			},
			theme: {
				title: "OpenAuth",
				primary: "#FF0000",
				favicon: "https://raw.githubusercontent.com/readtalk/asean/refs/heads/main/public/favicon.ico",
				logo: {
					dark: "https://raw.githubusercontent.com/readtalk/asean/refs/heads/main/public/brand.png",
					light:
						"https://raw.githubusercontent.com/readtalk/asean/refs/heads/main/public/brand.png",
				},
			},
			success: async (ctx, value) => {
				const userID = await getOrCreateUser(env, value.email);
				
				return ctx.subject("user", {
					id: userID,
					email: value.email,
				});
			},
		}).fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;

async function getOrCreateUser(env: Env, email: string): Promise<string> {
	const result = await env.DATA_DB.prepare(
		`
		INSERT INTO user (email)
		VALUES (?)
		ON CONFLICT (email) DO UPDATE SET email = email
		RETURNING id;
		`,
	)
		.bind(email)
		.first<{ id: string }>();
	if (!result) {
		throw new Error(`Unable to process user: ${email}`);
	}
	console.log(`Found or created user ${result.id} with email ${email}`);
	return result.id;
}
