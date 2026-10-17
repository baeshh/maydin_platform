const express = require('express');
const { getOne, run, transaction } = require('../../db');
const { audit, handle, requireOwner, PosError } = require('../common');
const {
  browserFallback,
  createReceiptJob,
  createTestJob,
  getJob,
  openPrintJobs,
  publicJob,
  recordPrintResult,
  retryPrintJob,
  skipPrintJob
} = require('../services/print-service');
const { PRINTER_MODES, printerSettings, requireTerminal } = require('../services/terminal-service');

const router = express.Router();

function auditReprint(req, job) {
  if (job.document_type === 'RECEIPT' && job.copy_type === 'REPRINT') {
    audit(req, 'POS_RECEIPT_REPRINT', 'ORDER', job.order_id, `영수증 재출력 · ${job.order_number} · ${job.channel === 'BRIDGE' ? '프린터' : '브라우저'}`);
  }
}

// 판매·반품 영수증 출력. channel을 비우면 이 카운터의 프린터 설정을 따른다.
router.post(
  '/sales/:id/print',
  handle((req, res) => {
    const terminal = requireTerminal(req);
    const result = transaction(() => {
      const created = createReceiptJob(req, terminal, { orderId: req.params.id, channel: req.body.channel });
      if (!created.resumed) auditReprint(req, created.job);
      return created;
    })();
    res.status(result.resumed ? 200 : 201);
    return { job: publicJob(result.job), print_request: result.printRequest, receipt: result.receipt, resumed: Boolean(result.resumed) };
  })
);

router.post(
  '/print-jobs/:jobId/result',
  handle((req) => {
    const terminal = requireTerminal(req);
    const { job, unchanged } = transaction(() => {
      const current = getJob(req, req.params.jobId);
      const recorded = recordPrintResult(req, terminal, current, req.body.bridge_result);
      if (!recorded.unchanged && recorded.job.status === 'FAILED') {
        audit(req, 'POS_PRINT_FAILED', 'POS_TERMINAL', terminal.id, `영수증 출력 실패 · ${recorded.job.order_number || '시험 출력'} · ${recorded.job.error_code || ''} ${recorded.job.message || ''}`.trim());
      }
      return recorded;
    })();
    return { job: publicJob(job), unchanged: Boolean(unchanged) };
  })
);

router.post(
  '/print-jobs/:jobId/retry',
  handle((req) => {
    const terminal = requireTerminal(req);
    const { job, printRequest } = transaction(() => retryPrintJob(req, terminal, getJob(req, req.params.jobId)))();
    return { job: publicJob(job), print_request: printRequest };
  })
);

router.post(
  '/print-jobs/:jobId/browser',
  handle((req) => {
    const terminal = requireTerminal(req);
    const { job, receipt } = transaction(() => {
      const done = browserFallback(req, terminal, getJob(req, req.params.jobId));
      audit(req, 'POS_PRINT_FALLBACK', 'ORDER', done.job.order_id, `프린터 대신 브라우저 인쇄 · ${done.job.order_number}`);
      return done;
    })();
    return { job: publicJob(job), receipt };
  })
);

router.post(
  '/print-jobs/:jobId/skip',
  handle((req) => {
    const terminal = requireTerminal(req);
    const { job } = transaction(() => {
      const done = skipPrintJob(req, terminal, getJob(req, req.params.jobId));
      audit(req, 'POS_PRINT_SKIP', 'POS_TERMINAL', terminal.id, `영수증 출력 안 함 · ${done.job.order_number || '시험 출력'}`);
      return done;
    })();
    return { job: publicJob(job) };
  })
);

router.get(
  '/print-jobs/open',
  handle((req) => {
    const terminal = requireTerminal(req);
    return { jobs: openPrintJobs(terminal) };
  })
);

router.post(
  '/printer/test',
  handle((req, res) => {
    const terminal = requireTerminal(req);
    const { job, printRequest } = transaction(() => createTestJob(req, terminal))();
    res.status(201);
    return { job: publicJob(job), print_request: printRequest };
  })
);

router.patch(
  '/printer/settings',
  handle((req) => {
    requireOwner(req, '프린터 설정');
    const terminal = requireTerminal(req);
    const current = printerSettings(terminal);
    const mode = String(req.body.mode || current.mode).toUpperCase();
    if (!PRINTER_MODES[mode]) throw new PosError('출력 방법이 올바르지 않습니다.');
    if (mode === 'BRIDGE' && !terminal.bridge_key_enc) {
      throw new PosError('먼저 이 카운터 PC의 Bridge를 연결해 주세요. (단말기 설정 → Bridge 연결)', 409, 'BRIDGE_NOT_PAIRED');
    }
    const autoPrint = req.body.auto_print === undefined ? current.auto_print : Boolean(req.body.auto_print);
    const openDrawer = req.body.open_drawer === undefined ? current.open_drawer : Boolean(req.body.open_drawer);
    transaction(() => {
      run(
        `UPDATE pos_terminals SET printer_mode = @mode, printer_auto_print = @auto_print, printer_open_drawer = @open_drawer, updated_at = CURRENT_TIMESTAMP
         WHERE id = @id`,
        { id: terminal.id, mode, auto_print: autoPrint ? 1 : 0, open_drawer: openDrawer ? 1 : 0 }
      );
      audit(
        req,
        'POS_PRINTER_SETTING',
        'POS_TERMINAL',
        terminal.id,
        `프린터 설정 · ${PRINTER_MODES[mode]} · 자동 출력 ${autoPrint ? '켜짐' : '꺼짐'} · 돈통 ${openDrawer ? '열기' : '안 열기'}`
      );
    })();
    const updated = getOne('SELECT * FROM pos_terminals WHERE id = @id', { id: terminal.id });
    return { printer: printerSettings(updated), modes: PRINTER_MODES };
  })
);

module.exports = router;
