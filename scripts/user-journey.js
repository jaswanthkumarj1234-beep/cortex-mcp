const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Configuration
const SERVER_PATH = path.join(__dirname, '..', 'dist', 'mcp-stdio.js');
const PROJECT_ROOT = path.resolve(__dirname, '..');

// State
let server;
let buffer = '';
let step = 0;
let messageId = 1;
const requestMap = new Map();

// Logging
function log(icon, msg) {
    console.log(`${icon} [User Journey] ${msg}`);
}

// Start Server
if (!fs.existsSync(SERVER_PATH)) {
    console.error(`[FAIL] Server not found at ${SERVER_PATH}`);
    process.exit(1);
}

// Clean up previous runs (force fresh DB)
const dataDir = path.join(PROJECT_ROOT, '.ai', 'brain-data');
if (fs.existsSync(dataDir)) {
    log('🧹', 'Cleaning up previous DB...');
    fs.rmSync(dataDir, { recursive: true, force: true });
}

log('🚀', 'Starting Cortex MCP Server...');
server = spawn('node', [SERVER_PATH], { stdio: ['pipe', 'pipe', 'inherit'] });

server.stdout.on('data', (data) => {
    buffer += data.toString();
    processBuffer();
});

// JSON-RPC Handling
function processBuffer() {
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const msg = JSON.parse(line);
            handleMessage(msg);
        } catch (e) {
            console.error('[FAIL] Failed to parse:', line);
        }
    }
}

function send(method, params = {}) {
    const id = (messageId++).toString();
    const req = { jsonrpc: '2.0', id, method, params };
    requestMap.set(id, method);
    // log('📤', `${method} (${id})`);
    server.stdin.write(JSON.stringify(req) + '\n');
    return id;
}

// The "Real World" Script
async function handleMessage(msg) {
    // Handle Responses
    if (msg.id && requestMap.has(msg.id)) {
        const method = requestMap.get(msg.id);

        if (msg.error) {
            log('[FAIL]', `${method} FAILED: ${msg.error.message}`);
            process.exit(1);
        }

        switch (method) {
            case 'initialize':
                log('[OK]', 'Connected to Cortex Brain');
                // Step 1: Scan the project (The "Day 1" experience)
                log('[SCAN]', 'Step 1: Scannning Project Structure...');
                send('tools/call', {
                    name: 'scan_project',
                    arguments: { workspaceRoot: PROJECT_ROOT }
                });
                break;

            case 'tools/call':
                // Identify which tool was called by checking the sequence or result content
                // Since requestMap just stores 'tools/call', we need context.

                if (step === 0) { // Result of scan_project
                    log('[OK]', 'Project Scan Complete');
                    // log('📄', `Scan Output: ${msg.result.content[0].text.slice(0, 100)}...`);

                    // Step 2: User asks a question -> store a memory
                    log('[STEP]', 'Step 2: User makes a decision (Storing Memory)...');
                    step = 1;
                    send('tools/call', {
                        name: 'store_memory',
                        arguments: {
                            type: 'DECISION',
                            content: 'We selected SQLite for the database because of its zero-config deployment and local-first architecture.',
                            tags: ['architecture', 'database']
                        }
                    });
                }
                else if (step === 1) { // Result of store_memory
                    log('[OK]', 'Memory Stored');

                    // Step 3: User asks "Why did we choose SQLite?" (Recall)
                    log('[SEARCH]', 'Step 3: User asks "sqlite database" (Recalling)...');
                    step = 2;
                    send('tools/call', {
                        name: 'recall_memory',
                        arguments: {
                            query: 'sqlite database'
                        }
                    });
                }
                else if (step === 2) { // Result of recall_memory
                    const text = msg.result.content[0].text;
                    if (text.includes('zero-config deployment')) {
                        log('[OK]', 'Recall Successful! Found the memory.');
                        // log('💡', `Retrieved: ${text.slice(0, 150)}...`);
                    } else {
                        log('[FAIL]', 'Recall FAILED. Memory not found.');
                        log('[ERR]', `Got: ${text}`);
                        process.exit(1);
                    }

                    // Step 4: Auto-learning from conversation
                    log('[BOT]', 'Step 4: Auto-Learning form response...');
                    step = 3;
                    send('tools/call', {
                        name: 'auto_learn',
                        arguments: {
                            text: 'We should also use WAL mode for concurrency performance in SQLite.'
                        }
                    });
                }
                else if (step === 3) { // Result of auto_learn
                    log('[OK]', 'Auto-Learn Complete');

                    // Verify the auto-learned memory
                    log('[SEARCH]', 'Step 5: Verifying Auto-Learned Memory...');
                    step = 4;
                    send('tools/call', {
                        name: 'recall_memory',
                        arguments: { query: 'WAL mode' }
                    });
                }
                else if (step === 4) { // Result of verification
                    const text = msg.result.content[0].text;
                    if (text.includes('WAL mode')) {
                        log('[OK]', 'Verification Successful! Auto-learner worked.');
                        log('[PASS]', 'REAL WORLD USER JOURNEY PASSED');
                        process.exit(0);
                    } else {
                        log('[FAIL]', 'Auto-Learn Verification FAILED.');
                        process.exit(1);
                    }
                }
                break;
        }
    }
}

// Start
send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'user-journey', version: '1.0.0' }
});

// Timeout
setTimeout(() => {
    log('[FAIL]', 'TIMEOUT - Test took too long');
    process.exit(1);
}, 30000); // 30s timeout (scanning might take time)
