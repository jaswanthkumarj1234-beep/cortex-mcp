const path = require('path');
const root = path.join(__dirname, '..');
const { createMCPHandler } = require(path.join(root, 'dist/server/mcp-handler'));
const { CognitiveDatabase } = require(path.join(root, 'dist/db/database'));
const { EventLog } = require(path.join(root, 'dist/db/event-log'));
const { MemoryStore } = require(path.join(root, 'dist/db/memory-store'));

const dataDir = path.join(root, '.ai', 'brain-data');
const db = new CognitiveDatabase(dataDir);
const el = new EventLog(db);
const ms = new MemoryStore(db);
const { handleMCPRequest } = createMCPHandler(ms, el, root);

async function test() {
    const r1 = await handleMCPRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    console.log('TOOLS (' + r1.result.tools.length + '):', r1.result.tools.map(t => t.name).join(', '));

    // Test quick_store with different types
    const tests = [
        "Never use var in this project, always use const or let",
        "Fixed the login crash when user has no profile picture",
        "Always format dates as YYYY-MM-DD in this codebase",
        "Use Prisma ORM for all database queries",
        "The auth module handles JWT tokens for session management",
    ];

    console.log('\n=== QUICK STORE TESTS ===');
    for (let i = 0; i < tests.length; i++) {
        const r = await handleMCPRequest({
            jsonrpc: '2.0', id: 10 + i, method: 'tools/call',
            params: { name: 'quick_store', arguments: { memory: tests[i] } }
        });
        console.log(r.result.content[0].text);
    }

    console.log('\n--- DONE ---');
    db.close();
}

test().catch(err => { console.error('FAILED:', err.message); db.close(); });
