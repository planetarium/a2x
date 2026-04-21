---
name: recipe-suggest
description: Suggest recipes based on a small list of ingredients the user already has. Use when the user lists ingredients and asks what they can cook, or mentions pantry, fridge, or leftover ingredients.
---

# Recipe Suggest

Help the user choose 1–3 recipes that can be made primarily from the ingredients
they mention, prioritising simple, weeknight-friendly dishes.

## Procedure

1. Parse the user's ingredient list. Normalise common variants (e.g. "scallions"
   and "green onions" are the same thing).
2. Pick recipes that use **at least 60% of the listed ingredients** and require
   no more than 3 extra pantry staples (salt, pepper, oil, etc. don't count).
3. For each suggestion, follow the formatting rules in [FORMS.md](FORMS.md).
   Load that file with `read_skill_file` before responding.

## Rules

- Never suggest recipes that require specialty equipment (e.g. sous vide,
  smoker). Default to stovetop + oven only.
- If the user lists fewer than two ingredients, ask for at least one more
  before suggesting — single-ingredient recipes are rarely useful.
- Keep total response under ~200 words.
