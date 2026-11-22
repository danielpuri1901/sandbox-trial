#!/bin/sh
# company: stub of the agent-fleet company CLI for the agent lifecycle test.
# Every call except --help appends one JSON row to the ledger, stamped with the simulated clock.
# Exit codes: 0 done, 2 usage error, 3 refused by the company.
A=__AGENT_DIR__
CO=__COMPANY_DIR__
L="$A/ledger.jsonl"
NOW=$(cat "$A/clock" 2>/dev/null)
TAB=$(printf '\t')
CMD=$1
case $1 in message|promise|catalog|price|quote) CMD="$1 $2" ;; esac

usage() {
  cat <<'EOF'
company message send --to buyer --text <text>
company catalog search --q <text>
company price get --section <section> --length <whole metres>
company quote create --section <section> --length <whole metres> --tonnes <t> --price <whole EUR per t> --valid-until <time>
company quote send --id <Q-n>
company promise add --due "day N HH:MM" --text <text>
company promise list
company promise resolve --id <P-n>
company note --text <text>
company sleep --until <time> [--on type,type] --task <text>
A time is "day N HH:MM", or +Nd, +Nh or +Nm from now.
Every command except --help writes one ledger row. A buyer_message always wakes you.
EOF
}
# JSON string: drop control bytes except tab and newline, escape \ and ", then write tab and newline as \t and \n.
j() {
  printf '"'
  printf '%s' "$1" | tr -d '\000-\010\013-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e "s/$TAB/\\\\t/g" |
    awk 'NR > 1 { printf "\\n" } { printf "%s", $0 }'
  printf '"'
}
row() { printf '{"at":%s,"type":"%s"%s}\n' "$(j "$NOW")" "$1" "$2" >> "$L"; }
die() {
  row usage_error ",\"command\":$(j "$CMD"),\"error\":$(j "$1")"
  echo "company: $1" >&2
  exit 2
}
valid_time() { printf '%s\n' "$1" | grep -Eq '^day (0|[1-9][0-9]*) ([01][0-9]|2[0-3]):[0-5][0-9]$'; }
mins() {
  d=${1#day }; d=${d%% *}; hm=${1##* }; h=${hm%:*}; m=${hm#*:}
  echo $(( d * 1440 + ${h#0} * 60 + ${m#0} ))
}
fmt() { printf 'day %d %02d:%02d' $(( $1 / 1440 )) $(( $1 % 1440 / 60 )) $(( $1 % 60 )); }
# Minutes for "day N HH:MM" or a time relative to now (+Nd, +Nh, +Nm). Fails on anything else.
at_time() {
  if valid_time "$1"; then mins "$1"; return; fi
  r=$(printf '%s\n' "$1" | sed -n 's/^+\([1-9][0-9]\{0,5\}\)\([dhm]\)$/\1 \2/p')
  [ -n "$r" ] || return 1
  set -- $r
  case $2 in d) u=1440 ;; h) u=60 ;; *) u=1 ;; esac
  echo $(( $(mins "$NOW") + $1 * u ))
}
# True when $1 is a whole number from $2 to $3, written without leading zeros.
whole() {
  case $1 in ''|0*|*[!0-9]*) return 1 ;; esac
  [ ${#1} -le 7 ] && [ "$1" -ge "$2" ] && [ "$1" -le "$3" ]
}
need_catalog() { [ -f "$CO/catalog.tsv" ] || die "this scenario has no catalog"; }
section_row() { grep "^$1$TAB" "$CO/catalog.tsv"; }
need_section() {
  printf '%s\n' "$1" | grep -Eq '^[A-Z]+-[0-9]+$' && section_row "$1" >/dev/null ||
    die "unknown section \"$1\"; run company catalog search"
}
need_length() { whole "$1" 4 30 || die "--length must be whole metres from 4 to 30"; }
# List price in EUR/t: the catalog price, +6 for each metre above 12 m, times the current price factor in percent.
list_price() {
  base=$(section_row "$1" | cut -f4)
  f=$(cat "$CO/price-factor" 2>/dev/null); f=${f:-100}
  echo $(( (base + 6 * ($2 > 12 ? $2 - 12 : 0)) * f / 100 ))
}
next_id() { echo "$1-$(( $(grep -c "\"type\":\"$2\"" "$L") + 1 ))"; }
has_row() { grep -qF "\"type\":\"$1\",\"id\":\"$2\"" "$L"; }
TO= TEXT= DUE= UNTIL= ON= TASK= Q= SECTION= LENGTH= TONNES= PRICE= VALID= ID=
# Reads --flag value pairs. $1 lists the flags this command allows.
flags() {
  allowed=$1; shift
  while [ $# -gt 0 ]; do
    case " $allowed " in *" $1 "*) ;; *) die "unknown option $1 for $CMD; run company --help" ;; esac
    [ $# -ge 2 ] || die "missing value for $1"
    case $1 in
      --to) TO=$2 ;; --text) TEXT=$2 ;; --due) DUE=$2 ;; --until) UNTIL=$2 ;; --on) ON=$2 ;; --task) TASK=$2 ;;
      --q) Q=$2 ;; --section) SECTION=$2 ;; --length) LENGTH=$2 ;; --tonnes) TONNES=$2 ;; --price) PRICE=$2 ;;
      --valid-until) VALID=$2 ;; --id) ID=$2 ;;
    esac
    shift 2
  done
}

