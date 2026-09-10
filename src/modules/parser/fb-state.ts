import fs from 'fs';
import path from 'path';

export interface FBGroupState {
    lastCheckedAt: number;
    currentIntervalMs: number;
    recentPostIds: string[]; // sliding window of 50 ids
    pendingQueue: string[]; // post URLs waiting to be processed
}

const STATE_FILE = path.join(process.cwd(), 'data', 'fb_groups_state.json');

export function loadGroupState(groupId: string): FBGroupState {
    let stateMap: Record<string, FBGroupState> = {};
    if (fs.existsSync(STATE_FILE)) {
        try {
            stateMap = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        } catch (e) {
            console.warn("Failed to parse fb_groups_state.json", e);
        }
    }
    
    return stateMap[groupId] || {
        lastCheckedAt: 0,
        currentIntervalMs: 5 * 60 * 1000, // 5 min
        recentPostIds: [],
        pendingQueue: []
    };
}

export function saveGroupState(groupId: string, state: FBGroupState) {
    let stateMap: Record<string, FBGroupState> = {};
    if (fs.existsSync(STATE_FILE)) {
        try {
            stateMap = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        } catch (e) {}
    }
    stateMap[groupId] = state;
    fs.writeFileSync(STATE_FILE, JSON.stringify(stateMap, null, 2));
}
