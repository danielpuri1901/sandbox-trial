#!/bin/sh
# company: stub of the agent-fleet company CLI for the agent lifecycle test.
# Every call except --help appends one JSON row to the ledger, stamped with the simulated clock.
A=__AGENT_DIR__
L="$A/ledger.jsonl"
NOW=$(cat "$A/clock" 2>/dev/null)
CMD=$1
case $1 in message|promise) CMD="$1 $2" ;; esac

usage() {
  cat <<'EOF'
company message send --to buyer --text <text>
company promise add --due "day N HH:MM" --text <text>
company note --text <text>
company sleep --until <"day N HH:MM" | +Nd | +Nh | +Nm> [--on type,type] --task <text>
Every command except --help writes one ledger row. A buyer_message always wakes you.
EOF
}
# JSON string: drop control bytes except tab and newline, escape \ and ", then write tab and newline as \t and \n.
j() {
  printf '"'
  printf '%s' "$1" | tr -d '\000-\010\013-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e "s/$(printf '\t')/\\\\t/g" |
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
TO= TEXT= DUE= UNTIL= ON= TASK=
# Reads --flag value pairs. $1 lists the flags this command allows.
flags() {
  allowed=$1; shift
  while [ $# -gt 0 ]; do
    case " $allowed " in *" $1 "*) ;; *) die "unknown option $1 for $CMD; run company --help" ;; esac
    [ $# -ge 2 ] || die "missing value for $1"
    case $1 in
      --to) TO=$2 ;; --text) TEXT=$2 ;; --due) DUE=$2 ;; --until) UNTIL=$2 ;; --on) ON=$2 ;; --task) TASK=$2 ;;
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
  "promise add")
    shift 2; flags "--due --text" "$@"
    valid_time "$DUE" || die "--due must be a time like \"day 1 10:00\""
    [ -n "$TEXT" ] || die "missing --text"
    row promise_add ",\"due\":$(j "$DUE"),\"text\":$(j "$TEXT")"
    echo "Promise recorded, due $DUE. Sleep no later than that." ;;
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
