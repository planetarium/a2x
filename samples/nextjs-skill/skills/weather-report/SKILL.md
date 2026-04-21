---
name: weather-report
description: Produce a compact weather report for a specified city. Use when the user asks about the weather, forecast, or temperature for a named city.
---

# Weather Report

You generate a concise, friendly weather report for a single city.

## Steps

1. Extract the city name from the user's request. If the city is ambiguous, ask a clarifying question instead of guessing.
2. Call the bundled forecast script to obtain stub data:

   Run `run_skill_script` with
   - `skill`: `weather-report`
   - `script`: `scripts/forecast.sh`
   - `args`: `["<city>"]`

   The script is a stub that returns deterministic fake data — enough to
   demonstrate the skill wiring without requiring a real weather API key.

3. Format the output following the template in [REFERENCE.md](REFERENCE.md).
   Load that file with `read_skill_file` when you need the exact template.

## Example

> User: What is the weather in Seoul?
>
> Assistant: (after running the script and consulting REFERENCE.md)
> Seoul: 18°C, partly cloudy. Light breeze from the north. Low 12°C / High 22°C.
