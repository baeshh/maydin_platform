import { createRequire } from 'node:module';
import { api, check, done, login, uniquePhone } from './lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH);

const owner = await login('owner@apharmacy.kr', 'owner1234');
const admin = await login('admin@maydin.kr', 'admin1234');
const REQUIRED = { TERMS: true, PRIVACY: true };

function signup(body) {
  return api('/auth/customer/signup', { method: 'POST', body: { pharmacyCode: 'A001', name: '테스트', phone: uniquePhone(), ...body } });
}

console.log('[가입 검증]');
{
  let res = await signup({});
  check('필수 동의 없이 가입하면 400', res.status === 400, res.data);
  res = await signup({ consents: { TERMS: true } });
  check('개인정보 동의 빠지면 400', res.status === 400, res.data);
  res = await signup({ consents: REQUIRED, phone: '0212345678' });
  check('휴대폰 형식 오류 400', res.status === 400, res.data);
  res = await signup({ consents: REQUIRED, name: '  ' });
  check('이름 비면 400', res.status === 400, res.data);
  res = await signup({ consents: REQUIRED, birth_month: 2, birth_day: 30 });
  check('2월 30일 생일 400', res.status === 400, res.data);
  res = await signup({ consents: REQUIRED, birth_month: 5 });
  check('생일 월만 입력하면 400', res.status === 400, res.data);
  res = await signup({ consents: REQUIRED, gender: 'X' });
  check('성별 값 오류 400', res.status === 400, res.data);
  res = await signup({ consents: REQUIRED, birth_year: 1800 });
  check('출생연도 범위 오류 400', res.status === 400, res.data);
  res = await signup({ consents: { ...REQUIRED, MARKETING_NIGHT: true } });
  check('야간 수신만 동의하면 400', res.status === 400, res.data);
  res = await signup({ consents: { ...REQUIRED, UNKNOWN: true } });
  check('알 수 없는 동의 항목 400', res.status === 400, res.data);
  res = await signup({ consents: REQUIRED, referral_code: 'ZZZZZZ' });
  check('없는 추천 코드 400', res.status === 400, res.data);
}

console.log('[가입 경로 QR]');
let channel;
{
  let res = await api('/qrcodes/channels', { token: owner });
  check('경로 목록 조회', res.status === 200 && res.data.channels[0].channel_type === 'BASIC', res.data);
  res = await api('/qrcodes/channels', { token: owner, method: 'POST', body: { name: '10월 전단', channel_type: 'FLYER', memo: '아파트 단지' } });
  check('경로 QR 생성 201', res.status === 201 && /^[a-z0-9]{8}$/.test(res.data.channel.code), res.data);
  channel = res.data.channel;
  res = await api('/qrcodes/channels', { token: owner, method: 'POST', body: { name: '10월 전단', channel_type: 'FLYER' } });
  check('같은 이름 409', res.status === 409, res.data);
  res = await api('/qrcodes/channels', { token: owner, method: 'POST', body: { name: '', channel_type: 'FLYER' } });
  check('이름 없으면 400', res.status === 400, res.data);
  res = await api('/qrcodes/channels', { token: owner, method: 'POST', body: { name: '잘못된 유형', channel_type: 'TV' } });
  check('유형 오류 400', res.status === 400, res.data);

  res = await api('/pharmacies/by-code/A001/scan', { method: 'POST', body: { channel: channel.code } });
  check('경로 스캔 응답에 경로 이름', res.status === 200 && res.data.channel?.name === '10월 전단', res.data);
  await api('/pharmacies/by-code/A001/scan', { method: 'POST', body: { channel: channel.code } });
  await api('/pharmacies/by-code/A001/scan', { method: 'POST', body: {} });
  res = await api('/pharmacies/by-code/A001/scan', { method: 'POST', body: { channel: 'nope1234' } });
  check('없는 경로 코드 스캔도 200', res.status === 200 && res.data.channel === null, res.data);
}

