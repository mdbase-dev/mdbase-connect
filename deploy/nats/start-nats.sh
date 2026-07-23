#!/bin/sh
set -eu

token=${NATS_AUTH_TOKEN:-}
port=${PORT:-}
if [ "${#token}" -lt 32 ]; then
  echo "NATS_AUTH_TOKEN must contain at least 32 characters" >&2
  exit 1
fi

case "$port" in
  ""|*[!0-9]*)
    echo "PORT must be a numeric HTTP monitoring port" >&2
    exit 1
    ;;
esac

case "$token" in
  *[!A-Za-z0-9_+=./-]*)
    echo "NATS_AUTH_TOKEN contains unsupported characters" >&2
    exit 1
    ;;
esac

# The constant prefix guarantees that an unquoted NATS config variable cannot
# be parsed as a number when a generated secret happens to start with a digit.
MDBASE_NATS_PASSWORD="mdbase_${token}"
MDBASE_NATS_HTTP_ADDR="0.0.0.0:${port}"
export MDBASE_NATS_PASSWORD MDBASE_NATS_HTTP_ADDR

nats-server -t -c /etc/nats/mdbase-connect.conf

# Render's port discovery sends a delayed HTTP HEAD request to every listening
# port, including non-HTTP private-service ports. NATS correctly rejects that
# request but reports it as a parser error every second. Filter only that exact
# loopback discovery diagnostic; preserve every other NATS log line.
log_pipe="/tmp/mdbase-connect-nats-log.$$"
mkfifo "$log_pipe"
filter_logs() {
  while IFS= read -r line; do
    case "$line" in
      *"[ERR] 127.0.0.1:"*"Client parser ERROR"*"EAD / HTTP/1.1"*"Host: mdbase-con"*) ;;
      *"[ERR] [::1]:"*"Client parser ERROR"*"EAD / HTTP/1.1"*"Host: mdbase-con"*) ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < "$log_pipe"
}

filter_logs &
filter_pid=$!
nats-server -c /etc/nats/mdbase-connect.conf > "$log_pipe" 2>&1 &
nats_pid=$!

shutdown() {
  trap - INT TERM
  kill -TERM "$nats_pid" 2>/dev/null || true
  wait "$nats_pid" 2>/dev/null || true
  wait "$filter_pid" 2>/dev/null || true
  rm -f "$log_pipe"
  exit 0
}
trap shutdown INT TERM

while kill -0 "$nats_pid" 2>/dev/null && kill -0 "$filter_pid" 2>/dev/null; do
  sleep 1
done

status=1
if ! kill -0 "$nats_pid" 2>/dev/null; then
  wait "$nats_pid" || status=$?
fi
if ! kill -0 "$filter_pid" 2>/dev/null; then
  wait "$filter_pid" || status=$?
fi
kill -TERM "$nats_pid" "$filter_pid" 2>/dev/null || true
wait "$nats_pid" 2>/dev/null || true
wait "$filter_pid" 2>/dev/null || true
rm -f "$log_pipe"
exit "$status"
