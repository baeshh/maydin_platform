// MAYDIN 파트너센터 · 가입 경로별 QR
/* ---------- 가입 경로별 QR ---------- */

const channelState = { channels: [], types: {}, showForm: false };

function channelLink(channel) {
  const url = new URL(latestQrUrl || '/join.html', location.origin);
  if (channel.code) url.searchParams.set('ch', channel.code);
  return url.href;
}

async function loadChannels() {
  try {
    const data = await api.request('/qrcodes/channels');
    channelState.channels = data.channels;
    channelState.types = data.types;
    renderChannels();
  } catch (error) {
    $('#channelBox').innerHTML = renderEmpty(error.message);
  }
}

function renderChannels() {
  const box = $('#channelBox');
  box.classList.remove('loading');
  const types = channelState.types;
  box.innerHTML = `
    <div class="card-header" style="margin-bottom: 6px;">
      <h3 class="card-title" style="font-size: 15px;">가입 경로별 QR</h3>
      <button class="btn btn-outline btn-sm" type="button" onclick="channelState.showForm = !channelState.showForm; renderChannels()">${channelState.showForm ? '닫기' : '+ QR 추가'}</button>
    </div>
    <p class="list-meta" style="margin: 0 0 8px;">카운터·전단·제휴처마다 다른 QR을 쓰면 어디서 회원이 들어오고 실제로 구매하는지 비교할 수 있습니다.</p>
    ${channelState.showForm ? `
      <form class="inline-actions" style="margin-bottom: 10px;" onsubmit="createChannel(event)">
        <input class="form-control" name="name" placeholder="예: 1층 카운터, 10월 전단" maxlength="40" style="flex: 1; min-width: 140px;" required />
        <select class="form-control" name="channel_type" style="width: auto;">
          ${Object.entries(types).map(([key, label]) => `<option value="${key}">${h(label)}</option>`).join('')}
        </select>
        <input class="form-control" name="memo" placeholder="메모 (선택)" maxlength="200" style="flex: 1; min-width: 120px;" />
        <button class="btn btn-primary btn-sm" type="submit">만들기</button>
      </form>` : ''}
    <div class="list-stack">
      ${channelState.channels.map((ch) => `
        <div class="list-item" style="${ch.status === 'INACTIVE' ? 'opacity: 0.55;' : ''}">
          <div>
            <div class="list-title">${h(ch.name)} <span class="badge gray">${h(ch.channel_type === 'BASIC' ? '기본' : types[ch.channel_type] || ch.channel_type)}</span>${ch.status === 'INACTIVE' ? ' <span class="badge red">사용 중지</span>' : ''}</div>
            <div class="list-meta">
              스캔 ${ch.scan_count.toLocaleString()} · 가입 ${ch.member_count.toLocaleString()}명${ch.signup_rate == null ? '' : ` (${ch.signup_rate}%)`}
              · 구매 ${ch.purchaser_count.toLocaleString()}명${ch.purchase_rate == null ? '' : ` (${ch.purchase_rate}%)`} · 매출 ${money(ch.net_sales)}
              ${ch.memo ? `<br />${h(ch.memo)}` : ''}
            </div>
          </div>
          <div class="inline-actions" style="flex-shrink: 0;">
            ${ch.code ? `
              <button class="muted-link" type="button" onclick="showChannelQr(${ch.id})">QR</button>
              <button class="muted-link" type="button" onclick="copyChannelLink(${ch.id})">링크</button>
              <button class="muted-link" type="button" onclick="setChannelStatus(${ch.id}, '${ch.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'}')">${ch.status === 'ACTIVE' ? '중지' : '다시 사용'}</button>` : ''}
          </div>
        </div>
        ${ch.code ? `<div id="channelQr-${ch.id}" class="channel-qr" hidden></div>` : ''}
      `).join('')}
    </div>
  `;
}

async function createChannel(event) {
  event.preventDefault();
  const form = event.target;
  try {
    const data = await api.request('/qrcodes/channels', {
      method: 'POST',
      body: { name: form.name.value, channel_type: form.channel_type.value, memo: form.memo.value }
    });
    channelState.channels = data.channels;
    channelState.showForm = false;
    renderChannels();
    showToast(`'${data.channel.name}' QR을 만들었습니다.`);
    showChannelQr(data.channel.id);
  } catch (error) {
    showToast(error.message);
  }
}

async function setChannelStatus(id, status) {
  const ch = channelState.channels.find((c) => c.id === id);
  if (status === 'INACTIVE' && !confirm(`'${ch.name}' QR을 사용 중지할까요?\n이 QR로 들어온 사람도 가입은 되지만 기본 링크 가입으로 집계됩니다.`)) return;
  try {
    const data = await api.request(`/qrcodes/channels/${id}`, { method: 'PATCH', body: { status } });
    channelState.channels = data.channels;
    renderChannels();
  } catch (error) {
    showToast(error.message);
  }
}

async function copyChannelLink(id) {
  const link = channelLink(channelState.channels.find((c) => c.id === id));
  try {
    await navigator.clipboard.writeText(link);
    showToast('가입 링크를 복사했습니다.');
  } catch (error) {
    showToast(link);
  }
}

async function showChannelQr(id) {
  const target = $(`#channelQr-${id}`);
  if (!target) return;
  target.hidden = !target.hidden;
  if (target.hidden) return;
  const ch = channelState.channels.find((c) => c.id === id);
  const link = channelLink(ch);
  target.innerHTML = `
    <div class="qr-svg" id="channelQrSvg-${id}"></div>
    <div>
      <div class="list-title">${h(ch.name)}</div>
      <p class="list-meta" style="word-break: break-all;">${h(link)}</p>
      <button class="btn btn-outline btn-sm" type="button" onclick="printChannelQr(${id})">인쇄</button>
    </div>`;
  await ScanKit.renderQr($(`#channelQrSvg-${id}`), link, { cellSize: 5 });
}

function printChannelQr(id) {
  const ch = channelState.channels.find((c) => c.id === id);
  const svg = $(`#channelQrSvg-${id}`).innerHTML;
  const pharmacy = $('#pagePharmacyName').textContent;
  const win = window.open('', '_blank', 'width=480,height=640');
  if (!win) return showToast('팝업이 차단되었습니다. 팝업을 허용해 주세요.');
  win.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8" /><title>${h(ch.name)} QR</title>
    <style>body{font-family:Pretendard,-apple-system,sans-serif;text-align:center;padding:40px 24px;color:#191f28}
    .qr{width:280px;height:280px;margin:24px auto}.qr svg{width:100%;height:100%}h1{font-size:26px;margin:0}p{color:#4e5968;line-height:1.6}</style>
    </head><body><h1>${h(pharmacy)} 회원 가입</h1><p>휴대폰 카메라로 QR을 찍으면<br />바로 가입하고 포인트를 받을 수 있어요.</p>
    <div class="qr">${svg}</div><p style="font-size:12px;color:#8b95a1;">${h(ch.name)}</p></body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
}
