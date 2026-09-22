// Limitador de taxa simples (token bucket por janela deslizante de 1s).
// O Bling permite no máximo 3 requisições/segundo por CONTA (não por endpoint), então
// todas as chamadas à API do Bling neste servidor passam por uma única instância
// deste limitador para nunca estourar o limite e evitar bloqueio de IP.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RateLimiter {
  constructor(maxPerSecond = 3) {
    this.max = maxPerSecond;
    this.timestamps = [];
    this.chain = Promise.resolve();
  }

  async _waitForSlot() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < 1000);
      if (this.timestamps.length < this.max) {
        this.timestamps.push(now);
        return;
      }
      const oldest = this.timestamps[0];
      const waitMs = 1000 - (now - oldest) + 10;
      await sleep(Math.max(waitMs, 10));
    }
  }

  // Executa fn() respeitando o limite de taxa e mantendo a ordem de chegada das chamadas.
  schedule(fn) {
    const run = this.chain.then(() => this._waitForSlot()).then(fn);
    // Nunca deixa o chain "travado" em caso de erro de uma chamada anterior.
    this.chain = run.catch(() => {});
    return run;
  }
}

module.exports = { RateLimiter, sleep };
