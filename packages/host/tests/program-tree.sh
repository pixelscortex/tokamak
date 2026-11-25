trap '' TERM
if [ "$1" -eq 3 ]; then
  # Record TERM without exiting so force stop can prove it skipped TERM.
  trap 'printf "%s\n" TERM' TERM
  printf '%s\n' "$PPID"
fi
printf '%s\n' "$$"
if [ "$1" -gt 1 ]; then
  /bin/sh "$0" "$(($1 - 1))" &
  if [ "$1" -eq 3 ]; then
    child=$!
    while kill -0 "$child" 2>/dev/null; do wait "$child"; done
  else
    wait
  fi
else
  exec /bin/sleep 60
fi
