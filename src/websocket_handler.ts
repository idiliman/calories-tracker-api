interface WebSocketMessage {
  type: string;
  clientId?: string;
  message?: string;
  [key: string]: any;
}

export class WebSocketHandler {
  private sessions: Map<string, WebSocket>;
  private cache: KVNamespace;

  constructor(cache: KVNamespace) {
    this.sessions = new Map();
    this.cache = cache;
  }

  async fetch(request: Request) {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const clientId = crypto.randomUUID();

      server.accept();

      // Store the WebSocket connection in memory
      this.sessions.set(clientId, server);

      // Store client info in KV
      await this.cache.put(
        `ws:${clientId}`,
        JSON.stringify({
          connected: true,
          connectedAt: new Date().toISOString(),
        })
      );

      // Send the client ID immediately after connection
      server.send(
        JSON.stringify({
          type: "connection",
          clientId,
          message: "Connected successfully",
        })
      );

      // Handle incoming messages
      server.addEventListener("message", async (msg) => {
        try {
          const data = JSON.parse(msg.data as string) as WebSocketMessage;
          const response = {
            ...data,
            clientId,
            timestamp: new Date().toISOString(),
          };
          server.send(JSON.stringify(response));
        } catch (err) {
          server.send(
            JSON.stringify({
              type: "error",
              message: "Invalid message format",
              clientId,
            })
          );
        }
      });

      // Handle connection closing
      server.addEventListener("close", async () => {
        this.sessions.delete(clientId);
        await this.cache.delete(`ws:${clientId}`);
      });

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    // Handle broadcast messages
    if (request.method === "POST") {
      const message = (await request.json()) as WebSocketMessage;

      if (message.type === "broadcast") {
        await this.broadcast(message);
        return new Response("Message broadcasted", { status: 200 });
      }

      if (message.type === "direct" && message.clientId) {
        const success = await this.sendToClient(message.clientId, message);
        return new Response(success ? "Message sent" : "Client not found", { status: success ? 200 : 404 });
      }
    }

    return new Response("Expected WebSocket or POST request", { status: 400 });
  }

  async broadcast(message: WebSocketMessage) {
    const payload = JSON.stringify({
      ...message,
      timestamp: new Date().toISOString(),
    });

    // Get all connected clients from KV
    const { keys } = await this.cache.list({ prefix: "ws:" });

    // Send to all active connections
    keys.forEach(({ name }) => {
      const clientId = name.replace("ws:", "");
      const socket = this.sessions.get(clientId);
      if (socket) {
        socket.send(payload);
      }
    });
  }

  async sendToClient(clientId: string, message: WebSocketMessage) {
    // Check if client exists in KV
    const clientExists = await this.cache.get(`ws:${clientId}`);
    if (!clientExists) return false;

    const socket = this.sessions.get(clientId);
    if (socket) {
      socket.send(
        JSON.stringify({
          ...message,
          timestamp: new Date().toISOString(),
        })
      );
      return true;
    }
    return false;
  }
}
