// MAYDIN POS · 장애 중 보관 거래 잠금
/* 카운터 공개키(서버가 /pos/context로 내려줌)로 거래마다 새 AES-256-GCM 키를 감싸 잠근다.
   이 기기에는 잠긴 내용과 금액·건수 요약만 남고, 푸는 개인키는 서버에만 있다.
   추가 인증 데이터(AAD)에 약국·거래 고유번호를 묶어 다른 거래로 바꿔 보내면 서버가 풀지 못한다.
   https(또는 localhost)가 아니면 브라우저가 WebCrypto를 막으므로 잠그지 못한다(호출하는 쪽에서 평문 보관으로 표시). */

const OfflineSeal = {
  FORMAT: 'maydin-offline/1',
  ALG: 'RSA-OAEP-256/A256GCM',
  keys: new Map(),

  available(key) {
    return Boolean(key?.key_id && key.public_key && key.alg === this.ALG && globalThis.crypto?.subtle);
  },

  toBase64(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = '';
    for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
    return btoa(binary);
  },

  fromBase64(text) {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  },

  async publicKey(key) {
    if (!this.keys.has(key.key_id)) {
      this.keys.set(
        key.key_id,
        await crypto.subtle.importKey('spki', this.fromBase64(key.public_key), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'])
      );
    }
    return this.keys.get(key.key_id);
  },

  async seal(key, pharmacyId, clientSaleId, payload) {
    const encoder = new TextEncoder();
    const aes = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(`${this.FORMAT}:${pharmacyId}:${clientSaleId}`) },
      aes,
      encoder.encode(JSON.stringify(payload))
    );
    const wrapped = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, await this.publicKey(key), await crypto.subtle.exportKey('raw', aes));
    return { alg: this.ALG, key_id: key.key_id, wrapped_key: this.toBase64(wrapped), iv: this.toBase64(iv), ciphertext: this.toBase64(ciphertext) };
  }
};
