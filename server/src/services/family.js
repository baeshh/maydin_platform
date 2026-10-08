const { getAll, getOne, run } = require('../db');
const { CustomerError, GENDERS } = require('./customers');

const RELATIONS = {
  SPOUSE: '배우자',
  CHILD: '자녀',
  PARENT: '부모',
  GRANDPARENT: '조부모',
  SIBLING: '형제자매',
  ETC: '기타'
};
const MAX_FAMILY = 8;
const CHILD_AGE_LIMIT = 12;

const ageOf = (birthYear, now = new Date()) => (birthYear ? now.getFullYear() - birthYear : null);

function familyRows(headId) {
  return getAll(
    `SELECT f.id, f.head_customer_id, f.linked_customer_id, f.name, f.relation, f.birth_year, f.gender, f.created_at,
            c.member_code AS linked_member_code, c.name AS linked_name
     FROM family_members f
     LEFT JOIN customers c ON c.id = f.linked_customer_id
     WHERE f.head_customer_id = @head_id
     ORDER BY f.id`,
    { head_id: headId }
  ).map((row) => ({ ...row, relation_label: RELATIONS[row.relation], age: ageOf(row.birth_year) }));
}

function linkedTo(customerId) {
  return getOne(
    `SELECT f.id, f.relation, h.id AS head_id, h.name AS head_name, h.member_code AS head_member_code
     FROM family_members f JOIN customers h ON h.id = f.head_customer_id
     WHERE f.linked_customer_id = @id`,
    { id: customerId }
  );
}

// 대표 회원과 연결된 회원의 12개월 순구매 합계. 등급·적립은 회원별로 따로 계산하고, 이 합계는 참고용이다.
function householdTotal(pharmacyId, headId) {
  return getOne(
    `SELECT COALESCE(SUM(o.final_amount), 0) AS net_12m, COUNT(DISTINCT o.customer_id) AS buyers
     FROM orders o
     WHERE o.pharmacy_id = @pharmacy_id AND o.order_type != 'COUNSEL' AND o.created_at >= datetime('now', '-12 months')
       AND (o.customer_id = @head_id
            OR o.customer_id IN (SELECT linked_customer_id FROM family_members WHERE head_customer_id = @head_id AND linked_customer_id IS NOT NULL))`,
    { pharmacy_id: pharmacyId, head_id: headId }
  );
}

function familyView(pharmacyId, customerId) {
  const parent = linkedTo(customerId);
  const members = familyRows(customerId);
  return {
    members,
    linked_to: parent ? { ...parent, relation_label: RELATIONS[parent.relation] } : null,
    household: members.some((m) => m.linked_customer_id) ? householdTotal(pharmacyId, customerId) : null,
    max: MAX_FAMILY
  };
}

function normalizeFamily(input, { partial = false } = {}) {
  const out = {};
  if (!partial || 'relation' in input) {
    const relation = String(input.relation || '').toUpperCase();
    if (!RELATIONS[relation]) throw new CustomerError('가족 관계를 선택해 주세요.');
    out.relation = relation;
  }
  if (!partial || 'name' in input) {
    const name = String(input.name || '').trim().replace(/\s+/g, ' ').slice(0, 20);
    if (name) out.name = name;
    else if (!partial) out.name = null;
    else throw new CustomerError('이름 또는 호칭을 입력해 주세요.');
  }
  if (!partial || 'birth_year' in input) {
    const raw = input.birth_year;
    if (raw === undefined || raw === null || raw === '') out.birth_year = null;
    else {
      const year = Number(raw);
      if (!Number.isInteger(year) || year < 1900 || year > new Date().getFullYear()) throw new CustomerError('출생연도를 확인해 주세요.');
      out.birth_year = year;
    }
  }
  if (!partial || 'gender' in input) {
    const gender = input.gender ? String(input.gender).toUpperCase() : null;
    if (gender && !GENDERS[gender]) throw new CustomerError('성별 값이 올바르지 않습니다.');
    out.gender = gender;
  }
  return out;
}

