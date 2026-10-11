const express = require('express');
const { getAll, getOne, run, transaction } = require('../../db');
const { ADAPTERS, VAN_COMPANIES, vanModeOptions } = require('../integrations');
const { BRIDGE_PROTOCOL } = require('../integrations/bridge-protocol');
const { PosError, audit, cleanText, handle, requireOwner } = require('../common');
const { findOpenSession } = require('../services/session-service');
const { issueBridgeKey, listTerminals, publicTerminal, registerDevice, requireTerminal, revokeDevice, vanInfo } = require('../services/terminal-service');

const router = express.Router();

/* ---------- 카운터(단말기) 등록 ---------- */

router.get(
  '/terminals',
  handle((req) => {
    requireOwner(req, '카운터 관리');
    return { terminals: listTerminals(req.pharmacyId), current_terminal_id: req.pos.terminal ? req.pos.terminal.id : null };
  })
);

// 관리자가 카운터로 쓸 PC에서 직접 누른다. 응답의 device_token 은 그 PC에만 보관한다.
router.post(
  '/terminals/register',
  handle((req, res) => {
    requireOwner(req, '카운터 PC 등록');
    const terminalId = req.body.terminal_id ? Number(req.body.terminal_id) : null;
    const result = transaction(() => {
      const registered = registerDevice({
        pharmacyId: req.pharmacyId,
        terminalId,
        terminalName: cleanText(req.body.terminal_name, 30),
        deviceLabel: cleanText(req.body.device_label, 60),
        replace: req.body.replace === true,
        userId: req.user.id
      });
      audit(
        req,
        registered.replaced ? 'POS_TERMINAL_DEVICE_REPLACE' : 'POS_TERMINAL_REGISTER',
        'POS_TERMINAL',
        registered.terminal.id,
        `${registered.terminal.terminal_name} ${registered.replaced ? 'PC 교체' : 'PC 등록'}${registered.terminal.device_label ? ` · ${registered.terminal.device_label}` : ''}`
      );
      return registered;
    })();
    res.status(201);
    return result;
  })
);

router.post(
  '/terminals/:id/revoke-device',
  handle((req) => {
    requireOwner(req, '카운터 PC 해제');
    const id = Number(req.params.id);
    transaction(() => {
      const terminal = getOne('SELECT * FROM pos_terminals WHERE id = @id AND pharmacy_id = @pharmacy_id', { id, pharmacy_id: req.pharmacyId });
      if (!terminal) throw new PosError('카운터를 찾을 수 없습니다.', 404);
      revokeDevice(req.pharmacyId, id);
      audit(req, 'POS_TERMINAL_REVOKE', 'POS_TERMINAL', id, `${terminal.terminal_name} PC 등록 해제`);
    })();
    return { terminals: listTerminals(req.pharmacyId) };
  })
);

router.patch(
  '/terminals/:id',
  handle((req) => {
    requireOwner(req, '카운터 설정');
    const id = Number(req.params.id);
    const terminal = getOne('SELECT * FROM pos_terminals WHERE id = @id AND pharmacy_id = @pharmacy_id', { id, pharmacy_id: req.pharmacyId });
    if (!terminal) throw new PosError('카운터를 찾을 수 없습니다.', 404);
    const name = cleanText(req.body.terminal_name, 30) || terminal.terminal_name;
    const status = req.body.status === undefined ? terminal.status : String(req.body.status).toUpperCase();
    if (!['ACTIVE', 'INACTIVE'].includes(status)) throw new PosError('카운터 상태가 올바르지 않습니다.');
    if (status === 'INACTIVE' && findOpenSession(id)) throw new PosError('영업 중인 카운터는 일마감한 뒤 사용 중지할 수 있습니다.', 409);
    const duplicate = getOne('SELECT 1 AS found FROM pos_terminals WHERE pharmacy_id = @pharmacy_id AND terminal_name = @name AND id != @id', {
      pharmacy_id: req.pharmacyId,
      name,
      id
    });
    if (duplicate) throw new PosError(`"${name}" 이름의 카운터가 이미 있습니다.`, 409);
    transaction(() => {
      run('UPDATE pos_terminals SET terminal_name = @name, status = @status, updated_at = CURRENT_TIMESTAMP WHERE id = @id', { id, name, status });
      audit(req, 'POS_TERMINAL_UPDATE', 'POS_TERMINAL', id, `카운터 설정 · ${name} · ${status === 'ACTIVE' ? '사용' : '사용 중지'}`);
    })();
    return { terminals: listTerminals(req.pharmacyId) };
  })
);

