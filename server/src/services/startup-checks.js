const { db } = require('../db');
const { activeSeedAccounts, demoPharmacy } = require('./account-audit');
const { describeTestPayments, environmentProblem, isStaging, testPaymentSummary } = require('./payment-policy');
const { isProduction } = require('./secrets');
const { hasColumn, undecryptableColumns } = require('./secure');

// 운영에서 막아야 할 문제는 errors, 알려 줄 것은 warnings로 돌려준다.
// 마이그레이션이 새 키로 암호문을 쓰기 전에 부른다. 처음 만드는 DB(테이블 없음)도 견딘다.
function startupProblems() {
  const errors = [];
  const warnings = [];
  const production = isProduction();

  const broken = undecryptableColumns(db);
  if (broken.length) {
    (production ? errors : warnings).push(
      `DATA_ENCRYPTION_KEY로 기존 암호문(${broken.join(', ')})을 풀 수 없습니다. 이 DB를 암호화할 때 쓴 키를 넣어 주세요.`
    );
  }

  const environment = environmentProblem(db);
  if (environment) errors.push(environment);

  if (production && hasColumn(db, 'users', 'email')) {
    for (const account of activeSeedAccounts(db)) {
      errors.push(`초기 계정 ${account.email}(${account.role})이 공개된 비밀번호 그대로 사용 중입니다. \`npm run security:check -- --disable-default-accounts\`로 막은 뒤 다시 시작해 주세요.`);
    }
    const demo = demoPharmacy(db);
    if (demo) warnings.push(`데모 약국(${demo.pharmacy_code} ${demo.pharmacy_name})이 운영 DB에 있습니다. 실제 약국이 아니라면 정리해 주세요.`);
  }

  if (production && !isStaging()) {
    const testPayments = testPaymentSummary(db);
    if (testPayments.length) {
      warnings.push(
        `운영 DB에 실제 돈이 오가지 않은 데모·테스트 결제가 있습니다: ${describeTestPayments(testPayments)}. ` +
          '이 판매는 매출·재고·출고 내보내기에 잡혀 있습니다. docs/payment-test-policy.md의 정리 절차를 따라 주세요.'
      );
    }
  }
  if (isStaging()) warnings.push('스테이징 서버(MAYDIN_STAGING=true)입니다. 데모·테스트 결제를 받으므로 이 DB의 매출·재고는 실제가 아닙니다.');
  return { errors, warnings };
}

module.exports = { startupProblems };
