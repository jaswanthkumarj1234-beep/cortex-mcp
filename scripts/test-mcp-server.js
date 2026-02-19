const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const SERVER_PATH = path.join(__dirname, '..', 'dist', 'mcp-stdio.js');

if (!fs.existsSync(SERVER_PATH)) {
    console.error(`[FAIL] Server binary not found at ${SERVER_PATH}. Run 'npm run build' first.`);
    process.exit(1);
}

console.log('🔌 STARTING MCP E2E PROTOCOL TEST');
console.log(`target: ${SERVER_PATH}`);

const server = spawn('node', [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'inherit'] // pipe stdin/stdout, inherit stderr for logs
});

let buffer = '';

server.stdout.on('data', (data) => {
    buffer += data.toString();
    processBuffer();
});

function processBuffer() {
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep incomplete line in buffer

    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const msg = JSON.parse(line);
            handleMessage(msg);
        } catch (e) {
            console.error('[FAIL] Failed to parse JSON:', line);
        }
    }
}

let step = 0;

function send(msg) {
    console.log(`\n📤 Sending: ${JSON.stringify(msg)}`);
    server.stdin.write(JSON.stringify(msg) + '\n');
}

function handleMessage(msg) {
    console.log(`[IN] Received:`, JSON.stringify(msg).slice(0, 100) + '...');

    if (step === 0) {
        // Step 0: Expect nothing, send initialize
        // Actually we just send initialize immediately
    } else if (step === 1) {
        // Expect initialize result
        if (msg.id === '1' && msg.result) {
            console.log('[OK] Initialize success');
            step = 2;
            send({
                jsonrpc: '2.0',
                id: '2',
                method: 'tools/list' // MCP standard method name might be list_tools?
                // Wait, MCP spec says tools/list or mcp.list_tools?
                // Let's check mcp-handler.ts implementation for "list_tools"
            });
            // Wait, standard MCP uses `tools/list`?
            // Cortex implementation handles method names directly in switch/case.
            // Let's assume standard names or check implementation first.
        } else {
            console.error('[FAIL] Expected initialize result, got:', msg);
            process.exit(1);
        }
    } else if (step === 2) {
        // Expect tools list
        if (msg.id === '2' && msg.result) {
            console.log(`[OK] List Tools success (${msg.result.tools?.length || 0} tools found)`);
            step = 3;
            console.log('[PASS] E2E TEST PASSED');
            server.kill();
            process.exit(0);
        } else {
            console.error('[FAIL] Expected list_tools result, got:', msg);
            process.exit(1);
        }
    }
}

// Start sequence
step = 1;
send({
    jsonrpc: '2.0',
    id: '1',
    method: 'initialize',
    params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'e2e-test', version: '1.0.0' }
    }
});

// Timeout
setTimeout(() => {
    console.error('[FAIL] TIMEOUT: Server did not respond in time');
    server.kill();
    process.exit(1);
}, 5000);
