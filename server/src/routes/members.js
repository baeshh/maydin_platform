const express = require('express');
const { run, transaction } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { sendCsv } = require('../services/csv');
const {
  GRADES,
  STATUSES,
  AMOUNT_TIERS,
  MemberError,
  memberPolicy,
  validatePolicy,
  savePolicy,
  memberList,
  memberMetrics,
  memberSummary,
  memberBehavior,
  filterMembers,
  sortMembers,
  labels
} = require('../services/members');

const router = express.Router();
const PAGE_SIZE = 30;

router.use(authenticate, requireRole('PHARMACY_OWNER'), (req, res, next) => {
  if (!req.user.pharmacy_id) return res.status(403).json({ message: '약국이 지정되지 않은 계정입니다.' });
  return next();
});

function fail(res, error, fallback = '회원 분석 중 오류가 발생했습니다.') {
  if (error instanceof MemberError) return res.status(error.status).json({ message: error.message });
  console.error(error);
  return res.status(500).json({ message: fallback });
}

router.get('/summary', (req, res) => {
  try {
    return res.json({ ...memberSummary(req.user.pharmacy_id), labels: labels() });
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/policy', (req, res) => {
  res.json({ policy: memberPolicy(req.user.pharmacy_id), labels: labels() });
});

router.patch('/policy', (req, res) => {
  try {
    const policy = validatePolicy(req.body || {}, memberPolicy(req.user.pharmacy_id));
    transaction(() => {
      savePolicy(req.user.pharmacy_id, policy, req.user.id);
      run(
        `INSERT INTO admin_logs (user_id, pharmacy_id, action, target_type, target_id, description)
         VALUES (@user_id, @pharmacy_id, 'MEMBER_POLICY', 'PHARMACY', @pharmacy_id, @description)`,
        {
          user_id: req.user.id,
          pharmacy_id: req.user.pharmacy_id,
          description: `회원 등급·혜택 기준 변경 · 실버 ${policy.silver_min} / 골드 ${policy.gold_min} / VIP ${policy.vip_min}`
        }
      );
    })();
    return res.json({ policy });
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/', (req, res) => {
  try {
    const filtered = sortMembers(filterMembers(memberList(req.user.pharmacy_id), req.query), req.query.sort);
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    return res.json({
      members: filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      total: filtered.length,
      page,
      page_size: PAGE_SIZE,
      labels: labels()
    });
  } catch (error) {
    return fail(res, error);
  }
});

const tierLabel = Object.fromEntries(AMOUNT_TIERS.map((t) => [t.key, t.label]));
const dateOnly = (value) => {
  if (!value) return '';
  const d = new Date(`${String(value).replace(' ', 'T')}Z`);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// 연락처는 마케팅 수신(문자 또는 알림톡)에 동의한 회원만 내보낸다.
router.get('/export.csv', (req, res) => {
  try {
    const members = sortMembers(filterMembers(memberList(req.user.pharmacy_id), req.query), req.query.sort);
    const rows = [
      [
        '회원코드', '이름', '연락처', '문자 수신', '알림톡 수신', '등급', '상태', '가입일', '가입 경로',
        '첫 구매일', '최근 구매일', '구매 횟수', '최근 12개월 순구매', '누적 순구매', '1회 평균 결제', '금액대',
        '월 평균 지출', '평균 구매 주기(일)', '보유 포인트', '생일', '연령대', '성별'
      ],
      ...members.map((m) => [
        m.member_code,
        m.name,
        m.marketing_agree ? m.phone : '(수신 미동의)',
        m.consent_sms ? '동의' : '미동의',
        m.consent_kakao ? '동의' : '미동의',
        GRADES[m.grade].label,
        STATUSES[m.status],
        dateOnly(m.created_at),
        m.signup_channel_name || '기본 가입 링크',
        dateOnly(m.first_purchase_at),
        dateOnly(m.last_purchase_at),
        m.visit_count,
        m.net_12m,
        m.net_total,
        m.avg_ticket ?? '',
        tierLabel[m.amount_tier] || '',
        m.monthly_spend,
        m.avg_interval_days ?? '',
        m.point_balance,
        m.birth_month ? `${m.birth_month}월 ${m.birth_day}일` : '',
        m.age_band || '',
        { F: '여성', M: '남성' }[m.gender] || ''
      ])
    ];
    run(
      `INSERT INTO admin_logs (user_id, pharmacy_id, action, target_type, target_id, description)
       VALUES (@user_id, @pharmacy_id, 'MEMBER_EXPORT', 'PHARMACY', @pharmacy_id, @description)`,
      {
        user_id: req.user.id,
        pharmacy_id: req.user.pharmacy_id,
        description: `회원 목록 CSV 다운로드 · ${members.length}명 (연락처 포함 ${members.filter((m) => m.marketing_agree).length}명)`
      }
    );
    const today = new Date().toISOString().slice(0, 10);
    return sendCsv(res, rows, { asciiName: `members-${today}.csv`, filename: `MAYDIN_회원목록_${today}.csv` });
  } catch (error) {
    return fail(res, error, 'CSV를 만드는 중 오류가 발생했습니다.');
  }
});

router.get('/:id', (req, res) => {
  try {
    const metrics = memberMetrics(req.user.pharmacy_id, Number(req.params.id));
    if (!metrics) throw new MemberError('회원을 찾을 수 없습니다.', 404);
    return res.json({ metrics, behavior: memberBehavior(req.user.pharmacy_id, metrics.id), labels: labels() });
  } catch (error) {
    return fail(res, error);
  }
});

module.exports = router;
