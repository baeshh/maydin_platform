#!/usr/bin/env node
// 사용법
//   npm run backup                 지금 백업 만들기(서버가 켜져 있어도 됨)
//   npm run backup:status          백업·복구 훈련 기록 보기
//   npm run backup:verify [파일]    체크섬·무결성 검사(기본: 최신 백업)
//   npm run backup:drill [파일]     복구 훈련: 백업으로 임시 서버를 띄워 확인(기본: 최신 백업)
//   npm run backup:restore -- 파일  실제 복구(서버를 멈춘 뒤에만)
require('dotenv').config();
const backup = require('../src/services/backup');

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const [command = 'status', file] = process.argv.slice(2);
  if (command === 'backup') {
    const { db } = require('../src/db');
    const entry = await backup.createBackup(db, { reason: 'manual' });
    print(entry);
    return entry.ok;
  }
  if (command === 'verify') {
    const result = await backup.verifyBackup(file);
    print(result);
    return result.ok;
  }
  if (command === 'drill') {
    const drill = await backup.runRestoreDrill({ file });
    print(drill);
    return drill.ok;
  }
  if (command === 'restore') {
    const result = await backup.restoreBackup(file);
    print(result);
    console.log('\n복구가 끝났습니다. 서버를 다시 켠 뒤 POS에서 최근 거래와 재고를 확인하고, 백업 이후 거래는 장애 복구 절차로 다시 입력하세요.');
    return result.problems.length === 0;
  }
  if (command === 'status') {
    const current = backup.status();
    print({ ...current, backups: current.backups.slice(0, 10) });
    return true;
  }
  console.error(`알 수 없는 명령: ${command}`);
  return false;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