console.log('[가입 · 동의 기록]');
let referrer;
let referred;
{
  const phone = uniquePhone();
  let res = await signup({
    phone,
    name: '추천인',
    consents: { ...REQUIRED, MARKETING_SMS: true, MARKETING_NIGHT: true },
    birth_month: 2,
    birth_day: 29,
    birth_year: 1985,
    gender: 'f',
    channel: channel.code.toUpperCase()
  });
  check('선택 정보 포함 가입 201', res.status === 201, res.data);
  referrer = res.data.token;

  res = await api('/customers/me', { token: referrer });
  const me = res.data.customer;
  check('내 정보 조회', res.status === 200 && me.birth_month === 2 && me.birth_day === 29 && me.gender === 'F' && me.birth_year === 1985, me);
  check('추천 코드 6자리 발급', /^[A-Z2-9]{6}$/.test(me.referral_code), me.referral_code);
  check('가입 경로 기록', me.signup_channel_name === '10월 전단', me);
  const c = res.data.consents;
  check('필수 동의 기록', c.TERMS.agreed && c.PRIVACY.agreed && c.TERMS.source === 'SIGNUP', c);
  check('문자·야간 동의, 알림톡 미동의 기록', c.MARKETING_SMS.agreed && c.MARKETING_NIGHT.agreed && !c.MARKETING_KAKAO.agreed && c.MARKETING_KAKAO.recorded, c);
  check('제3자 제공은 기록 없음', !c.THIRD_PARTY.recorded, c.THIRD_PARTY);
  const row = db.prepare('SELECT marketing_agree FROM customers WHERE id = ?').get(me.id);
  check('marketing_agree 동기화', row.marketing_agree === 1, row);

  res = await signup({ phone, consents: REQUIRED });
  check('같은 번호 재가입 409', res.status === 409, res.data);

  res = await signup({ name: '피추천인', consents: REQUIRED, referral_code: me.referral_code.toLowerCase() });
  check('추천 코드로 가입 (소문자도 허용)', res.status === 201, res.data);
  referred = res.data.token;
  res = await api('/customers/me', { token: referred });
  check('추천인 연결', res.data.customer.referrer_name === '추천인', res.data.customer);
  check('경로 없이 가입하면 기본 링크', res.data.customer.signup_channel_name === null, res.data.customer);
  check('마케팅 미동의 시 marketing_agree 0', db.prepare('SELECT marketing_agree FROM customers WHERE id = ?').get(res.data.customer.id).marketing_agree === 0);

  res = await api('/customers/me', { token: referrer });
  check('추천한 회원 수 1', res.data.customer.referred_count === 1, res.data.customer);

  res = await signup({ consents: REQUIRED, marketing_agree: true });
  const legacy = await api('/customers/me', { token: res.data.token });
  check('예전 marketing_agree 필드는 문자 수신 동의로 기록', legacy.data.consents.MARKETING_SMS.agreed, legacy.data.consents);
}

console.log('[경로 통계]');
{
  const res = await api('/qrcodes/channels', { token: owner });
  const flyer = res.data.channels.find((ch) => ch.id === channel.id);
  check('경로 스캔 2회 · 가입 1명', flyer.scan_count === 2 && flyer.member_count === 1 && flyer.signup_rate === 50, flyer);
  const basic = res.data.channels[0];
  check('기본 링크 가입은 경로 없는 회원', basic.member_count >= 2, basic);

  let patch = await api(`/qrcodes/channels/${channel.id}`, { token: owner, method: 'PATCH', body: { status: 'INACTIVE' } });
  check('경로 사용 중지', patch.status === 200 && patch.data.channels.find((ch) => ch.id === channel.id).status === 'INACTIVE', patch.data);
  const signupAfter = await signup({ consents: REQUIRED, channel: channel.code });
  const meAfter = await api('/customers/me', { token: signupAfter.data.token });
  check('중지된 경로로 가입하면 기본 링크로 집계', signupAfter.status === 201 && meAfter.data.customer.signup_channel_name === null, meAfter.data.customer);
  patch = await api(`/qrcodes/channels/${channel.id}`, { token: owner, method: 'PATCH', body: { status: 'ACTIVE', name: '10월 전단(수정)' } });
  check('경로 이름 수정 · 다시 사용', patch.status === 200 && patch.data.channels.find((ch) => ch.id === channel.id).name === '10월 전단(수정)', patch.data);
}

