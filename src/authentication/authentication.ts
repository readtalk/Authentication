import { Hono } from "hono";
import { cors } from "hono/cors";
import { DurableObject } from "cloudflare:workers";

export class Authentication extends DurableObject {
    private app: Hono = new Hono();
    public connections = new Map<string, WebSocket>();

    constructor(ctx: DurableObjectState, env: any) {
        super(ctx, env);
        this.setup();
    }

    private async setup() {
        this.app.use('*', cors());

        this.app.get('/users', async (c) => {
            return c.json({ success: true, users: [] });
        });

        this.app.get('/users/online', async (c) => {
            const onlineUserIds = Array.from(this.connections.keys());
            return c.json({ success: true, onlineUsers: onlineUserIds });
        });
    }

    public async clientConnected(sessionId?: string, userId?: string) {
        const [client, server] = Object.values(new WebSocketPair());

        if (!sessionId || !userId) {
            server.close(1008, 'Session ID and User ID are required');
            return new Response('Session ID and User ID are required', { status: 400 });
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
                const userId = url.searchParams.get('userId') ?? '';
                return this.clientConnected(sessionId, userId);
            }
            return new Response('Expected WebSocket', { status: 400 });
        }

        return this.app.fetch(request);
    }
}
