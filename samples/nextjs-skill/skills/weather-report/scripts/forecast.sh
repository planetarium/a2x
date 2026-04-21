#!/usr/bin/env bash
# Deterministic stub forecast — the actual report generation is the LLM's job;
# this script exists to exercise run_skill_script end-to-end without requiring
# a real weather API.

set -euo pipefail

city="${1:-unknown}"

# Derive a stable pseudo-temperature from the city name so that repeated runs
# produce the same output — useful for demos.
hash=$(printf '%s' "$city" | cksum | awk '{print $1}')
temp=$(( 5 + hash % 25 ))
low=$(( temp - 5 ))
high=$(( temp + 4 ))

case $(( hash % 5 )) in
  0) condition="clear" ;;
  1) condition="partly cloudy" ;;
  2) condition="cloudy" ;;
  3) condition="rainy" ;;
  *) condition="snowy" ;;
esac

case $(( hash % 4 )) in
  0) wind_dir="north" ;;
  1) wind_dir="south" ;;
  2) wind_dir="east" ;;
  *) wind_dir="west" ;;
esac

cat <<JSON
{
  "city": "$city",
  "temp_c": $temp,
  "low_c": $low,
  "high_c": $high,
  "condition": "$condition",
  "wind_dir": "$wind_dir",
  "wind_kph": $(( 5 + hash % 20 ))
}
JSON
