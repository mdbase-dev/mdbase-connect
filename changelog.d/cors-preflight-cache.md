## Changed

- CORS preflight responses now carry `Access-Control-Max-Age: 7200`, so
  browsers stop sending an OPTIONS request before every cross-origin app call
  (about 190 ms each on a warm app open).
