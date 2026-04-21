# Recipe Suggestion Format

For each suggested recipe, emit a block in this exact shape:

```
### {Recipe Name}

- **Uses:** {comma-separated user ingredients it consumes}
- **Also needs:** {comma-separated pantry additions, or "nothing extra"}
- **Time:** ~{minutes} min
- **Steps:**
  1. {step one}
  2. {step two}
  3. {step three, no more than 5 steps total}
```

Separate multiple recipes with a blank line. Do NOT add preamble like "Here are
some suggestions" — lead straight into the first recipe block.

## Example

```
### Garlic Fried Rice

- **Uses:** rice, garlic, eggs
- **Also needs:** soy sauce
- **Time:** ~15 min
- **Steps:**
  1. Mince garlic and fry until golden in a tablespoon of oil.
  2. Push garlic aside, scramble two eggs, then stir in rice.
  3. Season with soy sauce to taste and serve.
```
