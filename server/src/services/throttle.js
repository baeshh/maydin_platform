// 실패 횟수만 세는 메모리 제한기. 서버를 다시 켜면 초기화되므로 계정 잠금은 DB(pin_failed_count)로 따로 한다.
const buckets = new Map();

function bucket(key, windowMs) {
  const now = Date.now();
  let entry = buckets.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs };
    buckets.set(key, entry);
  }
  return entry;
}

function failures(key, windowMs) {
  return bucket(key, windowMs).count;
}

function recordFailure(key, windowMs) {
  bucket(key, windowMs).count += 1;
}

function blocked(key, limit, windowMs) {
  return bucket(key, windowMs).count >= limit;
}

function minutesLeft(key, windowMs) {
  return Math.max(1, Math.ceil((bucket(key, windowMs).resetAt - Date.now()) / 60000));
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) if (entry.resetAt <= now) buckets.delete(key);
}, 10 * 60 * 1000).unref();

module.exports = { failures, recordFailure, blocked, minutesLeft };
