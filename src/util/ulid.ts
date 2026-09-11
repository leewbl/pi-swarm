/**
 * Monotonic ULID generator (Crockford base32, 26 chars).
 *
 * Within one process, IDs generated during the same millisecond strictly
 * increase, which keeps per-instance event streams and claim ids ordered.
 */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(time: number): string {
  let out = "";
  for (let i = 9; i >= 0; i--) {
    out = ENCODING[time % 32] + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function randomBytes(count: number): number[] {
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) out[i] = Math.floor(Math.random() * 32);
  return out;
}

function increment(chars: number[]): boolean {
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] < 31) {
      chars[i]++;
      return false;
    }
    chars[i] = 0;
  }
  return true; // overflow: entire random space consumed within one ms
}

let lastTime = -1;
let lastRandom: number[] = [];

export function ulid(time: number = Date.now()): string {
  if (time === lastTime) {
    const overflow = increment(lastRandom);
    if (overflow) {
      // Extremely unlikely; bump to the next millisecond.
      lastTime = time + 1;
      lastRandom = randomBytes(16);
    }
  } else {
    lastTime = time;
    lastRandom = randomBytes(16);
  }
  return (
    encodeTime(lastTime) +
    lastRandom.map((c) => ENCODING[c]).join("")
  );
}
