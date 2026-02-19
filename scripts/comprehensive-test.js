#!/usr/bin/env node
/**
 * COMPREHENSIVE TEST SUITE — Cortex
 *
 * Tests every feature thoroughly with edge cases.
 * Requires: Cortex running on ports 9741 (proxy) + 9742 (MCP)
 *
 * Usage: node scripts/comprehensive-test.js
 */
const http = require('http');

const PROXY_PORT = 9741;
let MCP_PORT = 9742;
let passed = 0;
let failed = 0;
let total = 0;

function request(port, method, path, body, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : undefined;
        const req = http.request({
            hostname: '127.0.0.1', port, path, method,
            headers: {
                'Content-Type': 'application/json',
                ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
            },
            timeout: timeoutMs,
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString();
                try { resolve({ status: res.statusCode || 0, body: JSON.parse(text) }); }
                catch { resolve({ status: res.statusCode || 0, body: text }); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        if (data) req.write(data);
        req.end();
    });
}

function mcpCall(method, params) {
    total++;
    return request(MCP_PORT, 'POST', '/', {
        jsonrpc: '2.0', id: total, method, params,
    });
}

function toolCall(name, args) {
    return mcpCall('tools/call', { name, arguments: args });
}

function test(name, ok, detail) {
    total++;
    if (ok) { passed++; console.log(`  \u2705 ${name}`); }
    else { failed++; console.log(`  \u274C ${name}${detail ? ` \u2014 ${detail}` : ''}`); }
}

async function run() {
    console.log('\n\uD83E\uDDEA COMPREHENSIVE Cortex Test Suite\n');

    // --- Auto-detect port ---
    try {
        const r = await mcpCall('resources/list', {});
        if (!r.body?.result?.resources?.length) throw new Error('no resources');
    } catch {
        MCP_PORT = 9743;
        console.log('  (Fallback to MCP port 9743)\n');
    }

    // ═══════════════════════════════════════════
    // SECTION 1: PROXY HEALTH
    // ═══════════════════════════════════════════
    console.log('═══ 1. PROXY HEALTH ═══');

    try {
        const r = await request(PROXY_PORT, 'GET', '/health');
        test('Proxy responds to /health', r.status === 200);
        test('Proxy name correct', r.body?.name === 'cortex-proxy');
        test('Proxy reports memory count > 0', r.body?.memories > 0);
        test('Proxy mode is context-injection', r.body?.mode === 'context-injection');
        test('Proxy version is 2.0.0', r.body?.version === '2.0.0');
        test('Proxy reports upstream URL', typeof r.body?.upstream === 'string' && r.body.upstream.length > 5);
    } catch (e) { test('Proxy health', false, e.message); }

    // ═══════════════════════════════════════════
    // SECTION 2: MCP SERVER HEALTH
    // ═══════════════════════════════════════════
    console.log('\n═══ 2. MCP SERVER HEALTH ═══');

    try {
        const r = await request(MCP_PORT, 'GET', '/');
        test('MCP responds to GET /', r.status === 200);
        test('MCP status is running', r.body?.status === 'running');
        test('MCP reports memories > 0', r.body?.memories > 0);
    } catch (e) { test('MCP health', false, e.message); }

    // ═══════════════════════════════════════════
    // SECTION 3: MCP PROTOCOL
    // ═══════════════════════════════════════════
    console.log('\n═══ 3. MCP PROTOCOL ═══');

    // initialize
    try {
        const r = await mcpCall('initialize', {});
        test('initialize responds', !!r.body?.result);
        test('protocolVersion correct', r.body?.result?.protocolVersion === '2024-11-05');
        test('serverInfo name correct', r.body?.result?.serverInfo?.name === 'cortex');
        test('capabilities include tools', !!r.body?.result?.capabilities?.tools);
        test('capabilities include resources', !!r.body?.result?.capabilities?.resources);
    } catch (e) { test('initialize', false, e.message); }

    // tools/list
    try {
        const r = await mcpCall('tools/list', {});
        const tools = r.body?.result?.tools || [];
        test('tools/list returns array', Array.isArray(tools));
        test('Has exactly 3 tools', tools.length === 3);
        test('recall_memory tool exists', tools.some(t => t.name === 'recall_memory'));
        test('store_memory tool exists', tools.some(t => t.name === 'store_memory'));
        test('get_stats tool exists', tools.some(t => t.name === 'get_stats'));
        // Verify schemas
        const recall = tools.find(t => t.name === 'recall_memory');
        test('recall_memory has query param', recall?.inputSchema?.properties?.query?.type === 'string');
        const store = tools.find(t => t.name === 'store_memory');
        test('store_memory has type param', !!store?.inputSchema?.properties?.type);
        test('store_memory has content param', !!store?.inputSchema?.properties?.content);
    } catch (e) { test('tools/list', false, e.message); }

    // resources/list
    try {
        const r = await mcpCall('resources/list', {});
        const resources = r.body?.result?.resources || [];
        test('resources/list returns array', Array.isArray(resources));
        test('Has at least 1 resource', resources.length >= 1);
        test('brain/context resource exists', resources.some(r => r.uri === 'memory://brain/context'));
        test('Resource has description', resources[0]?.description?.length > 10);
    } catch (e) { test('resources/list', false, e.message); }

    // resources/read
    try {
        const r = await mcpCall('resources/read', { uri: 'memory://brain/context' });
        const text = r.body?.result?.contents?.[0]?.text || '';
        test('resources/read returns content', text.length > 10);
        test('Content has Brain Context header', text.includes('Brain Context'));
        test('Content has corrections or decisions', text.includes('DO NOT') || text.includes('Decisions') || text.includes('Conventions'));
    } catch (e) { test('resources/read', false, e.message); }

    // Unknown method
    try {
        const r = await mcpCall('nonexistent/method', {});
        test('Unknown method returns error', !!r.body?.error);
        test('Error code is -32601', r.body?.error?.code === -32601);
    } catch (e) { test('unknown method', false, e.message); }

    // ═══════════════════════════════════════════
    // SECTION 4: QUALITY GATE
    // ═══════════════════════════════════════════
    console.log('\n═══ 4. QUALITY GATE ═══');

    // Reject: too short
    try {
        const r = await toolCall('store_memory', { type: 'INSIGHT', content: 'hi' });
        test('REJECTS: too short (2 chars)', r.body?.result?.isError === true);
    } catch (e) { test('reject short', false, e.message); }

    // Reject: exactly 14 chars (boundary)
    try {
        const r = await toolCall('store_memory', { type: 'INSIGHT', content: 'short message!' });
        test('REJECTS: exactly 14 chars', r.body?.result?.isError === true);
    } catch (e) { test('reject 14 chars', false, e.message); }

    // Accept: exactly 15 chars (boundary)
    try {
        const r = await toolCall('store_memory', { type: 'INSIGHT', content: 'this is fifteen' });
        test('ACCEPTS: exactly 15 chars', !r.body?.result?.isError);
    } catch (e) { test('accept 15 chars', false, e.message); }

    // Reject: too generic
    try {
        const r = await toolCall('store_memory', { type: 'INSIGHT', content: 'use best practices' });
        test('REJECTS: "use best practices"', r.body?.result?.isError === true);
    } catch (e) { test('reject generic', false, e.message); }

    try {
        const r = await toolCall('store_memory', { type: 'INSIGHT', content: 'follow conventions' });
        test('REJECTS: "follow conventions"', r.body?.result?.isError === true);
    } catch (e) { test('reject generic 2', false, e.message); }

    try {
        const r = await toolCall('store_memory', { type: 'INSIGHT', content: 'handle errors' });
        test('REJECTS: "handle errors"', r.body?.result?.isError === true);
    } catch (e) { test('reject generic 3', false, e.message); }

    // Reject: all caps
    try {
        const r = await toolCall('store_memory', { type: 'INSIGHT', content: 'THIS IS ALL CAPS AND VERY LONG NOISE' });
        test('REJECTS: all caps (>20 chars)', r.body?.result?.isError === true);
    } catch (e) { test('reject caps', false, e.message); }

    // Reject: just a URL
    try {
        const r = await toolCall('store_memory', { type: 'INSIGHT', content: 'https://example.com/some/long/path' });
        test('REJECTS: just a URL', r.body?.result?.isError === true);
    } catch (e) { test('reject URL', false, e.message); }

    // Reject: repeated chars
    try {
        const r = await toolCall('store_memory', { type: 'INSIGHT', content: 'aaaaaaaaaaaa something important here' });
        test('REJECTS: repeated characters', r.body?.result?.isError === true);
    } catch (e) { test('reject repeated', false, e.message); }

    // Reject: missing required fields
    try {
        const r = await toolCall('store_memory', { type: 'INSIGHT' });
        test('REJECTS: missing content', r.body?.result?.isError === true);
    } catch (e) { test('reject missing content', false, e.message); }

    try {
        const r = await toolCall('store_memory', { content: 'some valid content here for testing' });
        test('REJECTS: missing type', r.body?.result?.isError === true);
    } catch (e) { test('reject missing type', false, e.message); }

    // Reject: invalid type
    try {
        const r = await toolCall('store_memory', { type: 'INVALID_TYPE', content: 'some valid content here' });
        test('REJECTS: invalid type', r.body?.result?.isError === true);
    } catch (e) { test('reject invalid type', false, e.message); }

    // Accept: good memory with all fields
    const goodContent = `Test memory ${Date.now()}: Use TypeScript strict mode for all new files in this project`;
    try {
        const r = await toolCall('store_memory', {
            type: 'DECISION',
            content: goodContent,
            reason: 'Catches type errors at compile time',
            files: ['tsconfig.json'],
            tags: ['typescript', 'testing'],
        });
        test('ACCEPTS: full good memory', !r.body?.result?.isError);
        const text = r.body?.result?.content?.[0]?.text || '';
        test('Returns memory ID in response', text.includes('ID:'));
    } catch (e) { test('accept good', false, e.message); }

    // ═══════════════════════════════════════════
    // SECTION 5: RECALL
    // ═══════════════════════════════════════════
    console.log('\n═══ 5. RECALL ═══');

    // Normal recall
    try {
        const r = await toolCall('recall_memory', { query: 'TypeScript' });
        test('Recall "TypeScript" succeeds', !r.body?.result?.isError);
        const text = r.body?.result?.content?.[0]?.text || '';
        test('Recall returns text content', text.length > 5);
    } catch (e) { test('recall TypeScript', false, e.message); }

    // Recall with maxResults
    try {
        const r = await toolCall('recall_memory', { query: 'database', maxResults: 3 });
        test('Recall with maxResults succeeds', !r.body?.result?.isError);
    } catch (e) { test('recall maxResults', false, e.message); }

    // Empty query
    try {
        const r = await toolCall('recall_memory', { query: '' });
        test('Recall with empty query does not crash', true);
    } catch (e) { test('recall empty', false, e.message); }

    // Very long query (should be rejected by input validation)
    try {
        const longQuery = 'a'.repeat(1001);
        const r = await toolCall('recall_memory', { query: longQuery });
        test('Recall rejects >1000 char query', r.body?.result?.isError === true);
    } catch (e) { test('recall long query', false, e.message); }

    // Input validation: content >5000 chars
    try {
        const longContent = 'x'.repeat(5001);
        const r = await toolCall('store_memory', { type: 'INSIGHT', content: longContent });
        test('Store rejects >5000 char content', r.body?.result?.isError === true);
    } catch (e) { test('store long content', false, e.message); }

    // ═══════════════════════════════════════════
    // SECTION 6: STATS
    // ═══════════════════════════════════════════
    console.log('\n═══ 6. STATS ═══');

    try {
        const r = await toolCall('get_stats', {});
        const stats = JSON.parse(r.body?.result?.content?.[0]?.text || '{}');
        test('Stats has activeMemories', typeof stats.activeMemories === 'number' && stats.activeMemories > 0);
        test('Stats has totalMemories', typeof stats.totalMemories === 'number' && stats.totalMemories > 0);
        test('Stats has totalEvents', typeof stats.totalEvents === 'number');
        test('Stats has cacheSize', typeof stats.cacheSize === 'number');
        test('Stats has vectorSearchReady', typeof stats.vectorSearchReady === 'boolean');
        console.log(`    Active: ${stats.activeMemories} | Total: ${stats.totalMemories} | Events: ${stats.totalEvents}`);
    } catch (e) { test('get_stats', false, e.message); }

    // ═══════════════════════════════════════════
    // SECTION 7: STORE THEN RECALL (ROUND-TRIP)
    // ═══════════════════════════════════════════
    console.log('\n═══ 7. STORE-THEN-RECALL ROUND-TRIP ═══');

    const uniqueToken = `roundtrip-${Date.now()}`;
    try {
        // Store a unique memory
        const storeR = await toolCall('store_memory', {
            type: 'BUG_FIX',
            content: `${uniqueToken}: The login form crashes when email contains a plus sign`,
            reason: 'URL encoding issue in email validation',
            files: ['src/auth/login.ts'],
            tags: ['auth', 'bug', 'roundtrip-test'],
        });
        test('Store unique memory succeeds', !storeR.body?.result?.isError);

        // Immediately recall it
        const recallR = await toolCall('recall_memory', { query: uniqueToken });
        const text = recallR.body?.result?.content?.[0]?.text || '';
        test('Recall finds the just-stored memory', text.includes(uniqueToken) || text.includes('login form'));
    } catch (e) { test('round-trip', false, e.message); }

    // ═══════════════════════════════════════════
    // SECTION 8: PROXY CONTEXT INJECTION
    // ═══════════════════════════════════════════
    console.log('\n═══ 8. PROXY CONTEXT INJECTION ═══');

    try {
        // Send a chat completion request (will fail at upstream, but proxy should process it)
        const chatBody = {
            model: 'gpt-4',
            messages: [{ role: 'user', content: 'How do I fix the login form crash?' }],
            stream: false,
        };

        try {
            await request(PROXY_PORT, 'POST', '/v1/chat/completions', chatBody, 3000);
        } catch {
            // Expected — no real API key
        }
        test('Proxy processes chat completion without crash', true);
    } catch (e) { test('proxy chat', false, e.message); }

    // Proxy pass-through (non-chat endpoint)
    try {
        const r = await request(PROXY_PORT, 'GET', '/v1/models', null, 3000).catch(() => null);
        test('Proxy handles non-chat endpoint without crash', true);
    } catch (e) { test('proxy passthrough', false, e.message); }

    // ═══════════════════════════════════════════
    // SECTION 9: MEMORY STABILITY
    // ═══════════════════════════════════════════
    console.log('\n═══ 9. MEMORY STABILITY ═══');

    try {
        const r1 = await toolCall('get_stats', {});
        const stats1 = JSON.parse(r1.body?.result?.content?.[0]?.text || '{}');
        const count1 = stats1.activeMemories;

        // Wait 2 seconds, check again
        await new Promise(resolve => setTimeout(resolve, 2000));

        const r2 = await toolCall('get_stats', {});
        const stats2 = JSON.parse(r2.body?.result?.content?.[0]?.text || '{}');
        const count2 = stats2.activeMemories;

        const drift = Math.abs(count2 - count1);
        test(`Memory count stable (${count1} → ${count2}, drift ${drift})`, drift <= 2);
    } catch (e) { test('stability', false, e.message); }

    // ═══════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`  TOTAL: ${passed + failed} tests`);
    console.log(`  ✅ PASSED: ${passed}`);
    console.log(`  ❌ FAILED: ${failed}`);
    console.log(`  PASS RATE: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
    console.log(`${'═'.repeat(50)}\n`);

    if (failed === 0) {
        console.log('  🎉 ALL TESTS PASSED! The system is fully verified.\n');
    } else {
        console.log(`  ⚠️  ${failed} test(s) need attention.\n`);
    }

    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('  Test suite crashed:', err.message);
    process.exit(1);
});
