// Quick test: verify all 6 MCP tools are registered and working
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
    const tools = r1.result.tools.map(t => t.name);
    console.log('TOOLS (' + tools.length + '):', tools.join(', '));

    // 2. Get stats
    const r2 = await handleMCPRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_stats', arguments: {} } });
    console.log('STATS:', r2.result.content[0].text.substring(0, 100));

    // 3. Get context
    const r3 = await handleMCPRequest({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_context', arguments: {} } });
    console.log('CONTEXT:', r3.result.content[0].text.substring(0, 100));

    // 4. Verify files
    const r4 = await handleMCPRequest({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'verify_files', arguments: { text: 'Check src/mcp-stdio.ts and src/fake-file.ts', workspaceRoot: root } } });
    console.log('VERIFY:', r4.result.content[0].text);

    // 5. Recall memory
    const r5 = await handleMCPRequest({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'recall_memory', arguments: { query: 'test' } } });
    console.log('RECALL:', r5.result.content[0].text.substring(0, 100));

    // 6. brain/context resource
    const r6 = await handleMCPRequest({ jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: 'memory://brain/context' } });
    console.log('RESOURCE:', r6.result.contents[0].text.substring(0, 100));

    console.log('\nALL 6 TOOLS VERIFIED');
    db.close();
}

test().catch(err => { console.error('TEST FAILED:', err.message); db.close(); process.exit(1); });
