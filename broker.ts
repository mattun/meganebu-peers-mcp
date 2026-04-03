#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * A singleton HTTP server on localhost:7899 backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages between them.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  AckMessagesRequest,
  Peer,
  Message,
} from "./shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const HOST = process.env.CLAUDE_PEERS_HOST ?? "127.0.0.1";
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
const IS_REMOTE = HOST !== "127.0.0.1" && HOST !== "localhost";

// --- Startup guard: detect port conflict ---
async function checkPortConflict(): Promise<void> {
  try {
    const res = await fetch(`http://${HOST}:${PORT}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = await res.json() as { status: string; peers: number };
      console.error(`[broker] FATAL: Port ${PORT} already in use by another broker (${data.peers} peers registered).`);
      console.error(`[broker] Find it with: lsof -i :${PORT} | grep LISTEN`);
      console.error(`[broker] Kill it first, then restart this broker.`);
      process.exit(1);
    }
  } catch {
    // Port is free (connection refused) — good
  }
}
await checkPortConflict();

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    hostname TEXT NOT NULL DEFAULT 'localhost',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

// Migration: add hostname column if upgrading from older schema
try {
  db.run("ALTER TABLE peers ADD COLUMN hostname TEXT NOT NULL DEFAULT 'localhost'");
} catch {
  // Column already exists, ignore
}

// Migration: add workspace_id column for workspace-scoped communication
try {
  db.run("ALTER TABLE peers ADD COLUMN workspace_id TEXT");
} catch {
  // Column already exists, ignore
}

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

// Clean up stale peers
// Local peers: PID-based check (immediate, accurate)
// Remote peers: heartbeat-based expiry (60s timeout)
const STALE_HEARTBEAT_MS = 60_000;

function cleanStalePeers() {
  const localHostname = require("os").hostname();
  const peers = db.query("SELECT id, pid, hostname, last_seen FROM peers").all() as {
    id: string; pid: number; hostname: string; last_seen: string;
  }[];
  for (const peer of peers) {
    let isStale = false;
    const isLocal = peer.hostname === "localhost" || peer.hostname === localHostname;

    if (isLocal) {
      // Local peer: check PID
      try {
        process.kill(peer.pid, 0);
      } catch {
        isStale = true;
        console.error(`[broker] PURGE local peer ${peer.id} (pid=${peer.pid}, hostname=${peer.hostname}): PID not found. localHostname=${localHostname}`);
      }
    } else {
      // Remote peer: check heartbeat age
      const lastSeen = new Date(peer.last_seen).getTime();
      const age = Date.now() - lastSeen;
      isStale = age > STALE_HEARTBEAT_MS;
      if (isStale) {
        console.error(`[broker] PURGE remote peer ${peer.id} (hostname=${peer.hostname}, pid=${peer.pid}): age=${age}ms > ${STALE_HEARTBEAT_MS}ms, last_seen=${peer.last_seen}`);
      }
    }

    if (isStale) {
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
    }
  }
}

cleanStalePeers();

// Periodically clean stale peers (every 30s)
setInterval(cleanStalePeers, 30_000);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, summary, hostname, workspace_id, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

const selectAllPeers = db.prepare(`
  SELECT * FROM peers
`);

const selectPeersByDirectory = db.prepare(`
  SELECT * FROM peers WHERE cwd = ?
`);

const selectPeersByGitRoot = db.prepare(`
  SELECT * FROM peers WHERE git_root = ?
`);

const selectPeersByWorkspace = db.prepare(`
  SELECT * FROM peers WHERE workspace_id = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, 0)
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();
  const hostname = body.hostname ?? "localhost";

  // Remove any existing registration for this PID+hostname (re-registration)
  const existing = db.query("SELECT id FROM peers WHERE pid = ? AND hostname = ?").get(body.pid, hostname) as { id: string } | null;
  if (existing) {
    deletePeer.run(existing.id);
  }

  const workspaceId = body.workspace_id ?? null;
  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, body.summary, hostname, workspaceId, now, now);
  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];

  switch (body.scope) {
    case "network":
      // All peers across all machines
      peers = selectAllPeers.all() as Peer[];
      break;
    case "machine":
      peers = selectAllPeers.all() as Peer[];
      break;
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      if (body.git_root) {
        peers = selectPeersByGitRoot.all(body.git_root) as Peer[];
      } else {
        // No git root, fall back to directory
        peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      }
      break;
    case "workspace":
      if (body.workspace_id) {
        peers = selectPeersByWorkspace.all(body.workspace_id) as Peer[];
      } else {
        peers = [];
      }
      break;
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  // Exclude the requesting peer
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  const localHostname = require("os").hostname();

  // Verify liveness: PID check for local, heartbeat check for remote
  return peers.filter((p) => {
    const isLocal = p.hostname === "localhost" || p.hostname === localHostname;
    if (isLocal) {
      try {
        process.kill(p.pid, 0);
        return true;
      } catch {
        console.error(`[broker] LIST-PEERS purge local peer ${p.id} (pid=${p.pid}, hostname=${p.hostname}): PID not found. localHostname=${localHostname}`);
        deletePeer.run(p.id);
        return false;
      }
    } else {
      // Remote peer: trust heartbeat (stale cleanup handles expiry)
      const lastSeen = new Date(p.last_seen).getTime();
      return Date.now() - lastSeen <= STALE_HEARTBEAT_MS;
    }
  });
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  // Verify target exists
  const target = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id) as { id: string } | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }

  insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];
  // Don't mark delivered here — wait for explicit ack from the MCP server
  return { messages };
}

function handleAckMessages(body: AckMessagesRequest): { ok: boolean } {
  for (const id of body.message_ids) {
    markDelivered.run(id);
  }
  return { ok: true };
}

function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
}

// --- HTTP Server ---

Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
      }
      return new Response("claude-peers broker", { status: 200 });
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/register":
          return Response.json(handleRegister(body as RegisterRequest));
        case "/heartbeat":
          handleHeartbeat(body as HeartbeatRequest);
          return Response.json({ ok: true });
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/ack-messages":
          return Response.json(handleAckMessages(body as AckMessagesRequest));
        case "/unregister":
          handleUnregister(body as { id: string });
          return Response.json({ ok: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

console.error(`[claude-peers broker] listening on ${HOST}:${PORT} (db: ${DB_PATH})${IS_REMOTE ? " [REMOTE MODE]" : ""}`);
