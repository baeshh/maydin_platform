export const BASE = process.env.BASE || 'http://127.0.0.1:3001';

let passed = 0;
let failed = 0;

export async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

export async function login(email, password) {
  const { status, data } = await api('/auth/login', { method: 'POST', body: { email, password } });
  if (status !== 200) throw new Error(`로그인 실패: ${email} (${status})`);
  return data.token;
}

export function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` → ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  }
}

export function done() {
  console.log(`  ${passed} 통과, ${failed} 실패`);
  if (failed) process.exit(1);
}

export function uniquePhone() {
  return `010${String(Date.now() % 1e8).padStart(8, '0').slice(-4)}${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`;
}
