#!/usr/bin/env node
// 사용법
//   npm run retention   보유기간이 지난 개인정보를 지금 파기하고, 백업 복원으로 되살아난 탈퇴 회원 정보를 다시 지운다.
//                       서버도 켜질 때와 하루에 한 번 같은 작업을 한다.
require('dotenv').config();
const { migrate } = require('../src/db');

migrate();
const { runRetention } = require('../src/services/privacy');
const { retentionSettings } = require('../src/services/customers');

const result = runRetention();
console.log(JSON.stringify({ settings: retentionSettings(), result }, null, 2));
