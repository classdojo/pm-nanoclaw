/**
 * PM Dashboard Server — serves inbox items, accepts feedback, and serves static assets.
 *
 * API:
 *   GET  /api/inbox         — list all inbox items (reads 0_Inbox_Incoming/)
 *   GET  /api/state/*       — serve state JSON files
 *   POST /api/feedback      — submit feedback on an inbox item
 *   GET  /api/feedback      — list pending feedback
 *   GET  /*                 — serve static dashboard files
 *
 * Localhost-only, no authentication.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import Database from 'better-sqlite3';
import { logger } from '../logger.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function startDashboard(port: number, groupDir: string): http.Server {
  const dashboardDir = path.join(groupDir, 'dashboard');
  const stateDir = path.join(groupDir, 'state');
  const feedbackDir = path.join(stateDir, 'feedback');
  fs.mkdirSync(feedbackDir, { recursive: true });

  // Find the second brain inbox directory
  const extraDir = path.join(
    path.dirname(path.dirname(groupDir)), // nanoclaw root
    'groups', 'pm-monitor',
  );
  // The actual second brain path is resolved at request time from the mount

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // API: list inbox items — reads alerts.json (agent-maintained) with second brain fallback
    if (url.pathname === '/api/inbox' && req.method === 'GET') {
      return serveInbox(groupDir, res);
    }

    // API: force-sync inbox from second brain files (manual trigger)
    if (url.pathname === '/api/inbox/sync' && req.method === 'POST') {
      return syncInboxFromFiles(groupDir, res);
    }

    // API: submit feedback
    if (url.pathname === '/api/feedback' && req.method === 'POST') {
      return handleFeedback(feedbackDir, req, res);
    }

    // API: list pending feedback
    if (url.pathname === '/api/feedback' && req.method === 'GET') {
      return serveFeedback(feedbackDir, res);
    }

    // API: trigger scan if stale (>15 min since last scan)
    if (url.pathname === '/api/trigger-scan' && req.method === 'POST') {
      return triggerScanIfStale(groupDir, res);
    }

    // API: scan history log
    if (url.pathname === '/api/log' && req.method === 'GET') {
      const logFile = path.join(groupDir, 'logs', 'scan-history.log');
      return serveFile(logFile, res, 'text/plain');
    }

    // API: cost tracker
    if (url.pathname === '/api/costs' && req.method === 'GET') {
      const costFile = path.join(path.dirname(path.dirname(groupDir)), 'store', 'cost-tracker.json');
      return serveFile(costFile, res, 'application/json');
    }

    // API: serve state JSON files
    if (url.pathname.startsWith('/api/state')) {
      const subPath = url.pathname.replace('/api/state', '') || '/synthesis.json';
      const filePath = path.join(stateDir, subPath);
      return serveFile(filePath, res, 'application/json');
    }

    // Static dashboard files
    let filePath = path.join(dashboardDir, url.pathname);
    if (url.pathname === '/') filePath = path.join(dashboardDir, 'index.html');

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'text/plain';
    return serveFile(filePath, res, contentType);
  });

  httpServer.listen(port, '127.0.0.1', () => {
    logger.info({ port }, 'PM Dashboard server started');
  });

  return httpServer;
}

/** Serve inbox items. Reads alerts.json (agent-maintained). If empty, falls back to scanning files. */
function serveInbox(groupDir: string, res: http.ServerResponse): void {
  const alertsPath = path.join(groupDir, 'state', 'alerts.json');

  // Try alerts.json first (agent-maintained source of truth)
  let alertItems: Array<Record<string, unknown>> = [];
  try {
    const raw = JSON.parse(fs.readFileSync(alertsPath, 'utf-8'));
    alertItems = Array.isArray(raw) ? raw : (raw.items || []);
  } catch {
    // No alerts yet
  }

  // If alerts.json has items, use those
  if (alertItems.length > 0) {
    const items = alertItems.map((a, i) => ({
      id: (a.id as string) || (a.filename as string)?.replace(/\.md$/, '') || `alert-${i}`,
      filename: a.filename,
      title: (a.title as string) || 'Item',
      content: (a.content as string) || (a.description as string) || JSON.stringify(a),
      source: (a.source as string) || 'alert',
      ...a,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items }));
    return;
  }

  // Fallback: read second brain inbox directly (bootstrap / agent hasn't synced yet)
  const items = readSecondBrainInbox();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ items }));
}

