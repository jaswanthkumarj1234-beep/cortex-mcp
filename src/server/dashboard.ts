/**
 * Cortex Web Dashboard — Simple localhost HTTP server for viewing memories.
 * 
 * Starts on port 3456 (or CORTEX_PORT env var).
 * Access at: http://localhost:3456
 * 
 * Features:
 * - View all active memories grouped by type
 * - Search memories
 * - Health check status
 * - Export JSON download
 */
import * as http from 'http';
import { MemoryStore } from '../db/memory-store';
import { getRateLimitStats } from '../security/rate-limiter';

const PORT = parseInt(process.env.CORTEX_PORT || '3456', 10);

export function startDashboard(memoryStore: MemoryStore): void {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', `http://localhost:${PORT}`);

        // CORS — wildcard is safe here since dashboard runs on localhost only
        res.setHeader('Access-Control-Allow-Origin', '*');

        if (url.pathname === '/api/memories') {
            return apiMemories(res, memoryStore, url);
        } else if (url.pathname === '/api/health') {
            return apiHealth(res, memoryStore);
        } else if (url.pathname === '/api/export') {
            return apiExport(res, memoryStore);
        } else {
            return serveDashboard(res, memoryStore);
        }
    });

    server.listen(PORT, '127.0.0.1', () => {
        console.log(`[cortex-mcp] Dashboard: http://localhost:${PORT}`);
    });

    server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`[cortex-mcp] Dashboard port ${PORT} in use, skipping.`);
        }
    });
}

function apiMemories(res: http.ServerResponse, store: MemoryStore, url: URL) {
    const type = url.searchParams.get('type');
    const query = url.searchParams.get('q');
    let memories = store.getActive(200);

    if (type && type !== 'ALL') {
        memories = memories.filter(m => m.type === type);
    }
    if (query) {
        const q = query.toLowerCase();
        memories = memories.filter(m => m.intent.toLowerCase().includes(q));
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(memories.map(m => ({
        id: m.id,
        type: m.type,
        intent: m.intent,
        reason: m.reason,
        tags: m.tags,
        confidence: m.confidence,
        importance: m.importance,
        accessCount: m.accessCount,
        createdAt: m.createdAt,
        age: Math.floor((Date.now() - m.createdAt) / (24 * 60 * 60 * 1000)) + 'd',
    }))));
}

function apiHealth(res: http.ServerResponse, store: MemoryStore) {
    const stats = getRateLimitStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'healthy',
        activeMemories: store.activeCount(),
        ...stats,
    }));
}

function apiExport(res: http.ServerResponse, store: MemoryStore) {
    const memories = store.getActive(5000);
    const bundle = {
        version: 1,
        exportedAt: new Date().toISOString(),
        memoryCount: memories.length,
        memories: memories.map(m => ({
            id: m.id, type: m.type, intent: m.intent, action: m.action,
            reason: m.reason, tags: m.tags, confidence: m.confidence,
            importance: m.importance, createdAt: m.createdAt,
        })),
    };
    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="cortex-memories.json"',
    });
    res.end(JSON.stringify(bundle, null, 2));
}

