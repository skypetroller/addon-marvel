#!/usr/bin/env node
// Bumps the patch version in manifest.json and package.json so Stremio clients
// re-sync after the updater commits new content. Safe to run manually.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const manifestPath = path.join(root, 'manifest.json');
const packagePath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');

const manifest = readJson(manifestPath);
const match = String(manifest.version || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!match) {
  console.error('Could not find a semver "version" in manifest.json');
  process.exit(1);
}

const newVersion = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
manifest.version = newVersion;
writeJson(manifestPath, manifest);

const pkg = readJson(packagePath);
pkg.version = newVersion;
writeJson(packagePath, pkg);

if (fs.existsSync(lockPath)) {
  const lock = readJson(lockPath);
  lock.version = newVersion;
  if (lock.packages && lock.packages['']) lock.packages[''].version = newVersion;
  writeJson(lockPath, lock);
}

console.log(`Bumped version to ${newVersion}`);