function readSecondBrainInbox(): Array<Record<string, unknown>> {
  const inboxDir = findSecondBrainInbox();
  if (!inboxDir) return [];

  const items: Array<Record<string, unknown>> = [];
  try {
    const files = fs.readdirSync(inboxDir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse();

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(inboxDir, file), 'utf-8');
        const title = content.split('\n')[0]?.replace(/^#+\s*/, '') || file;
        items.push({
          id: file.replace(/\.md$/, ''),
          filename: file,
          title,
          content,
          source: 'second-brain',
        });
      } catch { /* skip */ }
    }
  } catch { /* dir not accessible */ }
  return items;
}

/** Force-sync: read second brain inbox and write to alerts.json */
function syncInboxFromFiles(groupDir: string, res: http.ServerResponse): void {
  const items = readSecondBrainInbox();
  const alertsPath = path.join(groupDir, 'state', 'alerts.json');
  fs.writeFileSync(alertsPath, JSON.stringify({ items }, null, 2));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ synced: items.length }));
}

function findSecondBrainInbox(): string | null {
  const knownPath =
    '/Users/george/Library/CloudStorage/GoogleDrive-george.wang@classdojo.com/My Drive/Second Brain/0_Inbox_Incoming';
  try {
    fs.accessSync(knownPath, fs.constants.R_OK);
    return knownPath;
  } catch {
    return null;
  }
}

/** Accept feedback POST and write to feedback directory. */
async function handleFeedback(
  feedbackDir: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString();

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON' }));
    return;
  }

  // Write feedback file — agent reads these on next scan
  const ts = Date.now();
  const feedback = {
    timestamp: new Date().toISOString(),
    itemId: data.itemId,
    action: data.action, // 'acknowledge' | 'dismiss' | 'handled' | 'message'
    note: data.note || '',
  };

  const filename = `feedback_${ts}.json`;
  fs.writeFileSync(
    path.join(feedbackDir, filename),
    JSON.stringify(feedback, null, 2),
  );

  logger.info({ feedback: filename, action: feedback.action }, 'Dashboard feedback received');

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, id: filename }));
}

/** List pending feedback files. */
function serveFeedback(feedbackDir: string, res: http.ServerResponse): void {
  try {
    const files = fs.readdirSync(feedbackDir).filter(f => f.endsWith('.json'));
    const items = files.map(f => {
      const content = fs.readFileSync(path.join(feedbackDir, f), 'utf-8');
      return { file: f, ...JSON.parse(content) };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items }));
  } catch {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: [] }));
  }
}

/** If last scan was >15 min ago, set next_run to now so scheduler picks it up. */
function triggerScanIfStale(groupDir: string, res: http.ServerResponse): void {
  const lastScanPath = path.join(groupDir, 'state', 'last-scan.json');
  let lastTs = 0;
  try {
    const data = JSON.parse(fs.readFileSync(lastScanPath, 'utf-8'));
    lastTs = typeof data.timestamp === 'number' ? data.timestamp * 1000 : 0; // Unix seconds → ms
  } catch { /* no last scan */ }

  const staleMs = Date.now() - lastTs;
  const FIFTEEN_MIN = 15 * 60 * 1000;

  if (staleMs < FIFTEEN_MIN) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ triggered: false, reason: 'recent scan exists', agoMs: staleMs }));
    return;
  }

  // Set next_run to now in the DB so the scheduler picks it up immediately
  try {
    const dbPath = path.join(path.dirname(path.dirname(groupDir)), 'store', 'messages.db');
    const db = new Database(dbPath);
    const result = db.prepare(
      "UPDATE scheduled_tasks SET next_run = datetime('now') WHERE group_folder = 'pm-monitor' AND status = 'active'"
    ).run();
    db.close();
    logger.info('Dashboard triggered scan (stale by ' + Math.round(staleMs / 60000) + 'm)');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ triggered: true, staleMins: Math.round(staleMs / 60000), updated: result.changes }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to trigger scan' }));
  }
}

function serveFile(
  filePath: string,
  res: http.ServerResponse,
  contentType: string,
): void {
  const resolved = path.resolve(filePath);
  try {
    const content = fs.readFileSync(resolved, 'utf-8');
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }
}
