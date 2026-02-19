#!/usr/bin/env node
/**
 * Self-test — Pure HTTP test, no project imports needed.
 * Validates all Cortex endpoints are working correctly.
 *
 * Usage: node dist/test/self-test.js
 * Requires: Cortex running on ports 9741 (proxy) + 9742/9743 (MCP)
 */
const http = require('http');

const PROXY_PORT = 9741;
let MCP_PORT = 9742;
let passed = 0;
let failed = 0;

function request(port, method, path, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : undefined;
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
            },
            timeout: 5000,
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString();
                try {
                    resolve({ status: res.statusCode || 0, body: JSON.parse(text) });
                } catch (e) {
                    resolve({ status: res.statusCode || 0, body: text });
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        if (data) req.write(data);
        req.end();
    });
}

function test(name, ok, detail) {
    if (ok) {
        passed++;
        console.log(`  \u2705 ${name}`);
    } else {
        failed++;
        console.log(`  \u274C ${name}${detail ? ` \u2014 ${detail}` : ''}`);
    }
}

async function run() {
    console.log('\n\uD83E\uDDEA Cortex Self-Test\n');

    // Detect MCP port — test resources/list as fingerprint (new code only)
    try {
        const r = await request(MCP_PORT, 'POST', '/', {
            jsonrpc: '2.0', id: 0, method: 'resources/list',
        });
        const resources = r.body?.result?.resources || [];
        if (resources.length === 0) throw new Error('no resources');
    } catch {
        MCP_PORT = 9743;
        console.log('  (Using MCP port 9743)');
    }

    // === PROXY TESTS ===
    console.log('--- Proxy (port ' + PROXY_PORT + ') ---');

    try {
        const r = await request(PROXY_PORT, 'GET', '/health');
        test('Proxy health check', r.status === 200 && r.body?.name === 'cortex-proxy');
        test('Proxy reports memories', r.body?.memories > 0, `memories: ${r.body?.memories}`);
        test('Proxy mode is context-injection', r.body?.mode === 'context-injection');
    } catch (e) {
        test('Proxy health check', false, e.message);
    }

    // === MCP TESTS ===
    console.log('\n--- MCP Server (port ' + MCP_PORT + ') ---');

    try {
        const r = await request(MCP_PORT, 'GET', '/');
        test('MCP health check', r.status === 200 && r.body?.status === 'running');
        test('MCP reports memories', r.body?.memories > 0, `memories: ${r.body?.memories}`);
    } catch (e) {
        test('MCP health check', false, e.message);
    }

    // tools/list
    try {
        const r = await request(MCP_PORT, 'POST', '/', {
            jsonrpc: '2.0', id: 1, method: 'tools/list',
        });
        const tools = r.body?.result?.tools || [];
        test('tools/list returns 3 tools', tools.length === 3);
        test('Has recall_memory', tools.some(t => t.name === 'recall_memory'));
        test('Has store_memory', tools.some(t => t.name === 'store_memory'));
    } catch (e) {
        test('tools/list', false, e.message);
    }

    // resources/list
    try {
        const r = await request(MCP_PORT, 'POST', '/', {
            jsonrpc: '2.0', id: 2, method: 'resources/list',
        });
        const resources = r.body?.result?.resources || [];
        test('resources/list returns resources', resources.length >= 1);
        test('Has brain/context resource', resources.some(r => r.uri === 'memory://brain/context'));
    } catch (e) {
        test('resources/list', false, e.message);
    }

    // resources/read
    try {
        const r = await request(MCP_PORT, 'POST', '/', {
            jsonrpc: '2.0', id: 3, method: 'resources/read',
            params: { uri: 'memory://brain/context' },
        });
        const text = r.body?.result?.contents?.[0]?.text || '';
        test('resources/read returns context', text.length > 10);
        test('Context contains Brain header', text.includes('Brain Context'));
    } catch (e) {
        test('resources/read', false, e.message);
    }

    // === QUALITY GATE TESTS ===
    console.log('\n--- Quality Gate ---');

    // Should REJECT: too short
    try {
        const r = await request(MCP_PORT, 'POST', '/', {
            jsonrpc: '2.0', id: 4, method: 'tools/call',
            params: { name: 'store_memory', arguments: { type: 'INSIGHT', content: 'hi' } },
        });
        test('Rejects too-short memory', r.body?.result?.isError === true);
    } catch (e) {
        test('Rejects too-short memory', false, e.message);
    }

    // Should REJECT: too generic
    try {
        const r = await request(MCP_PORT, 'POST', '/', {
            jsonrpc: '2.0', id: 5, method: 'tools/call',
            params: { name: 'store_memory', arguments: { type: 'INSIGHT', content: 'use best practices' } },
        });
        test('Rejects generic memory', r.body?.result?.isError === true);
    } catch (e) {
        test('Rejects generic memory', false, e.message);
    }

    // Should ACCEPT: good memory
    try {
        const unique = `selftest-${Date.now()}`;
        const r = await request(MCP_PORT, 'POST', '/', {
            jsonrpc: '2.0', id: 6, method: 'tools/call',
            params: {
                name: 'store_memory',
                arguments: {
                    type: 'DECISION',
                    content: `Self-test: using PostgreSQL for persistent data (${unique})`,
                },
            },
        });
        test('Accepts good memory', !r.body?.result?.isError);
        const text = r.body?.result?.content?.[0]?.text || '';
        test('Returns memory ID', text.includes('ID:'));
    } catch (e) {
        test('Accepts good memory', false, e.message);
    }

    // === RECALL TESTS ===
    console.log('\n--- Recall ---');

    try {
        const r = await request(MCP_PORT, 'POST', '/', {
            jsonrpc: '2.0', id: 7, method: 'tools/call',
            params: { name: 'recall_memory', arguments: { query: 'authentication bug login' } },
        });
        test('recall_memory succeeds', !r.body?.result?.isError);
        const text = r.body?.result?.content?.[0]?.text || '';
        test('recall returns content', text.length > 20);
    } catch (e) {
        test('recall_memory', false, e.message);
    }

    // === STATS ===
    console.log('\n--- Stats ---');

    try {
        const r = await request(MCP_PORT, 'POST', '/', {
            jsonrpc: '2.0', id: 8, method: 'tools/call',
            params: { name: 'get_stats', arguments: {} },
        });
        const stats = JSON.parse(r.body?.result?.content?.[0]?.text || '{}');
        test('get_stats returns activeMemories', stats.activeMemories > 0);
        test('get_stats returns totalMemories', stats.totalMemories > 0);
    } catch (e) {
        test('get_stats', false, e.message);
    }

    // === SUMMARY ===
    console.log(`\n${'='.repeat(45)}`);
    console.log(`  Total: ${passed + failed} | \u2705 Passed: ${passed} | \u274C Failed: ${failed}`);
    console.log(`${'='.repeat(45)}\n`);

    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('  Self-test crashed:', err.message);
    process.exit(1);
});
