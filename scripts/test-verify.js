// Test verify_code: checks imports, exports, and env vars
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

const fakeCode = `
import { MemoryStore } from './src/db/memory-store';
import { FakeClass } from './src/db/memory-store';
import { qualityCheck } from './src/memory/memory-quality';
import { nonExistentFunc } from './src/memory/memory-quality';
import * as path from 'path';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import fakePackage from 'non-existent-lib-xyz';
import betterSqlite from 'better-sqlite3';

const dbUrl = process.env.DATABASE_URL;
const apiKey = process.env.API_KEY;
const nodeEnv = process.env.NODE_ENV;
`;

async function test() {
    // 1. List tools — should have 7 now
    const r1 = await handleMCPRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = r1.result.tools.map(t => t.name);
    console.log('TOOLS (' + tools.length + '):', tools.join(', '));

    // 2. verify_code
    const r2 = await handleMCPRequest({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'verify_code', arguments: { code: fakeCode, workspaceRoot: root } }
    });
    console.log('\n' + r2.result.content[0].text);

    console.log('\n--- TEST COMPLETE ---');
    db.close();
}

test().catch(err => { console.error('FAILED:', err.message); db.close(); process.exit(1); });
