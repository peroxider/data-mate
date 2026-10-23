import { resolve } from 'node:path';
import { applyRuntimePatches } from './runtime-patches.js';

const args = process.argv.slice(2);
const index = args.indexOf('--profile');
const profile = index >= 0 ? args[index + 1] : undefined;
if (!profile || args.some((arg, i) => arg !== '--apply' && arg !== '--profile' && i !== index + 1)) {
  throw new Error('Usage: tsx tools/apply-runtime-patches.ts --profile <installed-profile> [--apply]');
}
console.log(JSON.stringify({ apply: args.includes('--apply'), profile: resolve(profile), files: applyRuntimePatches(resolve(profile), args.includes('--apply')) }, null, 2));
