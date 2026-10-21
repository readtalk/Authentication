//
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
	const id = c.env.DATA_DO.idFromName('default');
	const stub = c.env.DATA_DO.get(id);
	return stub.fetch(c.req.raw);
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

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname.startsWith('/users') || url.pathname === '/ws') {
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
