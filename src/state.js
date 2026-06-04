import fs from 'node:fs';
import path from 'node:path';

const statePath = path.resolve(process.cwd(), 'state.json');

export function loadState() {
    if (fs.existsSync(statePath)) {
        try {
            return JSON.parse(fs.readFileSync(statePath, 'utf8'));
        } catch (_e) {
            console.error('Gagal mem-parsing state.json, membuat ulang...');
        }
    }
    return {};
}

export function saveState(state) {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}
