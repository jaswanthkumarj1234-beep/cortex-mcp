#!/usr/bin/env node
/**
 * End-to-End Test — Proves context injection through the proxy.
 * 
 * 1. Starts a mock LLM on port 9998
 * 2. Sends a chat completion through the Brain proxy (port 9741)
 * 3. Mock LLM echoes back whether context was injected
 * 4. Validates the response
 *
 * Requirements: Cortex running with BRAIN_UPSTREAM_URL=http://localhost:9998/v1
 */
const http = require('http');

let mockServer;
let receivedSystemPrompt = '';
let receivedUserMessage = '';

function startMock() {
    return new Promise((resolve) => {
        mockServer = http.createServer((req, res) => {
            if (req.method === 'POST' && req.url === '/v1/chat/completions') {
                const chunks = [];
                req.on('data', c => chunks.push(c));
                req.on('end', () => {
                    const body = JSON.parse(Buffer.concat(chunks).toString());
                    const msgs = body.messages || [];
                    const sys = msgs.find(m => m.role === 'system');
                    const usr = msgs.find(m => m.role === 'user');
                    receivedSystemPrompt = sys?.content || '';
                    receivedUserMessage = usr?.content || '';

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        id: 'e2e-test',
                        object: 'chat.completion',
                        created: Math.floor(Date.now() / 1000),
                        model: body.model,
                        choices: [{
                            index: 0,
                            message: { role: 'assistant', content: 'E2E test response' },
                            finish_reason: 'stop',
                        }],
                        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                    }));
                });
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{"ok":true}');
            }
        });
        mockServer.listen(9998, '127.0.0.1', () => resolve());
    });
}

function request(port, method, path, body, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : undefined;
        const req = http.request({
            hostname: '127.0.0.1', port, path, method,
            headers: {
                'Content-Type': 'application/json',
                ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
            },
            timeout: timeoutMs,
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString();
                try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
                catch { resolve({ status: res.statusCode, body: text }); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        if (data) req.write(data);
        req.end();
    });
}

let passed = 0, failed = 0;
function test(name, ok, detail) {
    if (ok) { passed++; console.log(`  \u2705 ${name}`); }
    else { failed++; console.log(`  \u274C ${name}${detail ? ` \u2014 ${detail}` : ''}`); }
}

async function run() {
    console.log('\n\uD83D\uDD17 End-to-End Context Injection Test\n');

    // Start mock LLM
    await startMock();
    console.log('  Mock LLM on port 9998\n');

    // Send chat through proxy
    try {
        const resp = await request(9741, 'POST', '/v1/chat/completions', {
            model: 'gpt-4',
            messages: [{ role: 'user', content: 'How should I handle authentication in this project?' }],
            stream: false,
        });

        // Test 1: Proxy returned a response
        test('Proxy returns response', resp.status === 200);
        test('Response has choices', resp.body?.choices?.length > 0);
        test('Response has assistant message', resp.body?.choices?.[0]?.message?.role === 'assistant');

        // Test 2: Check what the mock received
        test('Mock received user message', receivedUserMessage.includes('authentication'));
        test('System prompt has content', receivedSystemPrompt.length > 50, `length: ${receivedSystemPrompt.length}`);

        // Test 3: Context was injected
        const has_context = receivedSystemPrompt.includes('MEMORY CONTEXT') ||
            receivedSystemPrompt.includes('MISTAKES TO AVOID') ||
            receivedSystemPrompt.includes('ACTIVE DECISIONS') ||
            receivedSystemPrompt.includes('CODE CONVENTIONS') ||
            receivedSystemPrompt.includes('RELEVANT PAST CONTEXT');
        test('Context was INJECTED into system prompt', has_context);

        // Show what was injected
        if (receivedSystemPrompt.length > 0) {
            console.log(`\n  --- Injected System Prompt (${receivedSystemPrompt.length} chars) ---`);
            const lines = receivedSystemPrompt.split('\n');
            // Show headers and first few items
            for (const line of lines.slice(0, 25)) {
                console.log(`  | ${line}`);
            }
            if (lines.length > 25) {
                console.log(`  | ... (${lines.length - 25} more lines)`);
            }
            console.log('  ---\n');
        }

        // Test 4: Specific context checks
        test('Has memory section marker', receivedSystemPrompt.includes('==='));
        const memoryCount = (receivedSystemPrompt.match(/^- /gm) || []).length;
        test(`Contains memory items (found ${memoryCount})`, memoryCount > 0);

    } catch (e) {
        test('Proxy round-trip', false, e.message);
    }

    // Cleanup
    mockServer.close();

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`  TOTAL: ${passed + failed} | ✅ ${passed} | ❌ ${failed}`);
    console.log(`${'═'.repeat(50)}\n`);

    process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
