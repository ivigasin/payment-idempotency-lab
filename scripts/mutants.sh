#!/usr/bin/env bash
# Mutation check: break SafePaymentService in one place at a time and make sure the
# model-based test notices. If a mutant survives, the test is too weak.
set -u
cd "$(dirname "$0")/.."
FILE=src/services.ts
cp "$FILE" /tmp/services.ts.orig
trap 'cp /tmp/services.ts.orig "$FILE"' EXIT

run() {
  local name="$1" from="$2" to="$3"
  cp /tmp/services.ts.orig "$FILE"
  node -e '
    const fs = require("fs"); const [f, from, to] = process.argv.slice(1);
    const s = fs.readFileSync(f, "utf8");
    if (!s.includes(from)) { console.error("pattern not found: " + from); process.exit(2); }
    fs.writeFileSync(f, s.replace(from, to));
  ' "$FILE" "$from" "$to" || return
  if npx vitest run test/model.test.ts -t "holds both invariants" >/tmp/mutant.log 2>&1; then
    echo "SURVIVED  $name"
  else
    echo "killed    $name  ($(grep -oE 'I[12] [a-z-]+[^;]*' /tmp/mutant.log | head -1))"
  fi
}

run "new bank reference on every attempt" \
  "await this.bank.transfer(payment.reference," \
  "await this.bank.transfer(\`\${payment.reference}_\${Math.random()}\`,"
run "await between key lookup and insert (check-then-act)" \
  "const existing = this.byKey.get(request.key);" \
  "const existing = this.byKey.get(request.key); await this.pause();"
run "treat timeout as failure" \
  "payment.state = e instanceof BankRejected ? 'failed' : 'unknown';" \
  "payment.state = 'failed';"
run "resend without asking the bank first" \
  "const status = await this.bank.status(payment.reference);" \
  "const status = 'not-found' as const;"
