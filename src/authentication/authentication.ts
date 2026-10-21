//
import { Hono } from "hono";
import { cors } from "hono/cors";
import { DurableObject } from "cloudflare:workers";

export class Authentication extends DurableObject {
    private app: Hono = new Hono();
    public sql: SqlStorage;
    public connections = new Map<string, WebSocket>();

    constructor(ctx: DurableObjectState, env: any) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.setup();
    }

    private async setup() {
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS user (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                first_name TEXT,
                last_name TEXT,
                avatar TEXT,
                created_at INTEGER DEFAULT (unixepoch())
            );

            CREATE TABLE IF NOT EXISTS session (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                created_at INTEGER DEFAULT (unixepoch()),
                expires_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chat (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                is_private INTEGER DEFAULT 0,
                created_at INTEGER DEFAULT (unixepoch())
            );

            CREATE TABLE IF NOT EXISTS chat_user (
                id TEXT PRIMARY KEY,
                chat_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                created_at INTEGER DEFAULT (unixepoch()),
                UNIQUE(chat_id, user_id)
            );
        `);

        this.setupRoutes();
    }

    private setupRoutes() {
        this.app.use('*', cors());

        this.app.post('/users/sync', async (c) => {
            const { id, email } = await c.req.json();
            if (!id || !email) return c.json({ success: false, error: 'id and email required' }, 400);

            const existing = this.sql.exec(`SELECT id FROM user WHERE id = ?`, id).toArray();
            if (existing.length === 0) {
                this.sql.exec(`INSERT INTO user (id, email) VALUES (?, ?)`, id, email);
                return c.json({ success: true, created: true });
            }
            return c.json({ success: true, created: false });
        });

        this.app.get('/users', async (c) => {
            const users = this.sql.exec(`SELECT id, email, first_name, last_name, avatar FROM user`).toArray();
            return c.json({ success: true, users });
        });

        this.app.get('/users/online', async (c) => {
            const onlineUserIds = Array.from(this.connections.keys());
            if (onlineUserIds.length === 0) return c.json({ success: true, onlineUsers: [] });

            const placeholders = onlineUserIds.map(() => '?').join(',');
            const onlineUsers = this.sql.exec(
                `SELECT id, email, first_name, last_name, avatar FROM user WHERE id IN (${placeholders})`,
                ...onlineUserIds
            ).toArray();

            return c.json({ success: true, onlineUsers });
        });

        this.app.get('/chats', async (c) => {
            const sessionId = c.req.header('X-Session-Id') || '';
            const { valid, userId } = await this.validateSession(sessionId);

            if (!valid || !userId) return c.json({ success: false, error: 'Invalid session' }, 401);

            const chats = this.sql.exec(`
                SELECT 
                    ch.*,
                    COUNT(DISTINCT cu2.user_id) as member_count,
                    GROUP_CONCAT(cu2.user_id) as member_ids
                FROM chat ch
                INNER JOIN chat_user cu ON ch.id = cu.chat_id
                LEFT JOIN chat_user cu2 ON ch.id = cu2.chat_id
                WHERE cu.user_id = ?
                GROUP BY ch.id
                ORDER BY ch.created_at DESC
            `, userId).toArray();

            const formatted = chats.map((ch: any) => ({
                ...ch,
                member_ids: ch.member_ids ? ch.member_ids.split(',') : []
            }));

            return c.json({ success: true, chats: formatted });
        });

        this.app.post('/chats', async (c) => {
            const sessionId = c.req.header('X-Session-Id');
            if (!sessionId) return c.json({ success: false, error: 'No session' }, 401);

            const { valid, userId } = await this.validateSession(sessionId);
            if (!valid || !userId) return c.json({ success: false, error: 'Invalid session' }, 401);

            const { name, description, is_private, member_ids } = await c.req.json();
            if (!name?.trim()) return c.json({ success: false, error: 'Chat name is required' }, 400);

            const chatId = crypto.randomUUID();

            this.sql.exec(
                `INSERT INTO chat (id, name, description, is_private) VALUES (?, ?, ?, ?)`,
                chatId, name, description || null, is_private ? 1 : 0
            );

            this.sql.exec(
                `INSERT INTO chat_user (id, chat_id, user_id) VALUES (?, ?, ?)`,
                crypto.randomUUID(), chatId, userId
            );

            if (member_ids && Array.isArray(member_ids)) {
                for (const mid of member_ids.filter((id: string) => id !== userId)) {
                    this.sql.exec(
                        `INSERT OR IGNORE INTO chat_user (id, chat_id, user_id) VALUES (?, ?, ?)`,
                        crypto.randomUUID(), chatId, mid
                    );
                }
            }

            return c.json({ success: true, chat_id: chatId });
        });
    }

    public async clientConnected(sessionId?: string) {
        const [client, server] = Object.values(new WebSocketPair());

        if (!sessionId) {
            server.close(1008, 'Session ID is required');
            return new Response('Session ID is required', { status: 400 });
        }

        const { valid, userId } = await this.validateSession(sessionId);
        if (!valid || !userId) {
            server.close(1008, 'Invalid session');
            return new Response('Invalid session', { status: 401 });
        }

        this.connections.set(userId, server);
        await this.broadcastUserPresence(userId, true);

        server.accept();
        server.addEventListener('close', async () => {
            this.connections.delete(userId);
            await this.broadcastUserPresence(userId, false);
        });

        return new Response(null, { status: 101, webSocket: client });
    }

    private async broadcastUserPresence(userId: string, isOnline: boolean) {
        const notification = JSON.stringify({
            type: isOnline ? 'USER_CONNECTED' : 'USER_DISCONNECTED',
            userId
        });

        for (const [cid, socket] of this.connections.entries()) {
            if (cid !== userId && socket.readyState === 1) {
                try {
                    socket.send(notification);
                } catch {
                    this.connections.delete(cid);
                }
            }
        }
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === '/ws') {
            if (request.headers.get('upgrade') === 'websocket') {
                const sessionId = url.searchParams.get('sessionId') ?? '';
                return this.clientConnected(sessionId);
            }
            return new Response('Expected WebSocket', { status: 400 });
        }

        return this.app.fetch(request);
    }

    private async validateSession(sessionId: string | null): Promise<{ valid: boolean; userId?: string }> {
        if (!sessionId) return { valid: false };

        const [session] = this.sql.exec(
            `SELECT user_id FROM session WHERE id = ? AND expires_at > unixepoch() LIMIT 1`,
            sessionId
        ).toArray() as { user_id: string }[];

        if (!session) return { valid: false };

        return { valid: true, userId: session.user_id };
    }

    public async checkChatAccess(sessionId: string, chatId: string): Promise<boolean> {
        const { valid, userId } = await this.validateSession(sessionId);
        if (!valid || !userId) return false;

        const access = this.sql.exec(
            `SELECT 1 FROM chat_user WHERE chat_id = ? AND user_id = ? LIMIT 1`,
            chatId, userId
        ).toArray();

        return access.length > 0;
    }
}
