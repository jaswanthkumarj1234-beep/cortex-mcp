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
    // 1. List tools
    const r1 = await handleMCPRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    console.log('TOOLS (' + r1.result.tools.length + '):', r1.result.tools.map(t => t.name).join(', '));

    // 2. force_recall
    const r2 = await handleMCPRequest({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'force_recall', arguments: { topic: 'MCP protocol' } }
    });
    console.log('\n=== FORCE RECALL OUTPUT ===');
    console.log(r2.result.content[0].text);

    console.log('\n--- DONE ---');
    db.close();
}

test().catch(err => { console.error('FAILED:', err.message); db.close(); });
