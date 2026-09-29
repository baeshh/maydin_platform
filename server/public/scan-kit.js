(function () {
  const loaded = {};

  function loadScript(src) {
    if (!loaded[src]) {
      loaded[src] = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = () => {
          delete loaded[src];
          reject(new Error('스캔 모듈을 불러오지 못했습니다. 네트워크를 확인해 주세요.'));
        };
        document.head.appendChild(script);
      });
    }
    return loaded[src];
  }

  async function renderBarcodes(root = document) {
    const targets = [...root.querySelectorAll('svg[data-barcode]')];
    if (targets.length === 0) return;
    await loadScript('/vendor/jsbarcode.min.js');
    for (const el of targets) {
      try {
        window.JsBarcode(el, el.dataset.barcode, {
          format: 'CODE128',
          displayValue: el.dataset.label !== 'off',
          fontSize: Number(el.dataset.fontSize || 12),
          height: Number(el.dataset.height || 48),
          width: Number(el.dataset.width || 1.6),
          margin: 4,
          background: 'transparent'
        });
      } catch (error) {
        el.outerHTML = `<span style="font-size:12px;">${el.dataset.barcode}</span>`;
      }
    }
  }

  async function renderQr(el, text, { cellSize = 6 } = {}) {
    await loadScript('/vendor/qrcode.js');
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    el.innerHTML = qr.createSvgTag({ cellSize, margin: 2, scalable: true });
  }

  let audioContext;
  function beep() {
    try {
      audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.frequency.value = 1320;
      gain.gain.value = 0.08;
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.09);
    } catch (error) {
      /* 소리는 선택 사항 */
    }
  }

  const STYLE = `
    .scankit-backdrop { position: fixed; inset: 0; z-index: 400; display: flex; align-items: center; justify-content: center; background: rgba(25,31,40,.6); padding: 20px; }
    .scankit-card { width: min(460px, 100%); border-radius: 22px; background: #fff; overflow: hidden; box-shadow: 0 24px 60px rgba(0,0,0,.25); font-family: Pretendard, -apple-system, sans-serif; }
    .scankit-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid #e5e8eb; }
    .scankit-head strong { font-size: 18px; color: #191f28; }
    .scankit-head button { border: 0; background: none; font-size: 26px; color: #8b95a1; cursor: pointer; line-height: 1; }
    .scankit-reader { background: #111; min-height: 260px; }
    .scankit-reader video { width: 100% !important; display: block; }
    .scankit-body { padding: 14px 20px 18px; display: grid; gap: 10px; }
    .scankit-hint { color: #4e5968; font-size: 13px; font-weight: 600; line-height: 1.5; }
    .scankit-error { color: #f04452; font-size: 13px; font-weight: 700; line-height: 1.5; }
    .scankit-manual { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
    .scankit-manual input { border: 1px solid #e5e8eb; border-radius: 12px; padding: 11px 14px; font: inherit; outline: none; }
    .scankit-manual input:focus { border-color: #3182f6; }
    .scankit-manual button { border: 0; border-radius: 12px; background: #3182f6; color: #fff; font-weight: 700; padding: 0 16px; cursor: pointer; font: inherit; }
  `;

  let current = null;

  function injectStyle() {
    if (document.getElementById('scankit-style')) return;
    const style = document.createElement('style');
    style.id = 'scankit-style';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  async function closeCameraScanner() {
    const active = current;
    current = null;
    if (!active) return;
    document.removeEventListener('keydown', active.onKey, true);
    try {
      if (active.scanner && active.scanner.isScanning) await active.scanner.stop();
      if (active.scanner) active.scanner.clear();
    } catch (error) {
      /* 이미 정지된 카메라 */
    }
    active.backdrop.remove();
  }

  // 카메라가 있는 기기(태블릿·노트북·휴대폰)에서 USB 스캐너 대신 쓰는 바코드/QR 스캔 창.
  async function openCameraScanner({ title = '카메라로 스캔', hint = '바코드나 QR을 네모 칸 안에 맞춰 주세요.', onResult }) {
    await closeCameraScanner();
    injectStyle();
    const backdrop = document.createElement('div');
    backdrop.className = 'scankit-backdrop';
    backdrop.innerHTML = `
      <div class="scankit-card" role="dialog" aria-label="${title}">
        <div class="scankit-head"><strong>${title}</strong><button type="button" data-close aria-label="닫기">×</button></div>
        <div class="scankit-reader" id="scankitReader"></div>
        <div class="scankit-body">
          <div class="scankit-hint">${hint}</div>
          <div class="scankit-error" data-error hidden></div>
          <form class="scankit-manual" data-manual>
            <input placeholder="인식이 안 되면 번호를 직접 입력" autocomplete="off" />
            <button type="submit">확인</button>
          </form>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);

    const state = { backdrop, scanner: null, done: false };
    const finish = (text) => {
      if (state.done) return;
      state.done = true;
      beep();
      closeCameraScanner().then(() => onResult(String(text).trim()));
    };
    state.onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        closeCameraScanner();
      }
    };
    current = state;
    document.addEventListener('keydown', state.onKey, true);
    backdrop.querySelector('[data-close]').addEventListener('click', closeCameraScanner);
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) closeCameraScanner();
    });
    backdrop.querySelector('[data-manual]').addEventListener('submit', (event) => {
      event.preventDefault();
      const value = event.target.querySelector('input').value.trim();
      if (value) finish(value);
    });

    const showError = (message) => {
      const el = backdrop.querySelector('[data-error]');
      el.textContent = message;
      el.hidden = false;
      backdrop.querySelector('.scankit-reader').style.minHeight = '0';
    };

    try {
      await loadScript('/vendor/html5-qrcode.min.js');
      if (current !== state) return;
      const lib = window.__Html5QrcodeLibrary__;
      const F = lib.Html5QrcodeSupportedFormats;
      state.scanner = new lib.Html5Qrcode('scankitReader', {
        formatsToSupport: [F.QR_CODE, F.EAN_13, F.EAN_8, F.CODE_128, F.CODE_39, F.UPC_A, F.UPC_E, F.ITF],
        useBarCodeDetectorIfSupported: true,
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        verbose: false
      });
      await state.scanner.start(
        { facingMode: 'environment' },
        {
          fps: 12,
          qrbox: (width, height) => ({ width: Math.floor(Math.min(width * 0.86, 380)), height: Math.floor(Math.min(height * 0.62, 220)) })
        },
        finish,
        () => {}
      );
      if (current !== state) await state.scanner.stop().catch(() => {});
    } catch (error) {
      if (current !== state) return;
      const message = String(error?.message || error || '');
      showError(
        /permission|NotAllowed/i.test(message)
          ? '카메라 권한이 거부되었습니다. 브라우저 주소창의 카메라 권한을 허용해 주세요.'
          : /NotFound|no camera|Requested device not found/i.test(message)
            ? '이 기기에서 카메라를 찾을 수 없습니다. USB 스캐너를 쓰거나 번호를 직접 입력하세요.'
            : `카메라를 시작하지 못했습니다. ${message}`
      );
      backdrop.querySelector('[data-manual] input').focus();
    }
  }

  window.ScanKit = { loadScript, renderBarcodes, renderQr, openCameraScanner, closeCameraScanner, beep };
})();
