import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const file = join(resolve(import.meta.dirname, '..'), 'data', 'state.json');
if (existsSync(file)) {
  rmSync(file);
  console.log('Cleared saved house state. The residents will start fresh next time.');
} else {
  console.log('No saved state to clear.');
}
