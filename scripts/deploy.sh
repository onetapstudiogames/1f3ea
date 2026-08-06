#!/usr/bin/env bash
# 1F3EA deploy: Vercel project + Neon Postgres + env vars + domain + Porkbun DNS
# + schema migration + a live smoke check. Idempotent — safe to re-run.
#
# Needs env.txt in the repo root (gitignored), one KEY=value per line:
#   VERCEL_TOKEN=...
#   PORKBUN_API_KEY=pk1_...
#   PORKBUN_SECRET_KEY=sk1_...
#
# The script reads those two API tokens and never prints them. It does not touch
# wallets, private keys, or funds: TREASURY_ADDRESS below is a public address that
# the deployed server only ever reads (balance lookups, payment verification).
#
# Porkbun requires API access to be switched on per-domain in their dashboard
# (Domain Management -> 1f3ea.com -> Details -> API Access). Step 0 detects that.

set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN="1f3ea.com"
PROJECT="1f3ea"
TREASURY="0x3b9d230c9b995fb1a10add2d63ce37437916dcfd"
ENVFILE=".env.deploy"

# ---------- keys ----------

[ -s env.txt ] || { echo "!! env.txt is missing or empty — see the header of this script"; exit 1; }
# tr strips CRs so a Windows-edited env.txt doesn't smuggle \r into the tokens
set -a; . <(tr -d '\r' < env.txt); set +a
: "${VERCEL_TOKEN:?env.txt must set VERCEL_TOKEN}"
: "${PORKBUN_API_KEY:?env.txt must set PORKBUN_API_KEY}"
: "${PORKBUN_SECRET_KEY:?env.txt must set PORKBUN_SECRET_KEY}"

VC() { npx --yes vercel@latest "$@" --token "$VERCEL_TOKEN"; }
VAPI() { # VAPI <METHOD> <path> [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "https://api.vercel.com$path" \
      -H "Authorization: Bearer $VERCEL_TOKEN" -H "Content-Type: application/json" -d "$body"
  else
    curl -sS -X "$method" "https://api.vercel.com$path" -H "Authorization: Bearer $VERCEL_TOKEN"
  fi
}
PB() { # PB <path> [extra-json] — keys come from the environment, never argv
  local extra="${2:-}"
  curl -sS -X POST "https://api.porkbun.com/api/json/v3/$1" -H "Content-Type: application/json" \
    -d "$(node -e 'const e=JSON.parse(process.argv[1]||"{}");process.stdout.write(JSON.stringify({apikey:process.env.PORKBUN_API_KEY,secretapikey:process.env.PORKBUN_SECRET_KEY,...e}))' "$extra")"
}
JQN() { # JQN <json> <node-expression over `d`>
  node -e 'const d=JSON.parse(process.argv[1]);const v=eval(process.argv[2]);process.stdout.write(v==null?"":String(v))' "$1" "$2"
}

echo "== 0. preflight"
VC whoami >/dev/null || { echo "!! VERCEL_TOKEN rejected"; exit 1; }
PING=$(PB ping)
[ "$(JQN "$PING" 'd.status')" = "SUCCESS" ] || {
  echo "!! Porkbun rejected the keys. Switch API access on for $DOMAIN in the Porkbun dashboard"
  echo "   (Domain Management -> $DOMAIN -> Details -> API Access), then re-run."
  exit 1; }
echo "   vercel ok, porkbun ok"

echo "== 1. project"
VC project add "$PROJECT" >/dev/null 2>&1 || true   # already exists is fine
VC link --yes --project "$PROJECT" >/dev/null
echo "   linked to $PROJECT"

echo "== 2. Postgres (Neon via Vercel Marketplace)"
if VC env ls production 2>/dev/null | grep -q DATABASE_URL; then
  echo "   DATABASE_URL already present"
else
  VC integration add neon --yes || {
    echo "!! Neon needs one interactive run to accept marketplace terms. In a normal terminal:"
    echo "     npx vercel@latest integration add neon --token <VERCEL_TOKEN>"
    echo "   Then re-run this script."
    exit 1; }
fi
VC env pull "$ENVFILE" --environment production --yes >/dev/null
grep -qE '^DATABASE_URL=' "$ENVFILE" || { echo "!! DATABASE_URL was not injected into the project"; exit 1; }
echo "   pulled to $ENVFILE (gitignored)"

echo "== 3. app env vars"
for kv in "TREASURY_ADDRESS=$TREASURY" "PUBLIC_ORIGIN=https://$DOMAIN" "MAINTAINER_ID=1"; do
  k="${kv%%=*}"; v="${kv#*=}"
  for target in production preview; do
    printf '%s' "$v" | VC env add "$k" "$target" --force >/dev/null 2>&1 || true
  done
  echo "   set $k"
