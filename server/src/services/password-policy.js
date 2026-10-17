// 저장소(예전 init.js·화면 기본값)에 공개된 비밀번호. 새로 정하는 비밀번호로는 받지 않는다.
const KNOWN_DEFAULT_PASSWORDS = ['admin1234', 'owner1234'];

function passwordProblem(password, { minLength = 8 } = {}) {
  const value = String(password || '');
  if (value.length < minLength) return `비밀번호는 ${minLength}자 이상이어야 합니다.`;
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return '비밀번호는 영문과 숫자를 함께 사용해 주세요.';
  if (KNOWN_DEFAULT_PASSWORDS.includes(value.toLowerCase())) return '알려진 초기 비밀번호는 쓸 수 없습니다. 다른 비밀번호를 정해 주세요.';
  return null;
}

module.exports = { KNOWN_DEFAULT_PASSWORDS, passwordProblem };