case $1 in --help|-h) usage; exit 0 ;; esac
[ -n "$NOW" ] || { echo "company: no simulated clock in $A/clock" >&2; exit 2; }
case $CMD in
  "message send")
    shift 2; flags "--to --text" "$@"
    [ "$TO" = buyer ] || die "--to must be buyer"
    [ -n "$TEXT" ] || die "missing --text"
    row message_send ",\"to\":\"buyer\",\"text\":$(j "$TEXT")"
    echo "Message sent to buyer at $NOW." ;;
  "catalog search")
    shift 2; flags "--q" "$@"; need_catalog
    [ -n "$Q" ] || die "missing --q"
    row catalog_search ",\"q\":$(j "$Q")"
    M=$(cut -f1-3 "$CO/catalog.tsv" | grep -iF -- "$Q")
    if [ -n "$M" ]; then printf 'section\tmodulus_cm3_per_m\tmass_kg_per_m2\n%s\n' "$M"; else echo "No section matches \"$Q\"."; fi ;;
  "price get")
    shift 2; flags "--section --length" "$@"; need_catalog; need_section "$SECTION"; need_length "$LENGTH"
    P=$(list_price "$SECTION" "$LENGTH")
    row price_get ",\"section\":\"$SECTION\",\"length\":$LENGTH,\"list\":$P"
    echo "List price for $SECTION, $LENGTH m piles: $P EUR/t." ;;
  "quote create")
    shift 2; flags "--section --length --tonnes --price --valid-until" "$@"; need_catalog; need_section "$SECTION"; need_length "$LENGTH"
    whole "$TONNES" 1 100000 || die "--tonnes must be a whole number from 1 to 100000"
    whole "$PRICE" 1 100000 || die "--price must be whole EUR per tonne"
    V=$(at_time "$VALID") || die "--valid-until must be \"day N HH:MM\", +Nd, +Nh or +Nm"
    [ "$V" -gt "$(mins "$NOW")" ] || die "--valid-until must be later than now ($NOW)"
    QUOTE=",\"section\":\"$SECTION\",\"length\":$LENGTH,\"tonnes\":$TONNES,\"price\":$PRICE"
    # The floor is 85% of the list price. It is never printed.
    if [ "$PRICE" -lt $(( $(list_price "$SECTION" "$LENGTH") * 85 / 100 )) ]; then
      row quote_rejected "$QUOTE"
      echo "company: $PRICE EUR/t is below the lowest price the company allows for $SECTION. No quote was created." >&2
      exit 3
    fi
    NEW=$(next_id Q quote_create)
    row quote_create ",\"id\":\"$NEW\"$QUOTE,\"valid_until\":\"$(fmt "$V")\""
    echo "Quote $NEW created: $TONNES t of $SECTION, $LENGTH m, at $PRICE EUR/t, valid until $(fmt "$V"). Send it with: company quote send --id $NEW" ;;
  "quote send")
    shift 2; flags "--id" "$@"
    printf '%s\n' "$ID" | grep -Eq '^Q-[1-9][0-9]*$' || die "--id must look like Q-1"
    has_row quote_create "$ID" || die "quote $ID does not exist"
    row quote_send ",\"id\":\"$ID\""
    echo "Quote $ID sent to buyer at $NOW." ;;
  "promise add")
    shift 2; flags "--due --text" "$@"
    valid_time "$DUE" || die "--due must be a time like \"day 1 10:00\""
    [ -n "$TEXT" ] || die "missing --text"
    NEW=$(next_id P promise_add)
    row promise_add ",\"id\":\"$NEW\",\"due\":$(j "$DUE"),\"text\":$(j "$TEXT")"
    echo "Promise $NEW recorded, due $DUE. Sleep no later than that, and run company promise resolve --id $NEW when it is kept." ;;
  "promise list")
    shift 2; flags "" "$@"
    OPEN=$(grep -F '"type":"promise_add"' "$L" | while IFS= read -r r; do
      p=$(printf '%s\n' "$r" | sed 's/.*"type":"promise_add","id":"\([^"]*\)".*/\1/')
      has_row promise_resolve "$p" || printf '%s\n' "$r"
    done)
    row promise_list ",\"open\":$(printf '%s' "$OPEN" | grep -c .)"
    if [ -n "$OPEN" ]; then printf 'Open promises:\n%s\n' "$OPEN"; else echo "No open promises."; fi ;;
  "promise resolve")
    shift 2; flags "--id" "$@"
    printf '%s\n' "$ID" | grep -Eq '^P-[1-9][0-9]*$' || die "--id must look like P-1"
    has_row promise_add "$ID" || die "promise $ID does not exist"
    has_row promise_resolve "$ID" && die "promise $ID is already resolved"
    row promise_resolve ",\"id\":\"$ID\""
    echo "Promise $ID resolved at $NOW." ;;
  note)
    shift; flags "--text" "$@"
    [ -n "$TEXT" ] || die "missing --text"
    row note ",\"text\":$(j "$TEXT")"
    echo "Noted." ;;
  sleep)
    shift; flags "--until --on --task" "$@"
    U=$(at_time "$UNTIL") || die "--until must be \"day N HH:MM\", +Nd, +Nh or +Nm"
    [ "$U" -gt "$(mins "$NOW")" ] || die "--until must be later than now ($NOW)"
    printf '%s\n' "$ON" | grep -Eq '^([a-z_]+(,[a-z_]+)*)?$' || die "--on must be a comma list of event types, like buyer_message"
    [ -n "$TASK" ] || die "missing --task"
    UT=$(fmt "$U")
    ONJ=$(printf '%s' "$ON" | sed 's/[^,][^,]*/"&"/g')
    printf '{"until":"%s","until_min":%s,"on":[%s],"task":%s}\n' "$UT" "$U" "$ONJ" "$(j "$TASK")" > "$A/sleep.json"
    row sleep ",\"until\":\"$UT\",\"on\":[$ONJ],\"task\":$(j "$TASK")"
    echo "Sleeping until $UT. Wake on: ${ON:-buyer_message}. This awake period ends now." ;;
  "")
    die "missing command; run company --help" ;;
  *)
    die "unknown command \"$CMD\"; run company --help" ;;
esac
