/**
 * PM Gateway MCP Server — Module 2 of the PM Monitoring System.
 *
 * SECURITY: This is a strictly read-only programmatic gateway.
 * Every tool is code-gated — no write operations to any external service.
 * Adding new tools requires a code change and human review.
 * The container agent connects via Streamable HTTP; credentials never leave this process.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebClient } from '@slack/web-api';
import http from 'http';
import { logger } from '../logger.js';
import { registerSlackTools } from './tools/slack.js';

export function startGateway(port: number, slackToken: string): http.Server {
  const slack = new WebClient(slackToken);

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    // Health check
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Streamable HTTP MCP endpoint
    if (url.pathname === '/mcp') {
      const server = createMcpServer(slack);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  httpServer.listen(port, '127.0.0.1', () => {
    logger.info({ port }, 'PM Gateway MCP server started (Streamable HTTP)');
  });

  return httpServer;
}

function createMcpServer(slack: WebClient): McpServer {
  const server = new McpServer({
    name: 'pm-gateway',
    version: '1.0.0',
  });

  registerSlackTools(server, slack);

  return server;
}
