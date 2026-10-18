const INITIAL_LIMIT = 4096;
const ERROR_LIMIT = 8192;
const TAIL_LIMIT = 128 * 1024;
const SERVER_ERROR = 'Server Error -';

/** Keep the first request failure even after repeated requests fill the log tail. */
export function createDevOutputCapture() {
  let initialOutput = '';
  let tail = '';
  let firstServerError;
  let pending = '';
  return {
    append(chunk) {
      const text = String(chunk);
      initialOutput = (initialOutput + text).slice(0, INITIAL_LIMIT);
      tail = (tail + text).slice(-TAIL_LIMIT);
      if (firstServerError !== undefined) {
        firstServerError = (firstServerError + text).slice(0, ERROR_LIMIT);
        return;
      }
      const candidate = pending + text;
      const start = candidate.indexOf(SERVER_ERROR);
      if (start !== -1) {
        firstServerError = candidate.slice(start, start + ERROR_LIMIT);
        pending = '';
      } else pending = candidate.slice(-(SERVER_ERROR.length - 1));
    },
    get tail() {
      return tail;
    },
    startup() {
      return { initialOutput, firstServerError };
    },
  };
}
