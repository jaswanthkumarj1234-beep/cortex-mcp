#!/usr/bin/env node
/**
 * Mock LLM Server — Simulates OpenAI chat completions API.
 * No API key needed. Used to test the proxy end-to-end.
 *
 * Responds to POST /v1/chat/completions with a fake response.
 * Also echoes back the system prompt so we can verify context injection.
 *
 * Usage: node scripts/mock-llm.js
 * Then set BRAIN_UPSTREAM_URL=http://localhost:9999/v1 before starting Brain.
 */
const http = require('http');

const PORT = 9999;

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            object: 'list',
            data: [{ id: 'mock-gpt-4', object: 'model', created: Date.now() }],
        }));
        return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            const messages = body.messages || [];

            // Find system message (injected context)
            const systemMsg = messages.find(m => m.role === 'system');
            const userMsg = messages.find(m => m.role === 'user');

            const systemContent = systemMsg?.content || '';
            const hasInjectedContext = systemContent.includes('MEMORY CONTEXT') ||
                systemContent.includes('MISTAKES TO AVOID') ||
                systemContent.includes('ACTIVE DECISIONS') ||
                systemContent.includes('CODE CONVENTIONS');

            // Build response that reflects what we saw
            let responseText = `[Mock LLM Response]\n`;
            responseText += `User asked: "${userMsg?.content || 'nothing'}"\n`;
            responseText += `System prompt length: ${systemContent.length} chars\n`;
            responseText += `Context injected: ${hasInjectedContext ? 'YES' : 'NO'}\n`;

            if (hasInjectedContext) {
                // Count how many memories were injected
                const memoryLines = systemContent.split('\n').filter(l =>
                    l.startsWith('- ') || l.startsWith('• ') || l.match(/^\d+\./)
                );
                responseText += `Memories in context: ~${memoryLines.length}\n`;
                responseText += `\nFirst 200 chars of system prompt:\n${systemContent.substring(0, 200)}...\n`;
            }

            // Respond in OpenAI format
            const response = {
                id: `chatcmpl-mock-${Date.now()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: body.model || 'mock-gpt-4',
                choices: [{
                    index: 0,
                    message: { role: 'assistant', content: responseText },
                    finish_reason: 'stop',
                }],
                usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
            };

            console.log(`  📨 ${body.model} | user: "${(userMsg?.content || '').substring(0, 50)}..." | context: ${hasInjectedContext ? 'YES' : 'NO'} (${systemContent.length} chars)`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
        });
        return;
    }

    // Fallback
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n[OK] Mock LLM Server running on http://localhost:${PORT}/v1`);
    console.log('   Simulates OpenAI chat completions API');
    console.log('   Set BRAIN_UPSTREAM_URL=http://localhost:9999/v1 before starting Brain\n');
});