console.log('[고객 본인 수정]');
{
  let res = await api('/customers/me/profile', { token: referred, method: 'PATCH', body: { birth_month: 12 } });
  check('월만 저장하면 400', res.status === 400, res.data);
  res = await api('/customers/me/profile', { token: referred, method: 'PATCH', body: { birth_month: 12, birth_day: 25, gender: 'M' } });
  check('생일·성별 저장', res.status === 200 && res.data.customer.birth_day === 25 && res.data.customer.gender === 'M', res.data);
  res = await api('/customers/me/profile', { token: referred, method: 'PATCH', body: { gender: '' } });
  check('성별 지우기', res.status === 200 && res.data.customer.gender === null && res.data.customer.birth_month === 12, res.data);
  res = await api('/customers/me/profile', { token: referred, method: 'PATCH', body: {} });
  check('빈 수정 400', res.status === 400, res.data);

  res = await api('/customers/me/consents', { token: referred, method: 'PATCH', body: { consents: { PRIVACY: false } } });
  check('앱에서 필수 동의 철회 불가', res.status === 400, res.data);
  res = await api('/customers/me/consents', { token: referred, method: 'PATCH', body: { consents: { MARKETING_KAKAO: true, MARKETING_NIGHT: true } } });
  check('앱에서 알림톡·야간 동의', res.status === 200 && res.data.consents.MARKETING_KAKAO.agreed && res.data.consents.MARKETING_KAKAO.source === 'APP', res.data);
  res = await api('/customers/me/consents', { token: referred, method: 'PATCH', body: { consents: { MARKETING_KAKAO: false } } });
  check('알림톡 철회하면 야간도 자동 철회', res.status === 200 && !res.data.consents.MARKETING_NIGHT.agreed, res.data.consents);
  const before = db.prepare('SELECT COUNT(*) AS n FROM customer_consents').get().n;
  res = await api('/customers/me/consents', { token: referred, method: 'PATCH', body: { consents: { MARKETING_KAKAO: false } } });
  const after = db.prepare('SELECT COUNT(*) AS n FROM customer_consents').get().n;
  check('값이 같으면 이력 추가 안 함', res.status === 200 && before === after, { before, after });

  res = await api('/customers/me', { token: owner });
  check('파트너는 고객 본인 API 사용 불가', res.status === 403, res.data);
}

console.log('[파트너 회원 관리]');
{
  const me = (await api('/customers/me', { token: referrer })).data.customer;
  let res = await api(`/customers/${me.id}`, { token: owner });
  check('회원 상세 조회', res.status === 200 && res.data.customer.referred_count === 1 && res.data.consent_history.length >= 5, res.data);

  res = await api(`/customers/${me.id}/consents/withdraw`, { token: owner, method: 'POST', body: { types: ['PRIVACY'] } });
  check('파트너는 필수 동의 철회 불가', res.status === 400, res.data);
  res = await api(`/customers/${me.id}/consents/withdraw`, { token: owner, method: 'POST', body: { types: ['MARKETING_SMS'] } });
  check('고객 요청 철회 대행', res.status === 200 && !res.data.consents.MARKETING_SMS.agreed && res.data.consents.MARKETING_SMS.source === 'PARTNER', res.data);
  check('문자 철회로 야간도 철회', !res.data.consents.MARKETING_NIGHT.agreed, res.data.consents);
  check('marketing_agree 0으로 동기화', db.prepare('SELECT marketing_agree FROM customers WHERE id = ?').get(me.id).marketing_agree === 0);
  const log = db.prepare("SELECT * FROM admin_logs WHERE action = 'CONSENT_WITHDRAW' AND target_id = ?").get(me.id);
  check('철회 대행 감사 로그', Boolean(log), log);

  res = await api(`/customers/${me.id}/consents/notice`, { token: owner, method: 'POST' });
  check('마케팅 동의 없으면 재확인 안내 400', res.status === 400, res.data);

  res = await api(`/customers/${me.id}/profile`, { token: owner, method: 'PATCH', body: { birth_year: 1986 } });
  check('파트너 선택 정보 수정', res.status === 200 && res.data.customer.birth_year === 1986, res.data);

  res = await api('/customers/999999', { token: owner });
  check('없는 회원 404', res.status === 404, res.data);
  res = await api(`/customers/${me.id}`, { token: referred });
  check('고객은 회원 상세 조회 불가', res.status === 403, res.data);
}

console.log('[2년 재확인 대상]');
{
  const signupRes = await signup({ name: '오래된동의', consents: { ...REQUIRED, MARKETING_SMS: true, MARKETING_KAKAO: true } });
  const me = (await api('/customers/me', { token: signupRes.data.token })).data.customer;
  db.prepare("UPDATE customer_consents SET created_at = datetime('now', '-23 months', '-10 days') WHERE customer_id = ?").run(me.id);

  let res = await api('/customers/consent-renewals', { token: owner });
  let entry = res.data.renewals.find((r) => r.id === me.id);
  check('23개월 지난 동의는 재확인 대상', res.status === 200 && entry && entry.consent_types.length === 2, res.data);

  res = await api(`/customers/${me.id}/consents/notice`, { token: owner, method: 'POST' });
  check('재확인 안내 기록', res.status === 200 && res.data.written.length === 2 && res.data.consents.MARKETING_SMS.source === 'NOTICE', res.data);
  res = await api('/customers/consent-renewals', { token: owner });
  entry = res.data.renewals.find((r) => r.id === me.id);
  check('안내 후 대상에서 빠짐', !entry, res.data);
}

console.log('[권한]');
{
  let res = await api('/qrcodes/channels?pharmacyId=1', { token: admin });
  check('관리자는 약국 지정해서 경로 조회', res.status === 200, res.data);
  res = await api('/qrcodes/channels', { method: 'GET' });
  check('비로그인 401', res.status === 401, res.data);
}

done();
