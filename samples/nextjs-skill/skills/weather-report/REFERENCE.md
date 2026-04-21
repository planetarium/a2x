# Weather Report Output Template

Always respond in this exact single-line format:

```
{CITY}: {TEMP_C}°C, {CONDITION}. {WIND_DESCRIPTION}. Low {LOW_C}°C / High {HIGH_C}°C.
```

## Fields

- `CITY` — canonical name with capitalized first letter.
- `TEMP_C` — current temperature, integer.
- `CONDITION` — one of: `clear`, `partly cloudy`, `cloudy`, `rainy`, `snowy`.
- `WIND_DESCRIPTION` — short phrase such as "calm", "light breeze from the north",
  or "strong gusts from the west". Infer direction from the script's `wind_dir` field.
- `LOW_C` / `HIGH_C` — integer low/high forecast temperatures.

## Localization

If the user wrote their request in a non-English language, mirror that language in
the response. The field order must remain the same.
