/** Keep I/O real, but let each test choose when its request lease expires. */
export function useDeadlineClock() {
  rstest.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'performance'],
  });
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
