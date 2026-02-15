import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

import { WebSocket, WebSocketServer } from 'ws';

import { ASSISTANT_NAME, WEB_PORT } from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage } from '../types.js';

const WEB_JID = 'web@web.nanoclaw';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// When running from dist/, the HTML lives in src/channels/. Try both locations.
const HTML_PATH = fs.existsSync(path.join(__dirname, 'web-client.html'))
  ? path.join(__dirname, 'web-client.html')
  : path.join(__dirname, '..', '..', 'src', 'channels', 'web-client.html');

// Read at module load — the file is small and never changes at runtime
let cachedHtml: string | undefined;
function getHtml(): string {
  if (!cachedHtml) cachedHtml = fs.readFileSync(HTML_PATH, 'utf-8');
  return cachedHtml;
}

export interface WebChannelOpts {
  onMessage: OnInboundMessage;
}

export class WebChannel implements Channel {
  name = 'web';

  private server!: http.Server;
  private wss!: WebSocketServer;
  private connected = false;
  private clients = new Set<WebSocket>();
  private opts: WebChannelOpts;

  constructor(opts: WebChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.server = http.createServer((req, res) => {
        if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(getHtml());
        } else if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', clients: this.clients.size }));
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });

      this.wss = new WebSocketServer({ noServer: true });

      this.server.on('upgrade', (req, socket, head) => {
        if (req.url === '/ws') {
          this.wss.handleUpgrade(req, socket, head, (ws) => {
            this.wss.emit('connection', ws, req);
          });
        } else {
          socket.destroy();
        }
      });

      this.wss.on('connection', (ws) => {
        this.clients.add(ws);
        logger.info({ clients: this.clients.size }, 'Web client connected');

        ws.on('message', (data) => {
          let parsed: { type?: string; text?: string } | undefined;
          try {
            parsed = JSON.parse(String(data));
          } catch {
            logger.debug('Invalid WebSocket JSON from web client');
            return;
          }
          if (parsed?.type === 'message' && typeof parsed.text === 'string' && parsed.text.trim()) {
            const now = new Date().toISOString();
            try {
              this.opts.onMessage(WEB_JID, {
                id: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                chat_jid: WEB_JID,
                sender: 'user@web.nanoclaw',
                sender_name: 'User',
                content: parsed.text.trim(),
                timestamp: now,
                is_from_me: false,
                is_bot_message: false,
              });
              logger.debug({ content: parsed.text.trim().slice(0, 100) }, 'Web message stored');
            } catch (err) {
              logger.error({ err }, 'Failed to store web message');
            }
          }
        });

        ws.on('close', () => {
          this.clients.delete(ws);
          logger.debug({ clients: this.clients.size }, 'Web client disconnected');
        });
      });

      this.server.listen(WEB_PORT, () => {
        this.connected = true;
        logger.info({ port: WEB_PORT }, `Web chat available at http://localhost:${WEB_PORT}`);
        resolve();
      });
    });
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    const payload = JSON.stringify({ type: 'message', text });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
    logger.info({ clients: this.clients.size, length: text.length }, 'Web message sent');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@web.nanoclaw');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    for (const ws of this.clients) ws.close();
    this.clients.clear();
    this.wss?.close();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  async setTyping(_jid: string, isTyping: boolean): Promise<void> {
    const payload = JSON.stringify({ type: 'typing', isTyping });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  /** The JID used for the web chat room. */
  static get JID(): string {
    return WEB_JID;
  }

  /** The assistant name — useful for registering the group. */
  static get assistantName(): string {
    return ASSISTANT_NAME;
  }
}
