/* eslint-disable @typescript-eslint/no-require-imports -- tests/e2e/load-ts.cjs 와 같은 이유의 CommonJS 로더다. */
// v0.9 lib/autobook/** 은 "server-only" 를 import 하는 서버 전용 모듈이다.
// 평범한 Node 테스트 프로세스에는 그 해석을 제공하는 컴파일러가 없으므로,
// tests/e2e/load-ts.cjs 와 동일한 방식(ts.transpileModule + require shim)으로
// 불러온다. 네트워크에 나가지 않고 브라우저도 띄우지 않는다.
const { load } = require('../e2e/load-ts.cjs');

module.exports = { loadTs: load };
