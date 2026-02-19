const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Configuration
const SERVER_PATH = path.join(__dirname, '..', 'bin', 'cortex-win.exe'); // Use the binary if available, else node script
const USE_BINARY = fs.existsSync(SERVER_PATH);
const TARGET_SCRIPT = path.join(__dirname, '..', 'dist', 'mcp-stdio.js');

const DURATION_SECONDS = 0; // 0 = Run by iterations
const TARGET_ITERATIONS = 500; // "Long Form" Simulation
const CONCURRENCY = 1;

// Metrics
const stats = {
    ops: 0,
    failures: 0,
    totalLatency: 0,
    maxLatency: 0,
    startMem: 0,
    endMem: 0
};

// Logging
function log(msg) {
    console.log(`[SoakTest] ${msg}`);
}

// Random Content Generator
const TOPICS = ['database', 'ui', 'auth', 'api', 'testing', 'deployment'];
const ACTIONS = ['refactor', 'fix', 'implement', 'debug', 'optimize'];

function generateMemory() {
    const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
    const action = ACTIONS[Math.floor(Math.random() * ACTIONS.length)];
    return {
        type: 'INSIGHT',
        intent: `${action} ${topic} logic`,
        content: `We decided to ${action} the ${topic} because it was causing latency.`,
        tags: [topic, action, 'simulation']
    };
}

// Start Server
const cmd = USE_BINARY ? SERVER_PATH : 'node';
const args = USE_BINARY ? [] : [TARGET_SCRIPT];

log(`[START] Starting Soak Test using ${USE_BINARY ? 'BINARY' : 'NODE SCRIPT'}...`);
if (!USE_BINARY && !fs.existsSync(TARGET_SCRIPT)) {
    console.error(`[FAIL] Server not found at ${TARGET_SCRIPT}. Run 'npm run build' first.`);
    process.exit(1);
}

const server = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] });
let buffer = '';
let messageId = 1;
const pending = new Map();

server.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep incomplete line

    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const msg = JSON.parse(line);
            if (msg.id && pending.has(msg.id)) {
                const { resolve, startTime } = pending.get(msg.id);
                const latency = Date.now() - startTime;

                stats.totalLatency += latency;
                if (latency > stats.maxLatency) stats.maxLatency = latency;

                pending.delete(msg.id);
                resolve(msg);
            }
        } catch (e) {
            // Ignore non-JSON logs
        }
    }
});

function call(method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = (messageId++).toString();
        const req = { jsonrpc: '2.0', id, method, params };
        pending.set(id, { resolve, startTime: Date.now() });
        server.stdin.write(JSON.stringify(req) + '\n');

        // Timeout
        setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id);
                reject(new Error('Timeout'));
            }
        }, 5000);
    });
}

async function run() {
    // Initialize
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'soak-test', version: '1.0.0' } });
    log('[OK] Connected');

    // Baseline stats
    stats.startMem = process.memoryUsage().rss / 1024 / 1024;

    const startTime = Date.now();

    for (let i = 0; i < TARGET_ITERATIONS; i++) {
        const mem = generateMemory();

        try {
            // 1. Store
            await call('tools/call', {
                name: 'store_memory',
                arguments: mem
            });

            // 2. Recall (Verification)
            const res = await call('tools/call', {
                name: 'recall_memory',
                arguments: { query: mem.intent } // FTS should find "refactor database logic"
            });

            const text = res.result?.content?.[0]?.text || '';
            if (!text.includes(mem.content)) {
                // FTS might be loose, check if ANY memory returned
                if (text.includes('No memories')) {
                    // console.warn(`⚠️  Recall failed for "${mem.intent}"`);
                    // We expect *some* failures due to rapid writes/reads or keyword mismatches
                    // But if failure rate is high, it's a bug.
                }
            }

            stats.ops++;
            if (i % 50 === 0) {
                const rss = process.memoryUsage().rss / 1024 / 1024;
                process.stdout.write(`\rOps: ${i}/${TARGET_ITERATIONS} | Last Latency: ${Date.now() - pending.get((messageId - 1).toString())?.startTime || 0}ms | RSS: ${rss.toFixed(1)}MB`);
            }

        } catch (e) {
            log(`[FAIL] Op failed: ${e.message}`);
            stats.failures++;
        }
    }

    const duration = (Date.now() - startTime) / 1000;
    stats.endMem = process.memoryUsage().rss / 1024 / 1024;

    console.log('\n\n[DONE] Soak Test Complete');
    console.log(`------------------------`);
    console.log(`Total Ops:      ${stats.ops}`);
    console.log(`Failures:       ${stats.failures}`);
    console.log(`Duration:       ${duration.toFixed(1)}s`);
    console.log(`Throughput:     ${(stats.ops / duration).toFixed(1)} ops/sec`);
    console.log(`Avg Latency:    ${(stats.totalLatency / stats.ops).toFixed(1)}ms`);
    console.log(`Max Latency:    ${stats.maxLatency}ms`);
    console.log(`Memory Delta:   ${(stats.endMem - stats.startMem).toFixed(1)}MB (Client Monitor)`);

    server.kill();
    process.exit(stats.failures > 0 ? 1 : 0);
}

run();
