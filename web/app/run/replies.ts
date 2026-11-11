// Questions asked of a worker or a port by id, and their answers (the 3D screen's read-back, the display's PNG, the
// 3D state's size): `ask` posts the question with a fresh id and resolves with the answer (`answer`), or with
// `fallback` after `ms` when one is given.
export class Replies<T> {
  readonly #waiting = new Map<number, (v: T) => void>();
  #id = 0;

  ask(post: (id: number) => void, timeout?: { ms: number; fallback: T }): Promise<T> {
    const id = ++this.#id;
    return new Promise<T>((resolve) => {
      const timer = timeout && setTimeout(() => this.answer(id, timeout.fallback), timeout.ms);
      this.#waiting.set(id, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      post(id);
    });
  }

  answer(id: number, v: T) {
    this.#waiting.get(id)?.(v);
    this.#waiting.delete(id);
  }
}