// 가족은 한 단계만 둔다. 다른 가족에 연결된 회원은 대표가 될 수 없고, 대표 회원은 다른 가족에 연결될 수 없다.
function addFamily({ pharmacyId, headId, input, linkedCustomerId = null, userId = null }) {
  const head = getOne('SELECT id FROM customers WHERE id = @id AND pharmacy_id = @pharmacy_id', { id: headId, pharmacy_id: pharmacyId });
  if (!head) throw new CustomerError('회원을 찾을 수 없습니다.', 404);
  if (linkedTo(headId)) throw new CustomerError('다른 가족에 연결된 회원입니다. 대표 회원 쪽에서 가족을 등록해 주세요.');
  const count = getOne('SELECT COUNT(*) AS n FROM family_members WHERE head_customer_id = @id', { id: headId }).n;
  if (count >= MAX_FAMILY) throw new CustomerError(`가족은 ${MAX_FAMILY}명까지 등록할 수 있습니다.`);

  const family = normalizeFamily(input);
  if (linkedCustomerId) {
    const linked = getOne('SELECT id, name, birth_year, gender FROM customers WHERE id = @id AND pharmacy_id = @pharmacy_id', {
      id: linkedCustomerId,
      pharmacy_id: pharmacyId
    });
    if (!linked) throw new CustomerError('연결할 회원을 찾을 수 없습니다.', 404);
    if (linked.id === headId) throw new CustomerError('본인은 가족으로 연결할 수 없습니다.');
    if (linkedTo(linked.id)) throw new CustomerError('이미 다른 가족에 연결된 회원입니다.', 409);
    if (getOne('SELECT 1 FROM family_members WHERE head_customer_id = @id', { id: linked.id })) {
      throw new CustomerError('가족을 등록해 둔 대표 회원은 다른 가족에 연결할 수 없습니다.', 409);
    }
    family.name = family.name || linked.name;
    family.birth_year = family.birth_year ?? linked.birth_year;
    family.gender = family.gender ?? linked.gender;
  }
  if (!family.name) throw new CustomerError('이름 또는 호칭을 입력해 주세요.');

  const result = run(
    `INSERT INTO family_members (pharmacy_id, head_customer_id, linked_customer_id, name, relation, birth_year, gender, created_by)
     VALUES (@pharmacy_id, @head_id, @linked_id, @name, @relation, @birth_year, @gender, @created_by)`,
    { pharmacy_id: pharmacyId, head_id: headId, linked_id: linkedCustomerId, ...family, created_by: userId }
  );
  return result.lastInsertRowid;
}

function familyEntry(headId, familyId) {
  const row = getOne('SELECT * FROM family_members WHERE id = @id AND head_customer_id = @head_id', { id: familyId, head_id: headId });
  if (!row) throw new CustomerError('가족 정보를 찾을 수 없습니다.', 404);
  return row;
}

function updateFamily(headId, familyId, input) {
  familyEntry(headId, familyId);
  const changes = normalizeFamily(input, { partial: true });
  const keys = Object.keys(changes);
  if (!keys.length) throw new CustomerError('변경할 내용이 없습니다.');
  run(`UPDATE family_members SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`, { ...changes, id: familyId });
}

function removeFamily(headId, familyId) {
  const row = familyEntry(headId, familyId);
  run('DELETE FROM family_members WHERE id = @id', { id: familyId });
  return row;
}

// 회원 분석 필터·POS 배지용: 대표 회원별 가족 관계 요약
function familyMap(pharmacyId) {
  const map = new Map();
  const rows = getAll('SELECT head_customer_id, relation, birth_year FROM family_members WHERE pharmacy_id = @pharmacy_id', {
    pharmacy_id: pharmacyId
  });
  for (const row of rows) {
    if (!map.has(row.head_customer_id)) map.set(row.head_customer_id, []);
    map.get(row.head_customer_id).push({ relation: row.relation, age: ageOf(row.birth_year) });
  }
  return map;
}

function familySummaryText(members) {
  return members.map((m) => `${RELATIONS[m.relation]}${m.age != null ? `(${m.age}세)` : ''}`).join(', ');
}

module.exports = {
  RELATIONS,
  MAX_FAMILY,
  CHILD_AGE_LIMIT,
  familyRows,
  familyView,
  linkedTo,
  addFamily,
  updateFamily,
  removeFamily,
  familyMap,
  familySummaryText
};