function serveDashboard(res: http.ServerResponse, store: MemoryStore) {
    const memories = store.getActive(200);
    const types = ['CORRECTION', 'DECISION', 'CONVENTION', 'BUG_FIX', 'INSIGHT'];
    const emoji: Record<string, string> = {
        CORRECTION: '🔴', DECISION: '🔵', CONVENTION: '🟢',
        BUG_FIX: '🟠', INSIGHT: '🟣',
    };

    const grouped = types.map(type => {
        const items = memories.filter(m => m.type === type);
        return { type, emoji: emoji[type] || '⚪', items };
    }).filter(g => g.items.length > 0);

    const stats = getRateLimitStats();

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🧠 Cortex Memory Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0a0a0f; color: #e0e0e0; min-height: 100vh;
        }
        .header {
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
            padding: 2rem; border-bottom: 1px solid #2a2a4a;
        }
        .header h1 { font-size: 1.8rem; color: #fff; }
        .header .stats { display: flex; gap: 2rem; margin-top: 1rem; flex-wrap: wrap; }
        .stat { background: rgba(255,255,255,0.05); padding: 0.8rem 1.2rem; border-radius: 8px; }
        .stat-value { font-size: 1.5rem; font-weight: bold; color: #60a5fa; }
        .stat-label { font-size: 0.75rem; color: #888; text-transform: uppercase; }
        .container { max-width: 1200px; margin: 0 auto; padding: 2rem; }
        .search { 
            width: 100%; padding: 0.8rem 1.2rem; background: #1a1a2e;
            border: 1px solid #2a2a4a; border-radius: 8px; color: #fff;
            font-size: 1rem; margin-bottom: 2rem; outline: none;
        }
        .search:focus { border-color: #60a5fa; }
        .type-section { margin-bottom: 2rem; }
        .type-header { 
            font-size: 1.2rem; margin-bottom: 0.8rem; padding-bottom: 0.5rem;
            border-bottom: 1px solid #2a2a4a; 
        }
        .memory-card {
            background: #12121a; border: 1px solid #2a2a4a; border-radius: 8px;
            padding: 1rem; margin-bottom: 0.5rem; transition: border-color 0.2s;
        }
        .memory-card:hover { border-color: #60a5fa; }
        .memory-intent { font-weight: 500; color: #fff; }
        .memory-meta { font-size: 0.75rem; color: #666; margin-top: 0.4rem; }
        .memory-id { font-family: monospace; color: #4a4a6a; }
        .memory-reason { font-style: italic; color: #888; font-size: 0.85rem; margin-top: 0.3rem; }
        .actions { margin-top: 1rem; display: flex; gap: 0.5rem; }
        .btn { 
            padding: 0.5rem 1rem; background: #1a1a2e; border: 1px solid #2a2a4a;
            border-radius: 6px; color: #60a5fa; cursor: pointer; font-size: 0.85rem;
            text-decoration: none; transition: all 0.2s;
        }
        .btn:hover { background: #60a5fa; color: #000; }
        .empty { text-align: center; padding: 4rem; color: #4a4a6a; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🧠 Cortex Memory Dashboard</h1>
        <div class="stats">
            <div class="stat">
                <div class="stat-value">${memories.length}</div>
                <div class="stat-label">Active Memories</div>
            </div>
            <div class="stat">
                <div class="stat-value">${stats.storeCount}/30</div>
                <div class="stat-label">Session Stores</div>
            </div>
            <div class="stat">
                <div class="stat-value">${Math.floor(stats.uptime / 60)}m</div>
                <div class="stat-label">Uptime</div>
            </div>
            <div class="stat">
                <div class="stat-value">✅</div>
                <div class="stat-label">Status</div>
            </div>
        </div>
    </div>
    <div class="container">
        <input class="search" type="text" placeholder="🔍 Search memories..." oninput="filterMemories(this.value)">
        <div class="actions">
            <a class="btn" href="/api/export" download>📦 Export JSON</a>
            <a class="btn" href="/api/health">🏥 Health API</a>
        </div>
        <br>
        ${grouped.length === 0 ? '<div class="empty"><h2>No memories yet</h2><p>Start using Cortex and memories will appear here.</p></div>' : ''}
        ${grouped.map(g => `
            <div class="type-section" data-type="${g.type}">
                <div class="type-header">${g.emoji} ${g.type} (${g.items.length})</div>
                ${g.items.map(m => {
        const age = Math.floor((Date.now() - m.createdAt) / (24 * 60 * 60 * 1000));
        const accessed = m.accessCount > 0 ? ` · accessed ${m.accessCount}x` : '';
        return `
                    <div class="memory-card" data-search="${m.intent.toLowerCase()}">
                        <div class="memory-intent">${m.intent}</div>
                        ${m.reason ? `<div class="memory-reason">${m.reason}</div>` : ''}
                        <div class="memory-meta">
                            <span class="memory-id">${m.id}</span> · ${age}d old${accessed}
                            · confidence: ${(m.confidence * 100).toFixed(0)}%
                        </div>
                    </div>`;
    }).join('')}
            </div>
        `).join('')}
    </div>
    <script>
        function filterMemories(q) {
            const cards = document.querySelectorAll('.memory-card');
            const ql = q.toLowerCase();
            cards.forEach(c => {
                c.style.display = c.dataset.search.includes(ql) ? '' : 'none';
            });
        }
    </script>
</body>
</html>`;

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
}
