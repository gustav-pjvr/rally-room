import { readFileSync } from 'node:fs';
import type { Vector } from '../../src/shared/swing';

/**
 * Raw samples from a lab CSV. This recording was made while the phone page
 * sent rotation as [beta, gamma, alpha], so the rx, ry, rz columns are put
 * back into alpha, beta, gamma order, which is x, y, z on that phone.
 */
export function loadRecording(path: string) {
  return readFileSync(path, 'utf8').trim().split('\n').slice(1)
    .map((line) => line.split(','))
    .filter((cells) => cells[0] === 'raw')
    .map((cells) => cells.slice(2).map(Number))
    .map((r) => ({ t: r[0], accel: [r[2], r[3], r[4]] as Vector, rotation: [r[10], r[8], r[9]] as Vector }));
}
