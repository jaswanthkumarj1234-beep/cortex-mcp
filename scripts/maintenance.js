const path = require('path');
const root = path.join(__dirname, '..');
const { CognitiveDatabase } = require(path.join(root, 'dist/db/database'));
const { MemoryStore } = require(path.join(root, 'dist/db/memory-store'));

const dataDir = path.join(root, '.ai', 'brain-data');
const db = new CognitiveDatabase(dataDir);
const ms = new MemoryStore(db);

async function runMaintenance() {
    console.log('Starting Cortex Maintenance...');

    // 1. Rebuild FTS Index
    console.log('Rebuilding FTS index...');
    try {
        ms.rebuildIndex();
        console.log('[OK] FTS index rebuilt successfully.');
    } catch (err) {
        console.error('[FAIL] Error rebuilding index:', err.message);
    }

    // 2. Clean Junk Memories
    console.log('Cleaning junk memories...');
    const junkPatterns = [
        "The Complete Truth — Every LLM Flaw",
        "ts` duplicated them because",
        "Fix Gateway \"Health Offline\" issue", // Example of random junk from previous context
        "Constraint violation: intent is required"
    ];

    let deletedCount = 0;
    const allMemories = ms.getActive(1000); // Get recent active memories

    for (const mem of allMemories) {
        for (const pattern of junkPatterns) {
            if (mem.intent.includes(pattern)) {
                console.log(`  - Deactivating junk memory: "${mem.intent.slice(0, 50)}..."`);
                ms.deactivate(mem.id);
                deletedCount++;
                break;
            }
        }
    }
    console.log(`✅ Deactivated ${deletedCount} junk memories.`);

    console.log('Maintenance complete.');
    db.close();
}

runMaintenance();
