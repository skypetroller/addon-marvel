#!/usr/bin/env node
// Stamps the current time into Data/lastUpdated.json on every updater run.
// /health and the configure page use it to show how fresh the data is.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(__dirname, '..', 'Data', 'lastUpdated.json');
const payload = { updatedAt: new Date().toISOString() };

fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Stamped Data/lastUpdated.json with ${payload.updatedAt}`);
