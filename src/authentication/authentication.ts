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

        this.app.get('/users/online', async (c) => {
            const onlineUserIds = Array.from(this.connections.keys());
            return c.json({ success: true, onlineUsers: onlineUserIds });
        });
    }

    public async clientConnected(sessionId?: string) {
        const [client, server] = Object.values(new WebSocketPair());

        if (!sessionId) {
            server.close(1008, 'Session ID is required');
            return new Response('Session ID is required', { status: 400 });
        }

        this.connections.set(sessionId, server);
        await this.broadcastUserPresence(sessionId, true);

        server.accept();
        server.addEventListener('close', async () => {
            this.connections.delete(sessionId);
            await this.broadcastUserPresence(sessionId, false);
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
}