/* ---------- 이 카운터의 VAN 설정 ---------- */

router.get(
  '/van/terminal',
  handle((req) => {
    const terminal = requireTerminal(req);
    const transactions = getAll(
      `SELECT v.*, u.name AS created_by_name, o.order_number
       FROM van_transactions v
       LEFT JOIN users u ON u.id = v.created_by
       LEFT JOIN orders o ON o.id = v.order_id
       WHERE v.pharmacy_id = @pharmacy_id AND v.terminal_id = @terminal_id
         AND date(v.created_at, 'localtime') = date('now', 'localtime')
       ORDER BY v.id DESC
       LIMIT 50`,
      { pharmacy_id: req.pharmacyId, terminal_id: terminal.id }
    );
    return { terminal: publicTerminal(terminal), van: vanInfo(terminal), van_companies: VAN_COMPANIES, modes: vanModeOptions(), transactions };
  })
);

// 이 카운터 PC의 Bridge에 넣을 서명 키. 카운터 PC에서 직접 발급해 그 PC의 Bridge 설정에 붙여 넣는다.
router.post(
  '/van/bridge-key',
  handle((req, res) => {
    requireOwner(req, 'Bridge 연결');
    const terminal = requireTerminal(req);
    const key = transaction(() => {
      const issued = issueBridgeKey(terminal.id);
      audit(req, terminal.bridge_key_enc ? 'POS_BRIDGE_REKEY' : 'POS_BRIDGE_PAIR', 'POS_TERMINAL', terminal.id, `${terminal.terminal_name} Bridge 키 ${terminal.bridge_key_enc ? '재발급' : '발급'}`);
      return issued;
    })();
    res.status(201);
    return { protocol: BRIDGE_PROTOCOL, terminal_id: terminal.id, bridge_key: key };
  })
);

router.patch(
  '/van/terminal',
  handle((req) => {
    requireOwner(req, '단말기 설정');
    const terminal = requireTerminal(req);
    const mode = String(req.body.van_mode || terminal.van_mode || 'MANUAL').toUpperCase();
    const adapter = ADAPTERS[mode];
    if (!adapter) throw new PosError('승인 방식이 올바르지 않습니다.');
    if (mode !== terminal.van_mode && !adapter.available()) {
      throw new PosError(`${adapter.label}은(는) VAN 계약·인증 정보가 등록된 뒤 쓸 수 있습니다. 필요한 것: ${(adapter.requirements || []).join(', ')}`, 409, 'VAN_NOT_CONFIGURED');
    }
    const vanCompany = cleanText(req.body.van_company, 30);
    if (vanCompany && !VAN_COMPANIES.includes(vanCompany)) throw new PosError('VAN사를 목록에서 선택해 주세요.');
    const tid = cleanText(req.body.tid, 20);
    if (tid && !/^[0-9A-Za-z-]{4,20}$/.test(tid)) throw new PosError('TID는 영문·숫자 4~20자입니다.');
    const terminalName = cleanText(req.body.terminal_name, 30) || terminal.terminal_name;

    transaction(() => {
      run(
        `UPDATE pos_terminals
         SET terminal_name = @terminal_name, van_company = @van_company, tid = @tid, van_mode = @van_mode,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = @id`,
        { id: terminal.id, terminal_name: terminalName, van_company: vanCompany, tid, van_mode: mode }
      );
      audit(
        req,
        'POS_VAN_SETTING',
        'POS_TERMINAL',
        terminal.id,
        `단말기 설정 · ${terminalName} · ${adapter.label} · ${vanCompany || 'VAN 미지정'} · TID ${tid || '-'}`
      );
    })();
    const updated = getOne('SELECT * FROM pos_terminals WHERE id = @id', { id: terminal.id });
    return { terminal: publicTerminal(updated), van: vanInfo(updated) };
  })
);

module.exports = router;
