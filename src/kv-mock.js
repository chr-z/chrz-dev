/**
 * Mock de KV com semântica do Cloudflare Workers KV — só pra testes locais.
 *
 * Espelha o comportamento real que importa pros testes:
 *  - put() aceita STRING (como o KV real; objeto cai pra "[object Object]",
 *    expondo bugs de dupla codificação exatamente como em produção);
 *  - get(key, {type:'json'}) faz JSON.parse da string armazenada;
 *  - expiração por TTL em segundos.
 */
'use strict';

export class MemoryKV {
  constructor() {
    this.store = new Map(); // key -> { value(string), expiresAt|null }
    this.now = () => Date.now();
  }

  async get(key, opts = {}) {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (hit.expiresAt !== null && this.now() > hit.expiresAt) {
      this.store.delete(key);
      return null;
    }
    if (opts.type === 'json') {
      try {
        return JSON.parse(hit.value);
      } catch {
        return null;
      }
    }
    return hit.value;
  }

  async put(key, value, ttlOrOpts = null) {
    if (typeof value !== 'string') {
      // Mesmo comportamento do KV real com objeto: coerção destrutiva.
      value = String(value);
    }
    const ttlS = typeof ttlOrOpts === 'number'
      ? ttlOrOpts
      : (ttlOrOpts && typeof ttlOrOpts === 'object' ? ttlOrOpts.expirationTtl : null);
    const expiresAt = ttlS ? this.now() + ttlS * 1000 : null;
    this.store.set(key, { value, expiresAt });
  }

  delete(key) {
    this.store.delete(key);
  }

  size() {
    let n = 0;
    for (const [k, v] of this.store) {
      if (v.expiresAt === null || v.expiresAt > this.now()) n++;
      else this.store.delete(k);
    }
    return n;
  }
}