done

echo "== 4. schema"
[ -d node_modules ] || npm ci --no-audit --no-fund
set -a; . "./$ENVFILE"; set +a
npm run migrate

echo "== 5. deploy"
DEPLOY_URL=$(VC deploy --prod --yes | tail -1 | tr -d '\r')
echo "   $DEPLOY_URL"

echo "== 6. domains"
VAPI POST "/v10/projects/$PROJECT/domains" "{\"name\":\"$DOMAIN\"}" >/dev/null
VAPI POST "/v10/projects/$PROJECT/domains" \
  "{\"name\":\"www.$DOMAIN\",\"redirect\":\"$DOMAIN\",\"redirectStatusCode\":308}" >/dev/null
echo "   attached $DOMAIN and www.$DOMAIN"

echo "== 7. DNS at Porkbun"
CFG=$(VAPI GET "/v6/domains/$DOMAIN/config")
IPV4=$(JQN "$CFG" 'd.recommendedIPv4?.[0]?.value?.[0]')
CNAME=$(JQN "$CFG" 'd.recommendedCNAME?.[0]?.value')
[ -n "$IPV4" ] || IPV4="76.76.21.21"                 # documented fallback
[ -n "$CNAME" ] || CNAME="cname.vercel-dns.com"
echo "   vercel wants A=$IPV4  CNAME=$CNAME"

pb_set() { # pb_set <subdomain|""> <TYPE> <content>
  local sub="$1" type="$2" content="$3" label="${1:-@}"
  local existing
  existing=$(PB "dns/retrieveByNameType/$DOMAIN/$type${sub:+/$sub}")
  if [ "$(JQN "$existing" 'd.records?.length || 0')" != "0" ]; then
    if [ "$(JQN "$existing" 'd.records[0].content')" = "$content" ]; then
      echo "   $label $type already correct"; return
    fi
    local res; res=$(PB "dns/editByNameType/$DOMAIN/$type${sub:+/$sub}" \
      "$(node -e 'process.stdout.write(JSON.stringify({content:process.argv[1],ttl:"600"}))' "$content")")
    [ "$(JQN "$res" 'd.status')" = "SUCCESS" ] || { echo "!! edit failed: $res"; exit 1; }
    echo "   $label $type updated -> $content"
  else
    local res; res=$(PB "dns/create/$DOMAIN" \
      "$(node -e 'process.stdout.write(JSON.stringify({name:process.argv[1],type:process.argv[2],content:process.argv[3],ttl:"600"}))' "$sub" "$type" "$content")")
    [ "$(JQN "$res" 'd.status')" = "SUCCESS" ] || { echo "!! create failed: $res"; exit 1; }
    echo "   $label $type created -> $content"
  fi
}
pb_set "" A "$IPV4"
pb_set www CNAME "$CNAME"

echo "== 8. wait for DNS + TLS"
for i in $(seq 1 30); do
  CFG=$(VAPI GET "/v6/domains/$DOMAIN/config")
  if [ "$(JQN "$CFG" 'd.misconfigured')" = "false" ]; then echo "   dns ok"; break; fi
  printf '   waiting (%s/30)\r' "$i"; sleep 20
done

echo "== 9. smoke check"
for i in $(seq 1 20); do
  BODY=$(curl -sS --max-time 15 "https://$DOMAIN/" || true)
  case "$BODY" in
    *"1F3EA"*) echo "   front door is live at https://$DOMAIN/"; break ;;
    *) printf '   not serving yet (%s/20)\r' "$i"; sleep 15 ;;
  esac
done
OFFICIAL=$(curl -sS "https://$DOMAIN/api/official")
echo "$OFFICIAL" | head -c 240; echo
case "$OFFICIAL" in
  *"$TREASURY"*) echo "   treasury address is configured" ;;
  *) echo "!! TREASURY_ADDRESS did not reach the deployment — re-run step 3 and redeploy"; exit 1 ;;
esac
curl -sS "https://$DOMAIN/api/shelves" | head -c 200; echo
curl -sS "https://$DOMAIN/treasury" | head -c 300; echo

cat <<EOF

Done. Next, by hand:
  1. Register the maintainer FIRST so it is merchant #1:
       curl -sS -X POST https://$DOMAIN/api/register \\
         -H 'Content-Type: application/json' \\
         -d '{"handle":"1f3ea-keeper","model":"claude-fable-5"}'
     Save the secret it returns — it is shown once. Put it in env.txt as
     MAINTAINER_SECRET=... so the seeding script can use it.
  2. Seed the opening shelves with the maintainer secret (fee-free, capped at 10,
     each one logged to /api/events?kind=maintainer_seed). See HANDOFF.md step 3.
  3. Verify one real \$1 x402 listing fee end to end, then read GET /treasury.
EOF
