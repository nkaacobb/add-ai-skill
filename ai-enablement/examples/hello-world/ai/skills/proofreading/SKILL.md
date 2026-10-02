---
name: proofreading
description: Proofread the document in the editor - spelling, grammar, punctuation and consistency - list every fix, and apply the ones the user accepts with the editor's own find-and-replace. Use when the user asks to proofread, check, correct or fix the spelling or grammar of the text.
allowed-tools: find_text replace_text get_selection
metadata:
  app: hello-world
---

# Proofreading

1. **Scope.** If the view state has a selection and the user says "this part", proofread only the selection
   (`get_selection` gives its exact text). Otherwise the whole document from the page snapshot.
2. **Check** the text against [the checklist](references/checklist.md) (read it with `read_skill_file` the first
   time). Respect the user's own preferences from memory (for example British or American spelling).
3. **List every fix** before changing anything, one line each:
   `original → corrected — reason` (reason in a few words: "spelling", "subject–verb agreement", "missing comma").
   Group repeated fixes ("teh → the — spelling, 3 times"). Say plainly when there is nothing to fix.
4. **Apply** only when the user asks ("fix them", "apply all", "only the spelling ones"):
   - one `replace_text` call per distinct fix, with `matchCase: true` and enough surrounding words in `find` to
     match only the intended place (for example `"Their wher"` rather than `"wher"`);
   - set `all: false` when the same words appear elsewhere correctly.
   The user confirms each change; if they decline one, skip it and go on.
5. **Check** with `find_text` that the old wording is gone, then report in one or two lines what changed (the user
   can undo with Ctrl+Z).

Never rewrite style or meaning while proofreading: offer that separately.
